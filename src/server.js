'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getDB } = require('./db');
const { Store } = require('./store');
const { mockFolio } = require('./folio');
const { seed } = require('./seed');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.HOTEL_DB || path.join(DATA_DIR, 'hotel.db');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5210);

function makeStore(dbFile = DB_FILE) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const db = getDB(dbFile);
  seed(db);
  return new Store(db, mockFolio);
}

// 保存验收照片到本地；文件名用订单+时间，避免可预测路径穿越。
function savePhoto(orderId, dataUrlOrBase64, mimeHint = 'image/jpeg') {
  let mime = mimeHint;
  let b64 = dataUrlOrBase64;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrlOrBase64 || '');
  if (m) { mime = m[1]; b64 = m[2]; }
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const name = `order-${orderId}-${Date.now()}.${ext}`;
  const file = path.join(PHOTO_DIR, name);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return `/photos/${name}`;
}

function createServer(store) {
  return http.createServer(async (req, res) => {
    try {
      await route(store, req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err.message || '服务器错误' });
    }
  });
}

async function route(store, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // 本地照片
  if (p.startsWith('/photos/')) {
    return serveFile(res, path.join(PHOTO_DIR, path.basename(p)), 'image/jpeg');
  }
  // 静态前端
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && p.startsWith('/')) {
    const fp = path.join(PUBLIC_DIR, p);
    if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ct = p.endsWith('.css') ? 'text/css; charset=utf-8'
        : p.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';
      return serveFile(res, fp, ct);
    }
  }

  if (!p.startsWith('/api/')) {
    sendJson(res, 404, { error: '未找到' });
    return;
  }

  const body = req.method === 'GET' ? null : await readJson(req);

  // --- 查询 ---
  if (p === '/api/rooms' && req.method === 'GET') return sendJson(res, 200, store.listRooms());
  if (p === '/api/room-types' && req.method === 'GET') return sendJson(res, 200, store.listRoomTypes());
  if (p === '/api/staff' && req.method === 'GET') return sendJson(res, 200, store.listStaff(url.searchParams.get('role')));
  if (p === '/api/assets' && req.method === 'GET') return sendJson(res, 200, store.listAssets());
  if (p === '/api/stock' && req.method === 'GET') return sendJson(res, 200, store.availableStock());
  if (p === '/api/applications' && req.method === 'GET') return sendJson(res, 200, store.listApplications());
  if (p === '/api/orders' && req.method === 'GET') {
    return sendJson(res, 200, store.listOrders(url.searchParams.get('status')));
  }

  let mm;
  if ((mm = p.match(/^\/api\/orders\/(\d+)$/)) && req.method === 'GET') {
    const o = store.getOrder(Number(mm[1]));
    if (!o) return sendJson(res, 404, { error: '配送单不存在' });
    return sendJson(res, 200, o);
  }
  if ((mm = p.match(/^\/api\/rooms\/(\d+)\/folio$/)) && req.method === 'GET') {
    return sendJson(res, 200, store.folioOfRoom(Number(mm[1])));
  }

  // --- 业务动作 ---
  if (p === '/api/apply' && req.method === 'POST') {
    return sendJson(res, 200, store.applyForBed(body));
  }
  if (p === '/api/dispatch' && req.method === 'POST') {
    return sendJson(res, 200, store.dispatch(Number(body.application_id)));
  }
  if ((mm = p.match(/^\/api\/orders\/(\d+)\/claim$/)) && req.method === 'POST') {
    return sendJson(res, 200, store.claimOrder(Number(mm[1]), body.staff_id));
  }
  if ((mm = p.match(/^\/api\/orders\/(\d+)\/deliver$/)) && req.method === 'POST') {
    const id = Number(mm[1]);
    let photoPath = null;
    if (body.photo) photoPath = savePhoto(id, body.photo, body.mime || 'image/jpeg');
    return sendJson(res, 200, store.markDelivered(id, photoPath));
  }
  if ((mm = p.match(/^\/api\/orders\/(\d+)\/confirm$/)) && req.method === 'POST') {
    const id = Number(mm[1]);
    if (body && body.confirmed_at) {
      return sendJson(res, 200, store.guestConfirm(id, new Date(body.confirmed_at)));
    }
    return sendJson(res, 200, store.guestConfirm(id));
  }
  if ((mm = p.match(/^\/api\/orders\/(\d+)\/settle$/)) && req.method === 'POST') {
    const id = Number(mm[1]);
    let clock = new Date();
    if (body.settled_at) clock = new Date(body.settled_at);
    // 逐件回收照片落本地，再把可引用路径交给业务层
    for (const r of body.results || []) {
      if (r.photo && r.photo.startsWith('data:')) {
        r.photo = savePhoto(`order-${id}-item-${r.item_id}`, r.photo, r.mime || 'image/jpeg');
      }
    }
    const result = store.recoverAndSettle(id, {
      results: body.results,
      end_kind: body.end_kind,
      operator: body.operator,
      waiver_amount: Number(body.waiver_amount || 0),
      waiver_note: body.waiver_note
    }, clock);
    return sendJson(res, 200, result);
  }
  if ((mm = p.match(/^\/api\/orders\/(\d+)\/recover-photo$/)) && req.method === 'POST') {
    // 单件回收照片上传（结算前保存，返回可引用路径）
    const itemId = Number(body.item_id);
    const rel = savePhoto(`item-${itemId}`, body.photo, body.mime || 'image/jpeg');
    return sendJson(res, 200, { photo: rel });
  }
  if ((mm = p.match(/^\/api\/orders\/(\d+)\/adjust$/)) && req.method === 'POST') {
    return sendJson(res, 200, store.adjustPrice(Number(mm[1]), body));
  }

  sendJson(res, 404, { error: '未知接口' });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 15 * 1024 * 1024) { reject(Object.assign(new Error('请求过大'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

function serveFile(res, file, ct) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}

if (require.main === module) {
  if (process.argv.includes('--reset')) {
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* noop */ }
    }
    console.log('已重置数据库:', DB_FILE);
  }
  const store = makeStore();
  createServer(store).listen(PORT, () => {
    console.log(`酒店加床管理已启动：http://localhost:${PORT}`);
    console.log(`数据库：${DB_FILE}`);
    console.log(`验收照片目录：${PHOTO_DIR}`);
    console.log('超员样例：301 房（标准大床房，已住 2/2 人），再申请加床将提示“入住人数超限”。');
  });
}

module.exports = { createServer, makeStore, savePhoto };
