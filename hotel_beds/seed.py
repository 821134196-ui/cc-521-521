"""初始化演示数据：房型规则、库存、在住房间，并附一个超员样例。"""
from __future__ import annotations

import sqlite3

from .db import connect, init_db

ROOM_TYPES = [
    # code,        名称,       消防核准, 床位空间, 每床每晚(分)
    ("STD", "标准间", 2, 1, 12000),
    ("DLX", "豪华大床房", 3, 1, 15000),
    ("FAM", "家庭套房", 5, 2, 18000),
    ("EXE", "行政套房", 4, 2, 20000),
]

# (sku 前缀, 类型, 数量)
INVENTORY_PLAN = [
    ("FR", "frame", 6),
    ("BD", "bedding", 8),
    ("PL", "pillow", 8),
]

# 房间：房号, 房型, 已登记人数
ROOMS = [
    ("801", "STD", 2),
    ("802", "DLX", 2),
    ("810", "FAM", 4),
    ("812", "FAM", 3),
    ("820", "FAM", 2),   # 低入住率：2/5 人，用于演示"空间先于人数超限"
    ("901", "EXE", 2),
]


def seed(conn: sqlite3.Connection, *, include_overbook_demo: bool = True) -> dict:
    """写入基础数据。返回演示信息（含超员样例房号）。"""
    conn.execute("BEGIN IMMEDIATE")
    try:
        for code, name, cap, space, price in ROOM_TYPES:
            conn.execute(
                """INSERT INTO room_types (code,name,fire_capacity,bed_space,price_cents)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(code) DO NOTHING""",
                (code, name, cap, space, price),
            )

        for prefix, itype, qty in INVENTORY_PLAN:
            for i in range(1, qty + 1):
                sku = f"{prefix}-{i:03d}"
                conn.execute(
                    """INSERT INTO inventory_items (item_type, sku) VALUES (?,?)
                       ON CONFLICT(sku) DO NOTHING""",
                    (itype, sku),
                )

        for room_no, type_code, guests in ROOMS:
            conn.execute(
                """INSERT INTO rooms (room_no, type_code, base_guests)
                   VALUES (?,?,?)
                   ON CONFLICT(room_no) DO NOTHING""",
                (room_no, type_code, guests),
            )

        # 超员样例：801 标准间核准 2 人、已住 2 人，申请加 1 床被前台驳回
        exists = conn.execute(
            "SELECT 1 FROM requests WHERE room_no='801' AND status='rejected'"
        ).fetchone()
        if not exists:
            conn.execute(
                """INSERT INTO requests
                       (room_no, guests_to_add, status, reject_reason,
                        quoted_cents, list_price_cents, ends_on, decided_at)
                   VALUES ('801', 1, 'rejected',
                           '入住人数超限：标准间消防核准 2 人，当前已住 2 人，不可加床',
                           12000, 12000, DATE('now','localtime','+1 day'),
                           datetime('now','localtime'))"""
            )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    demo = {}
    if include_overbook_demo:
        # 超员样例：801 标准间已住 2 人（=消防核准），再申请 1 张床必被拒
        # 直接造一笔被前台尝试提交的记录由 API/演示脚本调用；这里仅给出参数。
        demo["overbook_room"] = "801"
        demo["overbook_guests_to_add"] = 1
    return demo


def reset_and_seed(db_path: str) -> dict:
    """删库重建（仅用于本地一键演示）。"""
    from pathlib import Path

    p = Path(db_path)
    for suffix in ("", "-wal", "-shm"):
        f = Path(str(p) + suffix)
        if f.exists():
            f.unlink()
    conn = connect(db_path)
    init_db(conn)
    demo = seed(conn)
    conn.close()
    return demo
