#!/usr/bin/env python3
"""一条本地命令启动酒店加床管理系统。

用法：
    python3 run.py                # 启动服务（默认 http://127.0.0.1:8000）
    python3 run.py --reset        # 清空并重建演示数据后启动
    python3 run.py --port 9000

启动时会演示一次「超员样例」：801 标准间已住满 2 人，再申请加床会被拒绝。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from hotel_beds.db import connect, init_db
from hotel_beds.errors import BusinessError
from hotel_beds.seed import reset_and_seed, seed
from hotel_beds.server import make_server
from hotel_beds.service import HotelService

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "hotel.db"
PHOTOS_DIR = DATA_DIR / "photos"


def demo_overbook(db_path: Path) -> None:
    """启动时跑一次超员申请，展示容量规则生效（不影响数据库：失败即回滚）。"""
    conn = connect(db_path)
    svc = HotelService(conn)
    try:
        svc.submit_request(room_no="801", guests_to_add=1, ends_on="2026-10-05")
        print("[超员样例] 意外：801 房加床申请竟然通过了？！")
    except BusinessError as e:
        print(f"[超员样例] 801 标准间申请加 1 张床被拒绝：{e.message}")
    finally:
        conn.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="酒店加床管理系统")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reset", action="store_true", help="清空并重建演示数据")
    args = parser.parse_args(argv)

    try:  # 让重定向到日志文件时启动信息也能即时显示
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    DATA_DIR.mkdir(exist_ok=True)
    if args.reset:
        print(f"[初始化] 重建演示数据库：{DB_PATH}")
        reset_and_seed(str(DB_PATH))
    else:
        conn = connect(DB_PATH)
        init_db(conn)
        seed(conn)
        conn.close()

    demo_overbook(DB_PATH)

    httpd = make_server(args.host, args.port, str(DB_PATH), str(PHOTOS_DIR))
    print("=" * 60)
    print(" 酒店加床管理系统已启动")
    print(f"   房态总览：  http://{args.host}:{args.port}/")
    print(f"   配送派单：  http://{args.host}:{args.port}/delivery.html")
    print(f"   退房结算：  http://{args.host}:{args.port}/checkout.html")
    print(" 按 Ctrl+C 停止")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[退出] 已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
