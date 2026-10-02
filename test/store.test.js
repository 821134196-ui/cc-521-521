'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getDB } = require('../src/db');
const { Store, FEES, LOST_FEE, DAMAGE_FEE } = require('../src/store');
const { mockFolio } = require('../src/folio');

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();

// 构造最小可控数据集：
// 房型 T1：消防 2 人、空间 1 张、100/床·晚
// 房间 R1/R2 各住 1 人（可各加 1 张）；R3 住满 2 人（超员样例）
// 资产默认仅 1 张床架（便于制造库存瓶颈），被褥/枕头各 2
function setup() {
  const db = getDB(':memory:');
  db.exec(`
    INSERT INTO room_types (code,name,fire_capacity,max_extra_beds,nightly_fee)
    VALUES ('T1','测试房',2,1,100);
    INSERT INTO rooms (room_no,type_code,guest_name,registered_guests,status) VALUES
      ('101','T1','客甲',1,'occupied'),
      ('102','T1','客乙',1,'occupied'),
      ('103','T1','客丙',2,'occupied');
    INSERT INTO staff (id,name,role) VALUES
      ('FD','前台','front_desk'), ('A1','房务甲','attendant'), ('A2','房务乙','attendant');
    INSERT INTO assets (code,kind,status) VALUES
      ('F1','frame','available'),
      ('B1','bedding','available'),('B2','bedding','available'),
      ('P1','pillow','available'),('P2','pillow','available');
  `);
  return { db, store: new Store(db, mockFolio) };
}

const rid = (db, no) => db.prepare('SELECT id FROM rooms WHERE room_no=?').get(no).id;

// 完整走单：申请→派单→抢单→送达→住客确认。t0 为确认时刻。
function flow(store, db, roomNo, { beds = 1, nights = 2, claimant = 'A1', t0 = Date.parse('2026-10-01T14:00:00Z') } = {}) {
  const roomId = rid(db, roomNo);
  const app = store.applyForBed({ room_id: roomId, beds, planned_nights: nights, operator: 'FD' }, new Date(t0 - DAY));
  assert.equal(app.ok, true, '申请应通过');
  const order = store.dispatch(app.application_id, new Date(t0 - DAY + 1000));
  const claim = store.claimOrder(order.id, claimant);
  assert.equal(claim.ok, true);
  store.markDelivered(order.id, null, new Date(t0));
  store.guestConfirm(order.id, new Date(t0));
  return store.getOrder(order.id);
}

// 构造逐件回收结果
function resultsFor(order, overrides = {}) {
  return order.items.map((it) => overrides[it.kind] || { item_id: it.id, condition: 'ok', reason: '' });
}

