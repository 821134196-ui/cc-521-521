'use strict';

// 初始化演示数据：房型规则、床具库存、房态与员工；含“超员样例”。
function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM room_types').get().n;
  if (count > 0) return false;

  db.exec('BEGIN');
  try {
    const insType = db.prepare(`
      INSERT INTO room_types (code,name,fire_capacity,max_extra_beds,nightly_fee)
      VALUES (?,?,?,?,?)
    `);
    // 房型规则：消防核准人数 / 空间允许加床数 / 每晚加床报价
    insType.run('STDQ', '标准大床房', 2, 1, 120);
    insType.run('STDT', '豪华双床房', 4, 1, 150);
    insType.run('FAM',  '家庭套房',   5, 2, 180);
    insType.run('EXE',  '行政套房',   3, 1, 220);

    const insRoom = db.prepare(`
      INSERT INTO rooms (room_no,type_code,guest_name,registered_guests,status)
      VALUES (?,?,?,?,?)
    `);
    // 301：住满消防核准 2 人 —— 超员样例（申请加床将被拒）
    insRoom.run('301', 'STDQ', '张伟', 2, 'occupied');
    // 302：已在住并有 1 张加床在租（见下方演示配送单）
    insRoom.run('302', 'STDT', '李娜', 3, 'occupied');
    // 501：家庭套房，4 人入住，还可加 1 张
    insRoom.run('501', 'FAM',  '王磊', 4, 'occupied');
    // 818：空房
    insRoom.run('818', 'EXE',  null, 0, 'vacant');

    const insStaff = db.prepare('INSERT INTO staff (id,name,role) VALUES (?,?,?)');
    insStaff.run('FD1', '前台·陈静', 'front_desk');
    insStaff.run('A1', '房务员·老赵', 'attendant');
    insStaff.run('A2', '房务员·小钱', 'attendant');

    const insAsset = db.prepare(
      "INSERT INTO assets (code,kind,status) VALUES (?,?,?)"
    );
    // 床架 6 张：F-06 损坏不可用
    ['F-01','F-02','F-03','F-04','F-05'].forEach((c) => insAsset.run(c, 'frame', 'available'));
    insAsset.run('F-06', 'frame', 'damaged');
    // 被褥 8 套、枕头 10 个
    ['B-01','B-02','B-03','B-04','B-05','B-06','B-07','B-08']
      .forEach((c) => insAsset.run(c, 'bedding', 'available'));
    ['P-01','P-02','P-03','P-04','P-05','P-06','P-07','P-08','P-09','P-10']
      .forEach((c) => insAsset.run(c, 'pillow', 'available'));

    // 演示：302 已有一张“住客已确认”的加床（占用 F-01/B-01/P-01）
    const now = new Date();
    const yesterday = new Date(now.getTime() - 26 * 3600 * 1000).toISOString();
    const appInfo = db.prepare(`
      INSERT INTO applications
        (room_id,beds,planned_nights,quoted_nightly,quoted_total,status,operator,created_at)
      VALUES (2,1,2,150,300,'approved','FD1',?)
    `).run(yesterday);
    const appId = Number(appInfo.lastInsertRowid);
    // 302 的 room id = 2
    db.prepare(`
      INSERT INTO delivery_orders
        (application_id,room_id,beds,status,claimed_by,dispatched_at,claimed_at,delivered_at,confirmed_at)
      VALUES (?,?,1,'confirmed','A1',?,?,?,?)
    `).run(appId, 2, yesterday, yesterday, yesterday, yesterday);
    const orderId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    const lend = (assetCode, kind) => {
      const a = db.prepare('SELECT id FROM assets WHERE code=?').get(assetCode);
      db.prepare("UPDATE assets SET status='lent', current_order_id=? WHERE id=?")
        .run(orderId, a.id);
      db.prepare(`INSERT INTO order_items (order_id,asset_id,kind,asset_code)
                  VALUES (?,?,?,?)`).run(orderId, a.id, kind, assetCode);
    };
    lend('F-01', 'frame');
    lend('B-01', 'bedding');
    lend('P-01', 'pillow');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

module.exports = { seed };
