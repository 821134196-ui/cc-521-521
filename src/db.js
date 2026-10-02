'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 房型：消防核准人数、空间允许加床数、每晚加床费（整数元）
CREATE TABLE IF NOT EXISTS room_types (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  fire_capacity  INTEGER NOT NULL,   -- 消防核准人数上限
  max_extra_beds INTEGER NOT NULL,   -- 房间空间允许的最大加床数
  nightly_fee    INTEGER NOT NULL    -- 每张加床每晚报价（元）
);

CREATE TABLE IF NOT EXISTS rooms (
  id                INTEGER PRIMARY KEY,
  room_no           TEXT NOT NULL UNIQUE,
  type_code         TEXT NOT NULL REFERENCES room_types(code),
  guest_name        TEXT,
  registered_guests INTEGER NOT NULL DEFAULT 0, -- 已登记入住人数
  status            TEXT NOT NULL DEFAULT 'vacant' -- occupied | vacant
);

-- 员工：房务员 / 前台
CREATE TABLE IF NOT EXISTS staff (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  role  TEXT NOT NULL CHECK (role IN ('attendant','front_desk'))
);

-- 加床申请（含被拒申请，保留原报价）
CREATE TABLE IF NOT EXISTS applications (
  id             INTEGER PRIMARY KEY,
  room_id        INTEGER NOT NULL REFERENCES rooms(id),
  beds           INTEGER NOT NULL,
  planned_nights INTEGER NOT NULL,
  quoted_nightly INTEGER NOT NULL,           -- 申请时的原报价（每晚）
  quoted_total   INTEGER NOT NULL,           -- 原报价合计
  status         TEXT NOT NULL,              -- approved | rejected
  reject_code    TEXT,                       -- occupancy | space | stock
  reject_reason  TEXT,
  operator       TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 配送单
CREATE TABLE IF NOT EXISTS delivery_orders (
  id            INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  room_id       INTEGER NOT NULL REFERENCES rooms(id),
  beds          INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('dispatched','claimed','delivered','confirmed','settled')),
  claimed_by    TEXT REFERENCES staff(id),   -- 两名房务员抢单，只能写入一次
  dispatched_at TEXT NOT NULL,
  claimed_at    TEXT,
  delivered_at  TEXT,
  confirmed_at  TEXT,
  settled_at    TEXT,
  end_kind      TEXT,                        -- early_remove | checkout
  accept_photo  TEXT
);

-- 资产：床架 / 被褥 / 枕头，逐件编号
CREATE TABLE IF NOT EXISTS assets (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('frame','bedding','pillow')),
  status           TEXT NOT NULL CHECK (status IN
                     ('available','lent','damaged','missing','retired')),
  current_order_id INTEGER REFERENCES delivery_orders(id)
);
-- 资产不重叠的保证：一件资产只有一个 current_order_id，
-- 借出时以原子 UPDATE ... WHERE status='available' 抢占（见 store.js）。

-- 配送单借出名细（床架与布草分项）
CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES delivery_orders(id),
  asset_id         INTEGER NOT NULL REFERENCES assets(id),
  kind             TEXT NOT NULL,
  asset_code       TEXT NOT NULL,
  recover_condition TEXT,                     -- ok | damaged | missing
  recover_reason   TEXT,
  recover_photo    TEXT,
  returned_at      TEXT
);

-- 结算单：原报价保留，减免/调整留痕
CREATE TABLE IF NOT EXISTS settlements (
  id                   INTEGER PRIMARY KEY,
  order_id             INTEGER NOT NULL REFERENCES delivery_orders(id),
  nights               INTEGER NOT NULL,
  bed_fee              INTEGER NOT NULL,      -- 实际床位费（含跨夜）
  damage_fee           INTEGER NOT NULL,      -- 床架损坏赔偿
  linen_fee            INTEGER NOT NULL,      -- 漏收/遗失布草赔偿
  standard_total       INTEGER NOT NULL,      -- 床位+赔偿标准合计
  waiver_amount        INTEGER NOT NULL DEFAULT 0,
  waiver_note          TEXT,
  adjusted_total       INTEGER,               -- 前台手工调价后金额（可空）
  adjust_note          TEXT,
  original_quote_total INTEGER NOT NULL,      -- 申请时原报价合计（不可改）
  operator             TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

-- 模拟房账适配器落地表（真实 PMS 适配器可替换同接口实现）
CREATE TABLE IF NOT EXISTS folio_entries (
  id         INTEGER PRIMARY KEY,
  room_id    INTEGER NOT NULL,
  order_id   INTEGER REFERENCES delivery_orders(id),
  category   TEXT NOT NULL,   -- bed | damage | linen | waiver | adjust
  label      TEXT NOT NULL,
  amount     INTEGER NOT NULL, -- 正为入账，负为冲减
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_room_status ON delivery_orders(room_id, status);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_folio_room ON folio_entries(room_id);
`;

function getDB(file) {
  let db;
  if (file === ':memory:') {
    db = new DatabaseSync(':memory:');
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
  }
  db.exec(SCHEMA);
  return db;
}

module.exports = { getDB, SCHEMA };
