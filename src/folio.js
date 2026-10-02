'use strict';

// 模拟房账适配器（PMS Adapter）。
// 真实环境可替换为对接酒店 PMS 的实现，保持 post/list 两个方法即可。
const mockFolio = {
  post(db, { room_id, order_id, category, label, amount }) {
    const info = db.prepare(`
      INSERT INTO folio_entries (room_id,order_id,category,label,amount,created_at)
      VALUES (?,?,?,?,?,?)
    `).run(room_id, order_id || null, category, label, amount, new Date().toISOString());
    return { id: Number(info.lastInsertRowid), category, label, amount, posted: true, via: 'mock-pms' };
  },
  list(db, room_id) {
    return db.prepare(`
      SELECT * FROM folio_entries WHERE room_id=? ORDER BY id
    `).all(room_id);
  }
};

module.exports = { mockFolio };
