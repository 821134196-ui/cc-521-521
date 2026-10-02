"""HTTP 端到端：真实启动 ThreadingHTTPServer，走 JSON API 全流程。"""
import base64
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hotel_beds.server import make_server


def _request(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


# 1x1 透明 PNG
PNG_1PX = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000154a24f7d0000000049454e44ae426082"
)).decode()


class ApiFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        db = str(Path(cls.tmp.name) / "api.db")
        photos = str(Path(cls.tmp.name) / "photos")
        cls.httpd = make_server("127.0.0.1", 0, db, photos)
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def test_full_flow_over_http(self):
        B = self.base
        # 超员样例：801 加 1 床 → 400 OVER_OCCUPANCY
        code, data = _request(B + "/api/requests", "POST",
                              {"room_no": "801", "guests_to_add": 1, "ends_on": "2026-10-05"})
        self.assertEqual(code, 400)
        self.assertEqual(data["code"], "OVER_OCCUPANCY")

        # 合法申请 810 加 1 床
        code, data = _request(B + "/api/requests", "POST",
                              {"room_no": "810", "guests_to_add": 1, "ends_on": "2026-10-06"})
        self.assertEqual(code, 201)
        rid = data["request_id"]

        # 派单
        code, data = _request(B + f"/api/requests/{rid}/assign", "POST", {})
        self.assertEqual(code, 201)
        did = data["delivery_id"]

        # 双认领：两个并发 POST，只有一个 200
        results = []

        def claim(who):
            results.append(_request(B + f"/api/deliveries/{did}/claim",
                                    "POST", {"attendant": who})[0])

        threads = [threading.Thread(target=claim, args=(w,)) for w in ("小张", "小王")]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(sorted(results), [200, 400])

        # 送达 + 照片 + 确认
        code, _ = _request(B + f"/api/deliveries/{did}/delivered", "POST",
                           {"delivered_on": "2026-10-02"})
        self.assertEqual(code, 200)
        code, data = _request(B + f"/api/deliveries/{did}/photos", "POST", {
            "stage": "delivery", "data": PNG_1PX, "format": "png", "note": "验收"})
        self.assertEqual(code, 201)
        code, data = _request(B + f"/api/deliveries/{did}/confirm", "POST", {})
        self.assertEqual(code, 200)
        self.assertEqual(data["nights"], 4)
        self.assertEqual(data["amount_cents"], 72000)

        # 房态含已加床数量
        code, data = _request(B + "/api/rooms")
        room810 = next(r for r in data["rooms"] if r["room_no"] == "810")
        self.assertEqual(room810["extra_beds"], 1)

        # 退房逐件回收（全完好）
        code, det = _request(B + f"/api/deliveries/{did}")
        items = [{"kind": "frame", "id": det["frames"][0]["id"], "state": "ok", "note": ""}]
        for l in det["linens"]:
            items.append({"kind": l["item_type"], "id": l["id"], "state": "ok", "note": ""})
        code, data = _request(B + f"/api/deliveries/{did}/recover", "POST", {"items": items})
        self.assertEqual(code, 200)

        # 照片可取回
        code, det2 = _request(B + f"/api/deliveries/{did}")
        photo_path = det2["photos"][0]["rel_path"]
        with urllib.request.urlopen(B + "/photos/" + photo_path, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read()[:4], b"\x89PNG")

        # 房账余额 = 4 晚房费
        code, bill = _request(B + "/api/rooms/810/billing")
        self.assertEqual(bill["balance_cents"], 72000)

    def test_missing_item_blocked_over_http(self):
        B = self.base
        code, data = _request(B + "/api/requests", "POST",
                              {"room_no": "820", "guests_to_add": 2, "ends_on": "2026-10-06"})
        rid = data["request_id"]
        _, data = _request(B + f"/api/requests/{rid}/assign", "POST", {})
        did = data["delivery_id"]
        _request(B + f"/api/deliveries/{did}/claim", "POST", {"attendant": "小赵"})
        _request(B + f"/api/deliveries/{did}/delivered", "POST", {"delivered_on": "2026-10-02"})
        _request(B + f"/api/deliveries/{did}/confirm", "POST", {})

        _, det = _request(B + f"/api/deliveries/{did}")
        # 只核对床架、漏收全部布草 → 400
        items = [{"kind": "frame", "id": f["id"], "state": "ok", "note": ""}
                 for f in det["frames"]]
        code, data = _request(B + f"/api/deliveries/{did}/recover", "POST", {"items": items})
        self.assertEqual(code, 400)
        self.assertEqual(data["code"], "ITEMS_UNCHECKED")


if __name__ == "__main__":
    unittest.main()
