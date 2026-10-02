"""HTTP 服务：JSON API + 静态页面 + 本地照片，全部基于标准库。

每个请求从连接池取一个 SQLite 连接；ThreadingHTTPServer 多线程，
写事务使用 BEGIN IMMEDIATE 串行化，配合行级条件 UPDATE 实现竞争安全。
"""
from __future__ import annotations

import base64
import json
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import photos as photos_mod
from .billing import SimulatedBillingAdapter
from .db import connect, init_db
from .errors import BusinessError, NotFound, PermissionDenied
from .seed import seed
from .service import HotelService

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
}


class App:
    def __init__(self, db_path: str, photos_dir: str):
        self.db_path = db_path
        self.photos_dir = Path(photos_dir)
        self.photos_dir.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self.billing = SimulatedBillingAdapter()
        # 初始化（首次运行建表并种子）
        conn = self._new_conn()
        init_db(conn)
        seed(conn)
        conn.close()

    def _new_conn(self):
        conn = connect(self.db_path)
        init_db(conn)
        return conn

    @property
    def conn(self):
        if getattr(self._local, "conn", None) is None:
            self._local.conn = self._new_conn()
        return self._local.conn

    def service(self) -> HotelService:
        return HotelService(self.conn, self.billing)


def json_dumps(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    app: App = None  # 由 make_server 注入

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ------------------------------------------------------------- 基础响应

    def _send_json(self, obj, status: int = 200):
        body = json_dumps(obj)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, path: Path):
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        ctype = STATIC_TYPES.get(path.suffix, "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise BusinessError("请求体不是合法 JSON", "BAD_INPUT")
        if not isinstance(data, dict):
            raise BusinessError("请求体必须是 JSON 对象", "BAD_INPUT")
        return data

    def _handle_errors(self, fn):
        try:
            fn()
        except BusinessError as e:
            self._send_json({"error": e.message, "code": e.code}, 400)
        except PermissionDenied as e:
            self._send_json({"error": str(e), "code": "FORBIDDEN"}, 403)
        except NotFound as e:
            self._send_json({"error": str(e), "code": "NOT_FOUND"}, 404)
        except (ValueError, KeyError) as e:
            self._send_json({"error": f"参数错误：{e}", "code": "BAD_INPUT"}, 400)

    # --------------------------------------------------------------- 路由

    def do_GET(self):
        self._handle_errors(self._do_get)

    def do_POST(self):
        self._handle_errors(self._do_post)

    def _do_get(self):
        parsed = urlparse(self.path)
        path = parsed.path
        svc = self.app.service()

        if path.startswith("/api/"):
            if path == "/api/rooms":
                return self._send_json({"rooms": svc.list_rooms()})
            if path == "/api/requests":
                return self._send_json({"requests": svc.list_requests()})
            if path == "/api/deliveries":
                return self._send_json({"deliveries": svc.list_deliveries()})
            if path == "/api/inventory":
                return self._send_json({"summary": svc.inventory_summary()})
            if path.startswith("/api/deliveries/"):
                did = int(path.rsplit("/", 1)[-1])
                return self._send_json(svc.delivery_detail(did))
            if path.startswith("/api/rooms/") and path.endswith("/billing"):
                room_no = path.split("/")[3]
                return self._send_json(svc.room_billing(room_no))
            return self._send_json({"error": "未知接口", "code": "NOT_FOUND"}, 404)

        if path.startswith("/photos/"):
            name = path.split("/", 2)[2]
            try:
                return self._send_static(photos_mod.resolve(self.app.photos_dir, name))
            except ValueError:
                return self._send_json({"error": "非法路径"}, 400)

        # 静态页面
        if path == "/":
            return self._send_static(WEB_DIR / "index.html")
        static_path = (WEB_DIR / path.lstrip("/")).resolve()
        if WEB_DIR.resolve() not in static_path.parents and static_path != WEB_DIR.resolve():
            return self._send_json({"error": "非法路径"}, 400)
        return self._send_static(static_path)

    def _do_post(self):
        path = urlparse(self.path).path
        body = self._read_json()
        svc = self.app.service()

        # 申请
        if path == "/api/requests":
            rid = svc.submit_request(
                room_no=body["room_no"],
                guests_to_add=int(body["guests_to_add"]),
                ends_on=body["ends_on"],
                operator=body.get("operator", "前台"),
            )
            return self._send_json({"ok": True, "request_id": rid}, 201)

        if path.endswith("/reject"):
            rid = int(path.split("/")[3])
            svc.reject_request(rid, body.get("reason", ""), operator=body.get("operator", "前台"))
            return self._send_json({"ok": True})

        if path.endswith("/quote"):
            rid = int(path.split("/")[3])
            svc.adjust_quote(
                rid, int(body["new_rate_cents"]),
                role=body.get("role", "front_desk"),
                operator=body.get("operator", "前台"),
            )
            return self._send_json({"ok": True})

        if path.endswith("/assign"):
            rid = int(path.split("/")[3])
            did = svc.assign_delivery(rid)
            return self._send_json({"ok": True, "delivery_id": did}, 201)

        if path.endswith("/extend"):
            rid = int(path.split("/")[3])
            res = svc.extend_stay(rid, body["new_ends_on"], operator=body.get("operator", "前台"))
            return self._send_json({"ok": True, **res})

        # 配送单
        if path.endswith("/claim"):
            did = int(path.split("/")[3])
            svc.claim_delivery(did, body.get("attendant", "房务员"))
            return self._send_json({"ok": True})

        if path.endswith("/delivered"):
            did = int(path.split("/")[3])
            svc.mark_delivered(did, delivered_on=body.get("delivered_on"))
            return self._send_json({"ok": True})

        if path.endswith("/replace-item"):
            did = int(path.split("/")[3])
            res = svc.replace_damaged_item(did, body["sku"], body.get("note", "配送前发现损坏"))
            return self._send_json({"ok": True, **res})

        if path.endswith("/confirm"):
            did = int(path.split("/")[3])
            res = svc.guest_confirm(did, ends_on=body.get("ends_on"))
            return self._send_json({"ok": True, **res})

        if path.endswith("/early-remove"):
            did = int(path.split("/")[3])
            res = svc.early_remove(did, removed_on=body.get("removed_on"))
            return self._send_json({"ok": True, **res})

        if path.endswith("/recover"):
            did = int(path.split("/")[3])
            charges = svc.recover_and_settle(
                did, body["items"], role=body.get("role", "front_desk")
            )
            return self._send_json({"ok": True, "charges": charges})

        if path.endswith("/photos"):
            did = int(path.split("/")[3])
            suffix = ".jpg" if body.get("encoding", "base64") == "base64" else ".jpg"
            suffix = "." + body.get("format", "jpg").lstrip(".").lower()
            data = base64.b64decode(body["data"])
            rel = photos_mod.save_photo(
                self.app.photos_dir, did, body["stage"], data, suffix
            )
            svc.add_photo(did, body["stage"], rel, body.get("note"))
            return self._send_json({"ok": True, "path": rel}, 201)

        # 库存 / 房账
        if path == "/api/inventory/damage":
            svc.mark_storage_damaged(body["sku"], body.get("note", "床架损坏隔离"))
            return self._send_json({"ok": True})

        if path == "/api/ledger/waive":
            svc.waive_charge(
                int(body["entry_id"]),
                role=body.get("role", "front_desk"),
                operator=body.get("operator", "前台"),
                reason=body.get("reason", ""),
            )
            return self._send_json({"ok": True})

        return self._send_json({"error": "未知接口", "code": "NOT_FOUND"}, 404)


def make_server(host: str, port: int, db_path: str, photos_dir: str) -> ThreadingHTTPServer:
    app = App(db_path, photos_dir)
    Handler.app = app
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.app = app
    return httpd
