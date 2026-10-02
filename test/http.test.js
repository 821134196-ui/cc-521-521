'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getDB } = require('../src/db');
const { Store } = require('../src/store');
const { mockFolio } = require('../src/folio');
const { seed } = require('../src/seed');
const { createServer } = require('../src/server');

const PHOTO_DIR = path.join(__dirname, '..', 'data', 'photos');

async function withServer(t) {
  const db = getDB(':memory:');
  seed(db);
  const server = createServer(new Store(db, mockFolio));
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => server.close());
  return { base, db };
}

const post = (base, url, body) =>
  fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
const get = (base, url) => fetch(base + url).then((r) => r);

test('HTTP：首页与房态可访问，房态含已加床数量', async (t) => {
  const { base } = await withServer(t);
  const home = await get(base, '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  const rooms = await (await get(base, '/api/rooms')).json();
  const r302 = rooms.find((r) => r.room_no === '302');
  assert.equal(r302.extra_beds, 1, '302 应有 1 张在租加床');
});

test('HTTP：超员样例 301 申请被拒 occupancy，原报价保留', async (t) => {
  const { base } = await withServer(t);
  const r = await post(base, '/api/apply', { room_id: 1, beds: 1, planned_nights: 2, operator: 'FD1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.reject_code, 'occupancy');
  assert.equal(r.json.quoted_total, 240);
});

test('HTTP：两名房务员并发抢同一张单，仅一人成功', async (t) => {
  const { base } = await withServer(t);
  // 501 房申请并派单
  const applied = await post(base, '/api/apply', { room_id: 3, beds: 1, planned_nights: 2, operator: 'FD1' });
  assert.equal(applied.json.ok, true);
  const dispatched = await post(base, '/api/dispatch', { application_id: applied.json.application_id });
  const orderId = dispatched.json.id;

  const [c1, c2] = await Promise.all([
    post(base, `/api/orders/${orderId}/claim`, { staff_id: 'A1' }),
    post(base, `/api/orders/${orderId}/claim`, { staff_id: 'A2' })
  ]);
  const wins = [c1.json, c2.json].filter((x) => x.ok);
  const loses = [c1.json, c2.json].filter((x) => !x.ok);
  assert.equal(wins.length, 1);
  assert.equal(loses.length, 1);
  assert.equal(loses[0].reason, 'already_claimed');
  assert.equal(loses[0].claimed_by, wins[0].claimed_by);
});

test('HTTP：验收照片 base64 落本地并可通过 /photos 访问', async (t) => {
  const { base } = await withServer(t);
  const applied = await post(base, '/api/apply', { room_id: 3, beds: 1, planned_nights: 1, operator: 'FD1' });
  const dispatched = await post(base, '/api/dispatch', { application_id: applied.json.application_id });
  const orderId = dispatched.json.id;
  await post(base, `/api/orders/${orderId}/claim`, { staff_id: 'A1' });

  // 1x1 PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const del = await post(base, `/api/orders/${orderId}/deliver`, { photo: `data:image/png;base64,${png}`, mime: 'image/png' });
  assert.equal(del.json.status, 'delivered');
  assert.match(del.json.accept_photo, /^\/photos\/order-/);

  const img = await get(base, del.json.accept_photo);
  assert.equal(img.status, 200);
  const buf = Buffer.from(await img.arrayBuffer());
  assert.equal(buf.length, Buffer.from(png, 'base64').length);
  t.after(() => { try { fs.rmSync(path.join(PHOTO_DIR, path.basename(del.json.accept_photo))); } catch { /* noop */ } });
});

test('HTTP：缺件结算（漏收枕头）金额正确并回写资产', async (t) => {
  const { base, db } = await withServer(t);
  const applied = await post(base, '/api/apply', { room_id: 3, beds: 1, planned_nights: 2, operator: 'FD1' });
  const dispatched = await post(base, '/api/dispatch', { application_id: applied.json.application_id });
  const oid = dispatched.json.id;
  await post(base, `/api/orders/${oid}/claim`, { staff_id: 'A1' });
  await post(base, `/api/orders/${oid}/deliver`, {});
  await post(base, `/api/orders/${oid}/confirm`, {});

  const order = await (await get(base, `/api/orders/${oid}`)).json();
  const pillow = order.items.find((i) => i.kind === 'pillow');
  const results = order.items.map((i) => i.kind === 'pillow'
    ? { item_id: i.id, condition: 'missing', reason: '查房未见枕头' }
    : { item_id: i.id, condition: 'ok', reason: '' });
  const s = await post(base, `/api/orders/${oid}/settle`, { results, end_kind: 'checkout', operator: 'FD1' });
  assert.equal(s.json.linen_fee, 100);
  assert.equal(s.json.payable, s.json.bed_fee + 100);
  assert.equal(db.prepare('SELECT status FROM assets WHERE id=?').get(pillow.asset_id).status, 'missing');
});