// ---------- 容量限制 ----------
test('容量：入住人数超过消防核准 → rejected occupancy 且保留原报价', () => {
  const { db, store } = setup();
  const r = store.applyForBed({ room_id: rid(db, '103'), beds: 1, planned_nights: 2, operator: 'FD' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reject_code, 'occupancy');
  assert.equal(r.quoted_total, 200); // 原报价仍记录
});

test('容量：房间空间不足 → rejected space', () => {
  const { db, store } = setup();
  flow(store, db, '101'); // 已占唯一加床位与唯一床架
  // 再为 102 申请会先撞库存；为单独验证 space，临时补一张床架但 101 空间已满
  db.exec("INSERT INTO assets (code,kind,status) VALUES ('F2','frame','available'),('B3','bedding','available'),('P3','pillow','available')");
  // 101 已加 1 张（max=1），对 101 再申请 → space
  const r = store.applyForBed({ room_id: rid(db, '101'), beds: 1, planned_nights: 1, operator: 'FD' });
  assert.equal(r.reject_code, 'space');
});

test('容量：折叠床库存不足 → rejected stock', () => {
  const { db, store } = setup();
  flow(store, db, '101'); // 唯一 F1 被借
  const r = store.applyForBed({ room_id: rid(db, '102'), beds: 1, planned_nights: 2, operator: 'FD' });
  assert.equal(r.ok, false);
  assert.equal(r.reject_code, 'stock');
});

// ---------- 库存竞争 / 床架不可重叠 ----------
test('库存竞争：床架分配不可重叠，第二张派单失败且资产不串单', () => {
  const { db, store } = setup();
  const o1 = flow(store, db, '101');
  const f1 = db.prepare("SELECT * FROM assets WHERE code='F1'").get();
  assert.equal(f1.status, 'lent');
  assert.equal(f1.current_order_id, o1.id);

  // 102 通过申请（申请时可能因库存被拒）。先补布草瓶颈外的条件：这里 frame 已无，直接派单应 409。
  const app2 = store.applyForBed({ room_id: rid(db, '102'), beds: 1, planned_nights: 2, operator: 'FD' });
  assert.equal(app2.status, 'rejected'); // 库存已为 0，申请阶段即拒
  assert.equal(app2.reject_code, 'stock');

  // 即使存在一张被并发占用的床，派单事务复查库存也会失败：
  db.exec("INSERT INTO assets (code,kind,status) VALUES ('F2','frame','available')");
  const app3 = store.applyForBed({ room_id: rid(db, '102'), beds: 1, planned_nights: 2, operator: 'FD' });
  assert.equal(app3.ok, true);
  // 人为把 F2 在派单前抢占，模拟并发竞争 → dispatch 复查/原子更新
  db.prepare("UPDATE assets SET status='lent', current_order_id=? WHERE code='F2'").run(o1.id);
  assert.throws(() => store.dispatch(app3.application_id), /库存不足|冲突/);
  // F1 仍只属于 o1，未被重叠分配
  assert.equal(db.prepare("SELECT current_order_id FROM assets WHERE code='F1'").get().current_order_id, o1.id);
});

test('抢单：两名房务员同时认领只成功一次', () => {
  const { db, store } = setup();
  const order = store.dispatch(
    store.applyForBed({ room_id: rid(db, '101'), beds: 1, planned_nights: 2, operator: 'FD' }).application_id
  );
  const first = store.claimOrder(order.id, 'A1');
  const second = store.claimOrder(order.id, 'A2');
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_claimed');
  assert.equal(second.claimed_by, 'A1');
  assert.equal(store.getOrder(order.id).claimed_by, 'A1');
});

test('抢单：非房务员不能认领', () => {
  const { db, store } = setup();
  const order = store.dispatch(
    store.applyForBed({ room_id: rid(db, '101'), beds: 1, planned_nights: 2, operator: 'FD' }).application_id
  );
  assert.throws(() => store.claimOrder(order.id, 'FD'), /只有房务员/);
});

// ---------- 确认与状态机 ----------
test('住客确认：未送达不能确认；确认后计入房账（原报价预授权）', () => {
  const { db, store } = setup();
  const app = store.applyForBed({ room_id: rid(db, '101'), beds: 1, planned_nights: 2, operator: 'FD' });
  const order = store.dispatch(app.application_id);
  assert.throws(() => store.guestConfirm(order.id), /仅已送达/);
  store.claimOrder(order.id, 'A1');
  store.markDelivered(order.id, null);
  const confirmed = store.guestConfirm(order.id);
  assert.equal(confirmed.status, 'confirmed');
  const folio = store.folioOfRoom(rid(db, '101'));
  const bed = folio.find((e) => e.category === 'bed' && e.amount === 200);
  assert.ok(bed, '应有一笔 200 的原报价预授权');
});

// ---------- 跨夜费用 / 提前撤床 ----------
test('跨夜续住：实际 3 晚 > 计划 2 晚，按实际夜数计费并标记 cross_night', () => {
  const { db, store } = setup();
  const t0 = Date.parse('2026-10-01T14:00:00Z');
  const order = flow(store, db, '101', { nights: 2, t0 });
  const s = store.recoverAndSettle(order.id, {
    results: resultsFor(order), end_kind: 'checkout', operator: 'FD'
  }, new Date(t0 + 3 * DAY));
  assert.equal(s.nights, 3);
  assert.equal(s.cross_night, true);
  assert.equal(s.bed_fee, 300);
});

test('提前撤床：仅住 1 晚，按实际夜数收 100，且标记提前撤床', () => {
  const { db, store } = setup();
  const t0 = Date.parse('2026-10-01T14:00:00Z');
  const order = flow(store, db, '101', { nights: 3, t0 });
  const s = store.recoverAndSettle(order.id, {
    results: resultsFor(order), end_kind: 'early_remove', operator: 'FD'
  }, new Date(t0 + 1 * DAY));
  assert.equal(s.nights, 1);
  assert.equal(s.bed_fee, 100);
  assert.equal(s.cross_night, false);
  assert.equal(store.getOrder(order.id).end_kind, 'early_remove');
});

test('结算：必须逐件核对，缺件结论须填原因', () => {
  const { db, store } = setup();
  const order = flow(store, db, '101');
  // 少交一件
  const partial = order.items.slice(0, 2).map((it) => ({ item_id: it.id, condition: 'ok' }));
  assert.throws(() => store.recoverAndSettle(order.id, {
    results: partial, end_kind: 'checkout', operator: 'FD'
  }), /逐件核对/);

  // 枕头缺件但无原因
  const noReason = resultsFor(order, { pillow: { item_id: order.items.find((i) => i.kind === 'pillow').id, condition: 'missing', reason: '' } });
  assert.throws(() => store.recoverAndSettle(order.id, {
    results: noReason, end_kind: 'checkout', operator: 'FD'
  }), /必须填写/);
});

// ---------- 缺件 / 损坏结算 ----------
test('退房漏收布草：被褥+枕头缺件按价赔偿，资产置 missing 并释放订单', () => {
  const { db, store } = setup();
  const order = flow(store, db, '101');
  const res = resultsFor(order, {
    bedding: { item_id: order.items.find((i) => i.kind === 'bedding').id, condition: 'missing', reason: '未找到被褥' },
    pillow: { item_id: order.items.find((i) => i.kind === 'pillow').id, condition: 'missing', reason: '未找到枕头' }
  });
  const s = store.recoverAndSettle(order.id, { results: res, end_kind: 'checkout', operator: 'FD' });
  assert.equal(s.linen_fee, LOST_FEE.bedding + LOST_FEE.pillow); // 300 + 100
  assert.equal(s.damage_fee, 0);
  const missing = db.prepare("SELECT COUNT(*) n FROM assets WHERE status='missing'").get().n;
  assert.equal(missing, 2);
  // 订单占用释放
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets WHERE current_order_id=?').get(order.id).n, 0);
  // 房账有布草赔偿
  const folio = store.folioOfRoom(rid(db, '101'));
  assert.ok(folio.some((e) => e.category === 'linen' && e.amount === 400));
});

test('床架损坏：收损坏费，床架不回可用库；房务员无权减免', () => {
  const { db, store } = setup();
  const order = flow(store, db, '101');
  const res = resultsFor(order, {
    frame: { item_id: order.items.find((i) => i.kind === 'frame').id, condition: 'damaged', reason: '床腿断裂' }
  });
  // 房务员尝试减免 → 403
  assert.throws(() => store.recoverAndSettle(order.id, {
    results: res, end_kind: 'checkout', operator: 'A1', waiver_amount: 100
  }), /无权免除/);

  // 房务员无减免可正常结算
  const s = store.recoverAndSettle(order.id, {
    results: res, end_kind: 'checkout', operator: 'A1', waiver_amount: 0
  });
  assert.equal(s.damage_fee, DAMAGE_FEE.frame); // 800
  assert.equal(db.prepare("SELECT status FROM assets WHERE code='F1'").get().status, 'damaged');
  // 损坏床架不回可用 → 可用床架为 0
  assert.equal(store.availableStock().frame, 0);
});

test('前台减免损坏费：只能前台办理且不超过赔偿合计', () => {
  const { db, store } = setup();
  const order = flow(store, db, '101');
  const res = resultsFor(order, {
    frame: { item_id: order.items.find((i) => i.kind === 'frame').id, condition: 'damaged', reason: '轻微划痕' }
  });
  // 减免超额 → 400
  assert.throws(() => store.recoverAndSettle(order.id, {
    results: res, end_kind: 'checkout', operator: 'FD', waiver_amount: FEES.FRAME_DAMAGE + 1
  }), /减免金额/);

  const s = store.recoverAndSettle(order.id, {
    results: res, end_kind: 'checkout', operator: 'FD', waiver_amount: 200, waiver_note: '善意减免'
  });
  assert.equal(s.standard_total, 100 + FEES.FRAME_DAMAGE);
  assert.equal(s.payable, 100 + FEES.FRAME_DAMAGE - 200);
});

// ---------- 前台调价保留原报价 ----------
test('前台调价：保留原报价，非前台无权调价', () => {
  const { db, store } = setup();
  const order = flow(store, db, '101', { nights: 2 });
  store.recoverAndSettle(order.id, { results: resultsFor(order), end_kind: 'checkout', operator: 'FD' });

  assert.throws(() => store.adjustPrice(order.id, { adjusted_total: 50, note: 'x', operator: 'A1' }), /只有前台/);

  const before = store.getOrder(order.id).settlement.original_quote_total;
  const after = store.adjustPrice(order.id, { adjusted_total: 80, note: 'VIP 折扣', operator: 'FD' });
  assert.equal(after.adjusted_total, 80);
  assert.equal(after.original_quote_total, before); // 原报价不变
  assert.equal(after.original_quote_total, 200);
  // 房账出现调整差额 80 - 100 = -20
  const folio = store.folioOfRoom(rid(db, '101'));
  assert.ok(folio.some((e) => e.category === 'adjust' && e.amount === -20));
});

test('完好件回收后重新可用，可再次派单', () => {
  const { db, store } = setup();
  const t0 = Date.parse('2026-10-01T14:00:00Z');
  const order = flow(store, db, '101', { t0 });
  store.recoverAndSettle(order.id, {
    results: resultsFor(order), end_kind: 'checkout', operator: 'FD'
  }, new Date(t0 + DAY));
  assert.equal(store.availableStock().frame, 1);
  // 101 已无在租加床，可再次申请（消防：1 人 +1 =2 通过）
  const again = store.applyForBed({ room_id: rid(db, '101'), beds: 1, planned_nights: 1, operator: 'FD' });
  assert.equal(again.ok, true);
  const o2 = store.dispatch(again.application_id);
  assert.equal(o2.items.find((i) => i.kind === 'frame').asset_code, 'F1');
});
