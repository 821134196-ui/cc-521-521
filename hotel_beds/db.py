"""SQLite 连接与表结构。

资源占用（床架、布草）都以行级状态记录在 SQLite 中；
关键分配/认领操作通过事务 + 原子 UPDATE ... WHERE 保证不重叠、不重复成功。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
PRAGMA foreign_keys = ON;

-- 房型规则：消防核准人数、房间可用空间（可放折叠床数量）、每床每晚报价（分）
CREATE TABLE IF NOT EXISTS room_types (
    code          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    fire_capacity INTEGER NOT NULL,   -- 消防核准总人数（含加床后）
    bed_space     INTEGER NOT NULL,   -- 房间最多可放折叠床数（空间限制）
    price_cents   INTEGER NOT NULL    -- 每床每晚挂牌价
);

-- 房间
CREATE TABLE IF NOT EXISTS rooms (
    room_no       TEXT PRIMARY KEY,
    type_code     TEXT NOT NULL REFERENCES room_types(code),
    base_guests   INTEGER NOT NULL,   -- 当前登记入住人数（不含加床带来的新增）
    status        TEXT NOT NULL DEFAULT 'occupied'
                  CHECK (status IN ('occupied','checkout_due'))
);

-- 布草/床架库存台账（每一件一行）
CREATE TABLE IF NOT EXISTS inventory_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type   TEXT NOT NULL CHECK (item_type IN ('frame','bedding','pillow')),
    sku         TEXT NOT NULL UNIQUE,
    condition   TEXT NOT NULL DEFAULT 'ok' CHECK (condition IN ('ok','damaged')),
    status      TEXT NOT NULL DEFAULT 'available'
                CHECK (status IN ('available','in_use','retired'))
);
CREATE INDEX IF NOT EXISTS idx_inv_type_status ON inventory_items(item_type, status);

-- 加床申请
CREATE TABLE IF NOT EXISTS requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    room_no         TEXT NOT NULL REFERENCES rooms(room_no),
    guests_to_add   INTEGER NOT NULL CHECK (guests_to_add > 0),
    status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','rejected','assigned','delivered',
                                      'confirmed','early_removed','checked_out')),
    reject_reason   TEXT,
    quoted_cents    INTEGER,          -- 前台最终给客人的报价（分），确认后锁定
    list_price_cents INTEGER,         -- 挂牌价快照，调整价格时保留原报价依据
    delivered_on    TEXT,             -- 实际送达日期（跨夜计费起点）
    ends_on         TEXT,             -- 确认时约定的退房日期
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    decided_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_room ON requests(room_no);

-- 配送单：一张申请一张配送单
CREATE TABLE IF NOT EXISTS deliveries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id      INTEGER NOT NULL UNIQUE REFERENCES requests(id),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','delivered','recovered')),
    claimed_by      TEXT,             -- 房务员
    claimed_at      TEXT,
    delivered_at    TEXT,
    recovered_at    TEXT
);

-- 床架分配（床架不可重叠：同一床架同时只能出现在一个活动分配里，由应用层原子认领保证）
CREATE TABLE IF NOT EXISTS frame_allocations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id  INTEGER NOT NULL REFERENCES deliveries(id),
    frame_sku    TEXT NOT NULL REFERENCES inventory_items(sku),
    status       TEXT NOT NULL DEFAULT 'allocated'
                 CHECK (status IN ('allocated','recovered')),
    return_state TEXT CHECK (return_state IN ('ok','damaged','missing')),
    note         TEXT,
    allocated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    recovered_at TEXT
);

-- 布草借出/回收逐件记录（被褥、枕头）
CREATE TABLE IF NOT EXISTS linen_loans (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id  INTEGER NOT NULL REFERENCES deliveries(id),
    item_sku     TEXT NOT NULL REFERENCES inventory_items(sku),
    item_type    TEXT NOT NULL CHECK (item_type IN ('bedding','pillow')),
    loaned_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    returned_at  TEXT,
    return_state TEXT CHECK (return_state IN ('ok','damaged','missing')),
    note         TEXT
);

-- 验收照片（文件存在本地 photos/ 目录，这里只存路径）
CREATE TABLE IF NOT EXISTS inspection_photos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id  INTEGER NOT NULL REFERENCES deliveries(id),
    stage        TEXT NOT NULL CHECK (stage IN ('delivery','recovery')),
    rel_path     TEXT NOT NULL,
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 报价调整记录：调整价格必须保留原报价
CREATE TABLE IF NOT EXISTS quote_adjustments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id       INTEGER NOT NULL REFERENCES requests(id),
    from_cents       INTEGER NOT NULL,
    to_cents         INTEGER NOT NULL,
    changed_by       TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 房账流水（模拟适配器写入；金额为分，正数=向客人收费）
CREATE TABLE IF NOT EXISTS ledger_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    room_no      TEXT NOT NULL,
    request_id   INTEGER REFERENCES requests(id),
    kind         TEXT NOT NULL
                 CHECK (kind IN ('nightly','damage','missing','early_pickup','adjustment')),
    amount_cents INTEGER NOT NULL,
    detail       TEXT NOT NULL,
    nights       INTEGER,
    ref          TEXT,
    posted_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_room ON ledger_entries(room_no);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
