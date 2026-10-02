'use strict';

// 业务常量（单位：元）
const FEES = {
  FRAME_DAMAGE: 800,   // 床架损坏赔偿
  FRAME_LOST: 1200,    // 床架遗失
  BEDDING_LOST: 300,   // 被褥漏收/遗失
  PILLOW_LOST: 100,    // 枕头漏收/遗失
  BEDDING_DAMAGE: 120, // 被褥污损
  PILLOW_DAMAGE: 40
};

const KIND_CN = { frame: '床架', bedding: '被褥', pillow: '枕头' };
const DAMAGE_FEE = {
  frame: FEES.FRAME_DAMAGE,
  bedding: FEES.BEDDING_DAMAGE,
  pillow: FEES.PILLOW_DAMAGE
};
const LOST_FEE = {
  frame: FEES.FRAME_LOST,
  bedding: FEES.BEDDING_LOST,
  pillow: FEES.PILLOW_LOST
};

function nowIso(now = new Date()) {
  return now.toISOString();
}

class Store {
  constructor(db, folio) {
    this.db = db;
    this.folio = folio; // 房账适配器
  }

  // ---------- 查询 ----------

  listRoomTypes() {
    return this.db.prepare('SELECT * FROM room_types ORDER BY code').all();
  }

  // 房态列表：直接显示已加床数量（在租床架数）
  listRooms() {
    const rooms = this.db.prepare(`
      SELECT r.*, t.name AS type_name, t.fire_capacity, t.max_extra_beds,
             t.nightly_fee
      FROM rooms r JOIN room_types t ON t.code = r.type_code
      ORDER BY r.room_no
    `).all();
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) AS n FROM delivery_orders o
      JOIN assets a ON a.current_order_id = o.id AND a.kind = 'frame'
      WHERE o.room_id = ? AND o.status IN ('dispatched','claimed','delivered','confirmed')
    `);
    return rooms.map((r) => ({
      ...r,
      extra_beds: countStmt.get(r.id).n
    }));
  }

  listStaff(role) {
    return role
      ? this.db.prepare('SELECT * FROM staff WHERE role=? ORDER BY id').all(role)
      : this.db.prepare('SELECT * FROM staff ORDER BY id').all();
  }

  listAssets() {
    return this.db.prepare(
      'SELECT * FROM assets ORDER BY kind, code'
    ).all();
  }

  availableStock() {
    const row = this.db.prepare(`
      SELECT
        SUM(kind='frame' AND status='available')   AS frame,
        SUM(kind='bedding' AND status='available') AS bedding,
        SUM(kind='pillow' AND status='available')  AS pillow
      FROM assets
    `).get();
    return { frame: row.frame || 0, bedding: row.bedding || 0, pillow: row.pillow || 0 };
  }

  getOrder(id) {
    const order = this.db.prepare('SELECT * FROM delivery_orders WHERE id=?').get(id);
    if (!order) return null;
    order.items = this.db.prepare(
      'SELECT * FROM order_items WHERE order_id=? ORDER BY id'
    ).all(id);
    const s = this.db.prepare('SELECT * FROM settlements WHERE order_id=?').get(id);
    order.settlement = s || null;
    order.room = this.db.prepare('SELECT * FROM rooms WHERE id=?').get(order.room_id);
    return order;
  }

  listOrders(status) {
    const rows = status
      ? this.db.prepare('SELECT * FROM delivery_orders WHERE status=? ORDER BY id').all(status)
      : this.db.prepare('SELECT * FROM delivery_orders ORDER BY id DESC').all();
    return rows.map((o) => this.getOrder(o.id));
  }

  // ---------- 前台：接受加床申请 ----------
  // 依据：房型、消防核准人数、可用折叠床库存；保留原报价。
  applyForBed({ room_id, beds, planned_nights, operator }, clock = new Date()) {
    beds = Number(beds);
    planned_nights = Number(planned_nights);
    if (!Number.isInteger(beds) || beds < 1) throw httpErr(400, '加床数量必须为正整数');
    if (!Number.isInteger(planned_nights) || planned_nights < 1) {
      throw httpErr(400, '计划夜数必须为正整数');
    }
    const room = this.db.prepare(`
      SELECT r.*, t.fire_capacity, t.max_extra_beds, t.nightly_fee
      FROM rooms r JOIN room_types t ON t.code = r.type_code
      WHERE r.id=?
    `).get(room_id);
    if (!room) throw httpErr(404, '房间不存在');

    const activeBeds = this.db.prepare(`
      SELECT COUNT(*) AS n FROM delivery_orders o
      JOIN assets a ON a.current_order_id = o.id AND a.kind='frame'
      WHERE o.room_id=? AND o.status IN ('dispatched','claimed','delivered','confirmed')
    `).get(room_id).n;

    // 1) 入住人数超限（消防核准人数）
    if (room.registered_guests + beds > room.fire_capacity) {
      return this._recordApplication({
        room, beds, planned_nights, status: 'rejected',
        reject_code: 'occupancy',
        reject_reason: `入住人数 ${room.registered_guests}+${beds} 超过消防核准 ${room.fire_capacity} 人`,
        operator, clock
      });
    }
    // 2) 房间空间不足
    if (activeBeds + beds > room.max_extra_beds) {
      return this._recordApplication({
        room, beds, planned_nights, status: 'rejected',
        reject_code: 'space',
        reject_reason: `房间最多加床 ${room.max_extra_beds} 张，当前已加 ${activeBeds} 张`,
        operator, clock
      });
    }
    // 3) 库存（折叠床=床架；床架/被褥/枕头均需齐备）
    const stock = this.availableStock();
    for (const kind of ['frame', 'bedding', 'pillow']) {
      if (stock[kind] < beds) {
        return this._recordApplication({
          room, beds, planned_nights, status: 'rejected',
          reject_code: 'stock',
          reject_reason: `${KIND_CN[kind]}库存不足：需 ${beds}，可用 ${stock[kind]}`,
          operator, clock
        });
      }
    }
    return this._recordApplication({
      room, beds, planned_nights, status: 'approved',
      operator, clock
    });
  }

  _recordApplication({ room, beds, planned_nights, status, reject_code, reject_reason, operator, clock }) {
    const quoted_nightly = room.nightly_fee;
    const quoted_total = room.nightly_fee * planned_nights * beds;
    const info = this.db.prepare(`
      INSERT INTO applications
        (room_id,beds,planned_nights,quoted_nightly,quoted_total,status,
         reject_code,reject_reason,operator,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      room.id, beds, planned_nights, quoted_nightly, quoted_total,
      status, reject_code || null, reject_reason || null, operator, nowIso(clock)
    );
    return {
      ok: status === 'approved',
      application_id: Number(info.lastInsertRowid),
      status, reject_code: reject_code || null, reject_reason: reject_reason || null,
      quoted_nightly, quoted_total
    };
  }

  // ---------- 配送派单：原子分配床架与布草（不可重叠） ----------
  dispatch(application_id, clock = new Date()) {
    const app = this.db.prepare('SELECT * FROM applications WHERE id=?').get(application_id);
    if (!app) throw httpErr(404, '申请不存在');
    if (app.status !== 'approved') throw httpErr(409, '申请未通过，不能派单');
    const dup = this.db.prepare(
      'SELECT id FROM delivery_orders WHERE application_id=?'
    ).get(application_id);
    if (dup) throw httpErr(409, '该申请已派单');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const need = app.beds;
      // 复查库存（可能在申请后被占用）
      const stock = this.availableStock();
      for (const kind of ['frame', 'bedding', 'pillow']) {
        if (stock[kind] < need) {
          this.db.exec('ROLLBACK');
          const e = httpErr(409, `${KIND_CN[kind]}库存不足，派单失败`);
          e.code = 'stock';
          throw e;
        }
      }

      const orderInfo = this.db.prepare(`
        INSERT INTO delivery_orders (application_id,room_id,beds,status,dispatched_at)
        VALUES (?,?,?,'dispatched',?)
      `).run(app.id, app.room_id, need, nowIso(clock));
      const orderId = Number(orderInfo.lastInsertRowid);

      // 原子抢占可用资产：只有 status='available' 的行会被更新，杜绝重叠
      const picked = {};
      for (const kind of ['frame', 'bedding', 'pillow']) {
        const candidates = this.db.prepare(
          "SELECT id FROM assets WHERE kind=? AND status='available' ORDER BY id LIMIT ?"
        ).all(kind, need);
        const upd = this.db.prepare(
          "UPDATE assets SET status='lent', current_order_id=? WHERE id=? AND status='available'"
        );
        picked[kind] = [];
        for (const c of candidates) {
          const r = upd.run(orderId, c.id);
          if (r.changes !== 1) throw httpErr(500, '资产分配冲突');
          picked[kind].push(c.id);
        }
      }

      const insItem = this.db.prepare(`
        INSERT INTO order_items (order_id,asset_id,kind,asset_code)
        VALUES (?,?,?,?)
      `);
      for (const kind of ['frame', 'bedding', 'pillow']) {
        for (const assetId of picked[kind]) {
          const a = this.db.prepare('SELECT code FROM assets WHERE id=?').get(assetId);
          insItem.run(orderId, assetId, kind, a.code);
        }
      }
      this.db.exec('COMMIT');
      return this.getOrder(orderId);
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw err;
    }
  }

  // ---------- 房务员抢单：两人同时认领只成功一次 ----------
  claimOrder(order_id, staff_id) {
    const staff = this.db.prepare("SELECT * FROM staff WHERE id=? AND role='attendant'").get(staff_id);
    if (!staff) throw httpErr(403, '只有房务员可以认领配送单');
    const r = this.db.prepare(`
      UPDATE delivery_orders
         SET claimed_by=?, claimed_at=?, status='claimed'
       WHERE id=? AND status='dispatched'
    `).run(staff_id, nowIso(), order_id);
    if (r.changes !== 1) {
      const order = this.getOrder(order_id);
      if (!order) throw httpErr(404, '配送单不存在');
      return { ok: false, reason: 'already_claimed', claimed_by: order.claimed_by };
    }
    return { ok: true, order_id, claimed_by: staff_id };
  }

  // ---------- 配送 + 验收照片（本地存储） ----------
  markDelivered(order_id, photoPath, clock = new Date()) {
    const r = this.db.prepare(`
      UPDATE delivery_orders
         SET status='delivered', delivered_at=?, accept_photo=COALESCE(?,accept_photo)
       WHERE id=? AND status IN ('claimed','dispatched')
    `).run(nowIso(clock), photoPath || null, order_id);
    if (r.changes !== 1) throw httpErr(409, '当前状态不能标记送达');
    return this.getOrder(order_id);
  }

  // ---------- 住客确认：计入房账 ----------
  guestConfirm(order_id, clock = new Date()) {
    const order = this.getOrder(order_id);
    if (!order) throw httpErr(404, '配送单不存在');
    if (order.status !== 'delivered') throw httpErr(409, '仅已送达单据可由住客确认');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE delivery_orders SET status='confirmed', confirmed_at=? WHERE id=?
      `).run(nowIso(clock), order_id);
      const app = this.db.prepare('SELECT * FROM applications WHERE id=?').get(order.application_id);
      // 确认后计入房账（预授权原报价；结算时多退少补由模拟适配器处理）
      this.folio.post(this.db, {
        room_id: order.room_id, order_id,
        category: 'bed',
        label: `加床 x${order.beds}（住客确认，预授权原报价）`,
        amount: app.quoted_total
      });
      this.db.exec('COMMIT');
      return this.getOrder(order_id);
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* noop */ }
      throw err;
    }
  }

  // ---------- 退房/提前撤床：逐件回收 + 结算 ----------
  // results: [{ item_id, condition: ok|damaged|missing, reason, photo }]
  recoverAndSettle(order_id, { results, end_kind, operator, waiver_amount = 0, waiver_note }, clock = new Date()) {
    const order = this.getOrder(order_id);
    if (!order) throw httpErr(404, '配送单不存在');
    if (!['confirmed', 'delivered'].includes(order.status)) {
      throw httpErr(409, '仅住客确认后的单据可以回收结算');
    }
    if (!['early_remove', 'checkout'].includes(end_kind)) {
      throw httpErr(400, '撤床类型必须是 early_remove 或 checkout');
    }
    const byItem = new Map((results || []).map((x) => [Number(x.item_id), x]));
    if (byItem.size !== order.items.length) {
      throw httpErr(400, `需逐件核对 ${order.items.length} 件，实收 ${byItem.size} 件`);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1) 逐件回收
      let damage_fee = 0;
      let linen_fee = 0;
      const updItem = this.db.prepare(`
        UPDATE order_items SET recover_condition=?, recover_reason=?,
               recover_photo=?, returned_at=? WHERE id=?
      `);
      const setAsset = this.db.prepare('UPDATE assets SET status=? WHERE id=?');

      for (const item of order.items) {
        const res = byItem.get(item.id);
        if (!res || !['ok', 'damaged', 'missing'].includes(res.condition)) {
          throw httpErr(400, `资产 ${item.asset_code} 缺少有效回收结论`);
        }
        if (res.condition !== 'ok' && !(res.reason || '').trim()) {
          throw httpErr(400, `${KIND_CN[item.kind]} ${item.asset_code} 必须填写缺件/损耗原因`);
        }
        updItem.run(res.condition, res.reason || null, res.photo || null, nowIso(clock), item.id);

        if (res.condition === 'missing') {
          setAsset.run('missing', item.asset_id);
          if (item.kind === 'frame') damage_fee += LOST_FEE.frame;
          else linen_fee += LOST_FEE[item.kind]; // 漏收布草
        } else if (res.condition === 'damaged') {
          // 床架损坏计入损坏费；布草污损计入布草费
          setAsset.run('damaged', item.asset_id);
          if (item.kind === 'frame') damage_fee += DAMAGE_FEE.frame;
          else linen_fee += DAMAGE_FEE[item.kind];
        } else {
          setAsset.run('available', item.asset_id);
        }
      }

      // 2) 跨夜费用：实际过夜数 vs 计划夜数
      const app = this.db.prepare('SELECT * FROM applications WHERE id=?').get(order.application_id);
      const start = new Date(order.confirmed_at || order.delivered_at);
      const actualNights = Math.max(1, nightSpan(start, clock));
      const nights = actualNights;
      const bed_fee = app.quoted_nightly * order.beds * nights;

      const standard_total = bed_fee + damage_fee + linen_fee;
      if (waiver_amount > 0) {
        // 房务员无法自己免除损坏费用：只有前台可减免
        const op = this.db.prepare("SELECT role FROM staff WHERE id=?").get(operator);
        if (!op || op.role !== 'front_desk') {
          throw httpErr(403, '房务员无权免除损坏/缺件费用，须由前台办理');
        }
        if (waiver_amount > damage_fee + linen_fee) {
          throw httpErr(400, '减免金额不能超过赔偿合计');
        }
      }
      const payable = standard_total - waiver_amount;

      const sinfo = this.db.prepare(`
        INSERT INTO settlements
          (order_id,nights,bed_fee,damage_fee,linen_fee,standard_total,
           waiver_amount,waiver_note,original_quote_total,operator,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        order_id, nights, bed_fee, damage_fee, linen_fee, standard_total,
        waiver_amount, waiver_note || null, app.quoted_total, operator, nowIso(clock)
      );
      const settlementId = Number(sinfo.lastInsertRowid);

      // 3) 房账入账（模拟适配器）：先冲预授权，再按实际入账
      this.folio.post(this.db, {
        room_id: order.room_id, order_id, category: 'bed',
        label: `加床预授权冲回 x${order.beds}`, amount: -app.quoted_total
      });
      this.folio.post(this.db, {
        room_id: order.room_id, order_id, category: 'bed',
        label: `加床费 x${order.beds} x ${nights} 晚${
          nights > app.planned_nights ? '（跨夜续住）' :
          end_kind === 'early_remove' ? '（提前撤床，按实际夜数）' : ''}`,
        amount: bed_fee
      });
      if (damage_fee > 0) {
        this.folio.post(this.db, {
          room_id: order.room_id, order_id, category: 'damage',
          label: '床架损坏/遗失赔偿', amount: damage_fee
        });
      }
      if (linen_fee > 0) {
        this.folio.post(this.db, {
          room_id: order.room_id, order_id, category: 'linen',
          label: '布草缺件/污损赔偿', amount: linen_fee
        });
      }
      if (waiver_amount > 0) {
        this.folio.post(this.db, {
          room_id: order.room_id, order_id, category: 'waiver',
          label: `前台减免：${waiver_note || ''}`, amount: -waiver_amount
        });
      }

      this.db.prepare(
        "UPDATE delivery_orders SET status='settled', settled_at=?, end_kind=? WHERE id=?"
      ).run(nowIso(clock), end_kind, order_id);
      // 释放订单占用（资产状态已在上面逐件更新）
      this.db.prepare('UPDATE assets SET current_order_id=NULL WHERE current_order_id=?').run(order_id);

      this.db.exec('COMMIT');
      return {
        ok: true,
        settlement_id: settlementId,
        nights, planned_nights: app.planned_nights,
        cross_night: nights > app.planned_nights,
        bed_fee, damage_fee, linen_fee, standard_total,
        waiver_amount, payable,
        original_quote_total: app.quoted_total
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* noop */ }
      throw err;
    }
  }

  // ---------- 前台调价：保留原报价 ----------
  adjustPrice(order_id, { adjusted_total, note, operator }) {
    const op = this.db.prepare("SELECT * FROM staff WHERE id=? AND role='front_desk'").get(operator);
    if (!op) throw httpErr(403, '只有前台可以调整价格');
    const order = this.getOrder(order_id);
    if (!order) throw httpErr(404, '配送单不存在');
    if (!order.settlement) throw httpErr(409, '需先完成回收结算');
    const amt = Number(adjusted_total);
    if (!Number.isFinite(amt) || amt < 0) throw httpErr(400, '调整后金额无效');

    this.db.prepare(
      'UPDATE settlements SET adjusted_total=?, adjust_note=? WHERE id=?'
    ).run(amt, note || null, order.settlement.id);

    const current = order.settlement.adjusted_total != null
      ? order.settlement.adjusted_total
      : order.settlement.standard_total - order.settlement.waiver_amount;
    const delta = amt - current;
    if (delta !== 0) {
      this.folio.post(this.db, {
        room_id: order.room_id, order_id, category: 'adjust',
        label: `前台手工调价：${note || ''}（原报价保留）`, amount: delta
      });
    }
    return this.getOrder(order_id).settlement;
  }

  listApplications() {
    return this.db.prepare(`
      SELECT a.*, r.room_no FROM applications a JOIN rooms r ON r.id=a.room_id
      ORDER BY a.id DESC
    `).all();
  }

  folioOfRoom(room_id) {
    return this.folio.list(this.db, room_id);
  }
}

// 过夜数：按日期跨度（结算时刻 - 确认时刻），跨夜即 +1
function nightSpan(start, end) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.ceil(ms / 86400000);
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { Store, FEES, KIND_CN, DAMAGE_FEE, LOST_FEE, httpErr };
