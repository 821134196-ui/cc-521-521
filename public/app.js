'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (path, body) => {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败 ${res.status}`), { status: res.status, data });
  return data;
};
const yuan = (n) => `¥${Number(n || 0).toLocaleString('zh-CN')}`;
const KIND = { frame: '床架', bedding: '被褥', pillow: '枕头' };
const STATUS_CN = { dispatched: '待认领', claimed: '已认领', delivered: '已送达', confirmed: '住客已确认', settled: '已结算' };

const state = { staff: [], rooms: [], orders: [], currentOrder: null, activeView: 'rooms' };

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- Tab 切换 ----------
$$('.tab').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
async function switchView(v) {
  state.activeView = v;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  if (v === 'rooms') await loadRooms();
  if (v === 'dispatch') { await loadOrders(); renderOrders('dispatched'); }
  if (v === 'checkout') { await loadOrders(); renderCheckout(); }
}

// ---------- 房态 ----------
async function loadRooms() {
  const [rooms, stock] = await Promise.all([api('/api/rooms'), api('/api/stock')]);
  state.rooms = rooms;
  $('#stockbar').innerHTML = [
    ['床架', stock.frame, '折叠床'],
    ['被褥', stock.bedding, '套'],
    ['枕头', stock.pillow, '个']
  ].map(([k, v, u]) => `
    <div class="stock-chip"><div class="k">可用${k}</div>
      <div class="v">${v} <small>${u}</small></div></div>`).join('');

  $('#rooms-grid').innerHTML = rooms.map((r) => {
    const full = r.registered_guests >= r.fire_capacity;
    const canApply = r.status === 'occupied' && r.extra_beds < r.max_extra_beds && !full;
    return `
    <div class="room-card ${r.status}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="room-no">${r.room_no}</span>
        <span class="badge ${r.status}">${r.status === 'occupied' ? '在住' : '空房'}</span>
      </div>
      <div class="room-type">${r.type_name}</div>
      <div class="cap-row ${full ? 'over' : ''}">
        <span>入住 / 消防核准</span>
        <b>${r.registered_guests} / ${r.fire_capacity} 人</b>
      </div>
      <div class="extra-beds">
        <span>已加床</span><span class="n">${r.extra_beds}<small> / ${r.max_extra_beds} 张</small></span>
      </div>
      <div class="fee">加床报价 <b>${yuan(r.nightly_fee)}</b> /床·晚</div>
      ${canApply ? `<button class="btn gold block" data-apply="${r.id}">接受加床申请</button>`
        : full ? `<button class="btn ghost block" data-apply="${r.id}">申请加床（将超员）</button>`
        : `<button class="btn ghost block" disabled>${r.extra_beds >= r.max_extra_beds ? '空间已满，无法再加' : '空房'}</button>`}
    </div>`;
  }).join('');

  $$('#rooms-grid [data-apply]').forEach((btn) =>
    btn.addEventListener('click', () => openApply(Number(btn.dataset.apply))));
}

async function openApply(roomId) {
  const r = state.rooms.find((x) => x.id === roomId);
  if (!state.staff.length) state.staff = await api('/api/staff');
  $('#apply-room-no').textContent = r.room_no;
  $('#apply-room-meta').textContent =
    `${r.type_name} · 已住 ${r.registered_guests}/${r.fire_capacity} 人 · 空间可加 ${r.max_extra_beds} 张 · 现已有 ${r.extra_beds} 张`;
  const form = $('#apply-form');
  form.room_id.value = r.id;
  form.beds.value = 1;
  form.planned_nights.value = 2;
  $('#apply-operator').innerHTML = state.staff.filter((s) => s.role === 'front_desk')
    .map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  const quote = () => {
    const beds = Number(form.beds.value || 0);
    const nights = Number(form.planned_nights.value || 0);
    $('#apply-quote').innerHTML = `<div class="quote-box">原报价：<span class="orig">${yuan(r.nightly_fee)} × ${beds} 张 × ${nights} 晚 = ${yuan(r.nightly_fee * beds * nights)}</span><div class="note-line">报价将随申请留存，结算时保留。</div></div>`;
  };
  form.beds.oninput = quote; form.planned_nights.oninput = quote; quote();
  $('#apply-result').className = 'result'; $('#apply-result').textContent = '';
  $('#apply-modal').hidden = false;
}
$$('[data-close]').forEach((b) => b.addEventListener('click', () => $('#apply-modal').hidden = true));

$('#apply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const out = $('#apply-result');
  try {
    const res = await api('/api/apply', {
      room_id: Number(f.room_id.value),
      beds: Number(f.beds.value),
      planned_nights: Number(f.planned_nights.value),
      operator: f.operator.value
    });
    if (res.ok) {
      out.className = 'result ok';
      out.innerHTML = `✅ 申请通过（#${res.application_id}）。原报价合计 ${yuan(res.quoted_total)}，是否立即派单？
        <div class="modal-actions"><button type="button" class="btn green" id="do-dispatch">立即派单</button></div>`;
      $('#do-dispatch').onclick = async () => {
        try {
          const order = await api('/api/dispatch', { application_id: res.application_id });
          $('#apply-modal').hidden = true;
          toast(`已派单 #${order.id}，床架与布草已锁定`);
          await loadRooms();
          switchView('dispatch');
        } catch (err) { out.className = 'result err'; out.textContent = '派单失败：' + err.message; }
      };
    } else {
      const reasonCn = { occupancy: '入住人数超限', space: '房间空间不足', stock: '折叠床库存不足' }[res.reject_code] || res.reject_code;
      out.className = 'result err';
      out.innerHTML = `⛔ <b>${reasonCn}</b><br>${res.reject_reason}<br><span class="note-line">原报价 ${yuan(res.quoted_total)} 已随被拒申请留存。</span>`;
    }
  } catch (err) {
    out.className = 'result err';
    out.textContent = err.message;
  }
});

// ---------- 配送派单 ----------
async function loadOrders() { state.orders = await api('/api/orders'); }

function orderRow(o) {
  return `<div class="order-row ${state.currentOrder === o.id ? 'active' : ''}" data-order="${o.id}">
    <div><b>#${o.id} · 房 ${o.room ? o.room.room_no : ''}</b>
      <div class="meta">加床 ${o.beds} 张 · ${o.items ? o.items.length : 0} 件资产${o.claimed_by ? ' · ' + o.claimed_by : ''}</div></div>
    <span class="status-pill st-${o.status}">${STATUS_CN[o.status]}</span>
  </div>`;
}

function renderOrders() {
  const list = state.orders.filter((o) => ['dispatched', 'claimed', 'delivered', 'confirmed', 'settled'].includes(o.status));
  $('#orders-list').innerHTML = list.length ? list.map(orderRow).join('')
    : '<p class="muted">暂无配送单，先到房态页接受申请并派单。</p>';
  $$('#orders-list [data-order]').forEach((el) =>
    el.addEventListener('click', () => selectOrder(Number(el.dataset.order))));
  if (state.currentOrder) selectOrder(state.currentOrder, true);
}

async function selectOrder(id, keep) {
  state.currentOrder = id;
  const o = await api(`/api/orders/${id}`);
  $$('#orders-list .order-row').forEach((el) => el.classList.toggle('active', Number(el.dataset.order) === id));
  const attendants = state.staff.length ? state.staff : await api('/api/staff');
  const aOpts = attendants.filter((s) => s.role === 'attendant')
    .map((s) => `<option value="${s.id}">${s.name}</option>`).join('');

  const itemsTable = renderItemsTable(o, false);
  const photoBlock = o.accept_photo
    ? `<img class="photo-thumb" src="${o.accept_photo}" alt="验收照片" title="送达验收照片" />`
    : '<span class="muted">暂无验收照片</span>';

  let actions = '';
  if (o.status === 'dispatched') {
    actions = `
      <div class="quote-box"><b>房务员抢单</b>（两人同时认领只成功一次）
        <div style="display:flex;gap:8px;margin-top:8px">
          <select id="claim-staff">${aOpts}</select>
          <button class="btn green" id="btn-claim">认领配送单</button>
        </div></div>`;
  }
  if (['dispatched', 'claimed'].includes(o.status)) {
    actions += `
      <div class="quote-box photo-upload">配送送达 + 验收照片
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <label>📷 选择/拍照<input type="file" id="deliver-photo" accept="image/*" capture="environment" /></label>
          <button class="btn gold" id="btn-deliver">标记已送达</button>
        </div><div id="photo-preview"></div></div>`;
  }
  if (o.status === 'delivered') {
    actions = `<div class="quote-box">等待住客确认后计入房账。
      <button class="btn green block" style="margin-top:8px" id="btn-confirm">住客确认，计入房账</button></div>`;
  }

  $('#order-detail').innerHTML = `
    <dl class="kv">
      <dt>配送单号</dt><dd>#${o.id}</dd>
      <dt>房间</dt><dd>${o.room.room_no}</dd>
      <dt>加床</dt><dd>${o.beds} 张 / 共 ${o.items.length} 件</dd>
      <dt>状态</dt><dd><span class="status-pill st-${o.status}">${STATUS_CN[o.status]}</span></dd>
      <dt>认领人</dt><dd>${o.claimed_by || '—'}</dd>
      <dt>验收照片</dt><dd>${photoBlock}</dd>
    </dl>
    <h3 style="font-size:14px;color:var(--green-900)">床架与布草分项核对</h3>
    ${itemsTable}
    <div style="margin-top:14px">${actions}</div>`;

  wireOrderActions(o);
}

function renderItemsTable(o, editable, stateById) {
  const rows = o.items.map((it) => `
    <tr>
      <td><span class="kind-tag kind-${it.kind}">${KIND[it.kind]}</span></td>
      <td><b>${it.asset_code}</b></td>
      <td>${it.recover_condition
        ? ({ ok: '完好', damaged: '损坏', missing: '缺件' }[it.recover_condition] || it.recover_condition) +
          (it.recover_reason ? `<div class="note-line">${it.recover_reason}</div>` : '')
        : '在租中'}</td>
      ${editable ? `<td>${conditionRadios(it, stateById)}</td><td><input class="reason" data-reason="${it.id}" placeholder="缺件/损耗原因" /></td>
        <td class="photo-upload"><label>📷<input type="file" data-photo="${it.id}" accept="image/*" capture="environment" /></label></td>` : ''}
    </tr>`).join('');
  return `<table class="items">
    <thead><tr><th>类别</th><th>资产编号</th><th>回收状态</th>${editable ? '<th>结论</th><th>原因</th><th>照片</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function conditionRadios(it, st) {
  const cur = st[it.id] || 'ok';
  return `<div class="cond-group">
    ${[['ok', '完好'], ['damaged', '损坏'], ['missing', '缺件']].map(([v, label]) => `
      <label class="${v === 'ok' ? '' : 'bad'}">
        <input type="radio" name="cond-${it.id}" value="${v}" ${cur === v ? 'checked' : ''} data-cond="${it.id}"/>
        <span>${label}</span>
      </label>`).join('')}
  </div>`;
}

let pendingPhotos = {};
function wireOrderActions(o) {
  const claimBtn = $('#btn-claim');
  if (claimBtn) claimBtn.onclick = async () => {
    try {
      const r = await api(`/api/orders/${o.id}/claim`, { staff_id: $('#claim-staff').value });
      if (r.ok) toast(`✅ 已由 ${r.claimed_by} 认领`);
      else toast(`⛔ 该单已被 ${r.claimed_by} 认领，仅成功一次`, true);
      await loadOrders(); selectOrder(o.id);
    } catch (e) { toast(e.message, true); }
  };

  const dfile = $('#deliver-photo');
  if (dfile) dfile.onchange = () => {
    const f = dfile.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $('#photo-preview').innerHTML = `<img class="photo-thumb" src="${rd.result}" style="margin-top:8px" />`; dfile._data = rd.result; };
    rd.readAsDataURL(f);
  };
  const deliverBtn = $('#btn-deliver');
  if (deliverBtn) deliverBtn.onclick = async () => {
    try {
      const photo = dfile && dfile._data ? dfile._data : null;
      await api(`/api/orders/${o.id}/deliver`, { photo });
      toast('已标记送达，等待住客确认');
      await loadOrders(); selectOrder(o.id);
    } catch (e) { toast(e.message, true); }
  };

  const confirmBtn = $('#btn-confirm');
  if (confirmBtn) confirmBtn.onclick = async () => {
    try {
      await api(`/api/orders/${o.id}/confirm`, {});
      toast('住客已确认，费用已计入房账');
      await loadOrders(); selectOrder(o.id);
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- 退房回收 ----------
function renderCheckout() {
  const list = state.orders.filter((o) => ['confirmed', 'delivered'].includes(o.status));
  $('#checkout-list').innerHTML = list.length ? list.map(orderRow).join('')
    : '<p class="muted">没有待回收的加床单。</p>';
  $$('#checkout-list [data-order]').forEach((el) =>
    el.addEventListener('click', () => selectCheckout(Number(el.dataset.order))));
}

async function selectCheckout(id) {
  state.currentOrder = id;
  const o = await api(`/api/orders/${id}`);
  $$('#checkout-list .order-row').forEach((el) => el.classList.toggle('active', Number(el.dataset.order) === id));
  if (!state.staff.length) state.staff = await api('/api/staff');
  const fdOpts = state.staff.filter((s) => s.role === 'front_desk').map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  const atOpts = state.staff.filter((s) => s.role === 'attendant').map((s) => `<option value="${s.id}">${s.name}</option>`).join('');

  const cond = {};
  o.items.forEach((it) => { cond[it.id] = 'ok'; });
  pendingPhotos = {};

  $('#checkout-detail').innerHTML = `
    <dl class="kv">
      <dt>配送单</dt><dd>#${o.id} · 房 ${o.room.room_no}</dd>
      <dt>借出资产</dt><dd>${o.items.length} 件（床架 ${o.items.filter((i) => i.kind === 'frame').length} / 被褥 ${o.items.filter((i) => i.kind === 'bedding').length} / 枕头 ${o.items.filter((i) => i.kind === 'pillow').length}）</dd>
    </dl>
    <div style="overflow-x:auto">${renderItemsTable(o, true, cond)}</div>

    <div class="quote-box" style="margin-top:14px">
      <b>回收情形</b>
      <div class="cond-group" style="margin-top:6px">
        <label><input type="radio" name="endkind" value="checkout" checked /><span>退房回收</span></label>
        <label class="bad"><input type="radio" name="endkind" value="early_remove" /><span>提前撤床</span></label>
      </div>
      <div class="note-line">跨夜测试：可指定实际回收时间（默认现在）。
        <input type="datetime-local" id="settle-time" style="margin-top:6px" /></div>
    </div>

    <div class="quote-box photo-upload" style="margin-top:10px">
      <label style="text-decoration:none">
        <input type="checkbox" id="cross-demo" /> 模拟跨夜续住：回收时间设为 4 晚后
      </label>
    </div>

    <div id="live-summary" class="summary"></div>

    <div style="display:flex;gap:10px;margin-top:12px;align-items:center">
      <select id="settle-operator" style="max-width:180px">
        <optgroup label="房务员（无权减免）">${atOpts}</optgroup>
        <optgroup label="前台（可减免/调价）">${fdOpts}</optgroup>
      </select>
      <button class="btn gold" id="btn-settle">逐件回收并结算</button>
    </div>
    <div class="result" id="settle-result"></div>`;

  // 交互：结论/原因/照片/时间 -> 实时汇总
  const recalc = () => renderSummary(o);
  $$('[data-cond]').forEach((r) => r.addEventListener('change', (e) => {
    cond[Number(e.target.dataset.cond)] = e.target.value; recalc();
  }));
  $$('[data-photo]').forEach((inp) => inp.addEventListener('change', () => {
    const f = inp.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { pendingPhotos[Number(inp.dataset.photo)] = rd.result; };
    rd.readAsDataURL(f);
  }));
  $('#cross-demo').addEventListener('change', (e) => {
    const t = $('#settle-time');
    if (e.target.checked) {
      const d = new Date(Date.now() + 4 * 86400000 - new Date().getTimezoneOffset() * 60000);
      t.value = d.toISOString().slice(0, 16);
    } else t.value = '';
    recalc();
  });
  $('#settle-time').addEventListener('change', recalc);

  $('#btn-settle').onclick = () => doSettle(o, cond);
  renderSummary(o);
}

// 费用预估（与后端一致的展示口径）
async function renderSummary(o) {
  // 取申请原报价与计划夜数
  const apps = state._apps || (state._apps = await api('/api/applications'));
  const app = apps.find((a) => a.id === o.application_id);
  const perNight = app.quoted_nightly;
  const planned = app.planned_nights;
  const start = o.confirmed_at || o.delivered_at;
  let end = $('#settle-time') ? $('#settle-time').value : '';
  let nights;
  if (end) nights = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / 86400000));
  else nights = Math.max(1, Math.ceil((Date.now() - new Date(start)) / 86400000));
  const bedFee = perNight * o.beds * nights;

  const conds = {};
  $$('[data-cond]:checked').forEach((r) => { conds[Number(r.dataset.cond)] = r.value; });
  const reasons = {};
  $$('[data-reason]').forEach((i) => { reasons[Number(i.dataset.reason)] = i.value; });

  const FEE = { frame: { damaged: 800, missing: 1200 }, bedding: { damaged: 120, missing: 300 }, pillow: { damaged: 40, missing: 100 } };
  let damage = 0, linen = 0;
  const missingKinds = [];
  for (const it of o.items) {
    const c = conds[it.id] || 'ok';
    if (c === 'damaged') { if (it.kind === 'frame') damage += 800; else linen += FEE[it.kind].damaged; }
    if (c === 'missing') { if (it.kind === 'frame') damage += 1200; else { linen += FEE[it.kind].missing; missingKinds.push(KIND[it.kind] + ' ' + it.asset_code); } }
  }
  const total = bedFee + damage + linen;
  const cross = nights > planned;

  // 缺件原因校验提示
  let reasonWarn = '';
  for (const it of o.items) {
    if ((conds[it.id] === 'damaged' || conds[it.id] === 'missing') && !(reasons[it.id] || '').trim()) {
      reasonWarn = `⚠️ ${KIND[it.kind]} ${it.asset_code} 需填写缺件/损耗原因`;
    }
  }

  $('#live-summary').innerHTML = `
    <div class="sum-row"><span>实际过夜 ${nights} 晚（计划 ${planned} 晚）${cross ? '<span class="crossflag"> · 跨夜续住</span>' : ''}</span><span class="amt">${yuan(bedFee)}</span></div>
    ${damage ? `<div class="sum-row charge"><span>床架损坏/遗失</span><span class="amt">+${yuan(damage)}</span></div>` : ''}
    ${linen ? `<div class="sum-row charge"><span>布草缺件/污损${missingKinds.length ? '（' + missingKinds.join('、') + '）' : ''}</span><span class="amt">+${yuan(linen)}</span></div>` : ''}
    <div class="sum-row total"><span>应收合计</span><span class="amt">${yuan(total)}</span></div>
    <div class="note-line">原报价合计 ${yuan(app.quoted_total)}（前台调价时保留，不覆盖）</div>
    ${reasonWarn ? `<div class="result err" style="margin-top:8px">${reasonWarn}</div>` : ''}`;
}

async function doSettle(o, cond) {
  const out = $('#settle-result');
  const operator = $('#settle-operator').value;
  const endKind = ($$('[name=endkind]:checked')[0] || {}).value || 'checkout';
  const results = o.items.map((it) => ({
    item_id: it.id,
    condition: ($$(`[name=cond-${it.id}]:checked`)[0] || {}).value || 'ok',
    reason: ($(`[data-reason="${it.id}"]`) || {}).value || '',
    photo: pendingPhotos[it.id] || null
  }));
  // 缺件/损坏必须有原因
  const bad = results.find((r) => r.condition !== 'ok' && !r.reason.trim());
  if (bad) { out.className = 'result err'; out.textContent = '缺件/损耗必须填写原因'; return; }

  const payload = { results, end_kind: endKind, operator };
  const tv = $('#settle-time').value;
  if (tv) payload.settled_at = new Date(tv).toISOString();

  try {
    const r = await api(`/api/orders/${o.id}/settle`, payload);
    out.className = 'result ok';
    out.innerHTML = `✅ 已回收结算 #${r.settlement_id}：实际 ${r.nights} 晚${r.cross_night ? '（跨夜续住）' : ''}，
      床位费 ${yuan(r.bed_fee)}，损坏 ${yuan(r.damage_fee)}，布草 ${yuan(r.linen_fee)}，
      <b>应收 ${yuan(r.payable)}</b>（原报价 ${yuan(r.original_quote_total)} 已保留）。`;
    await loadOrders(); renderCheckout();
    // 结算后可由前台调价
    setTimeout(() => showAdjust(o.id, r), 200);
  } catch (e) {
    out.className = 'result err';
    out.textContent = '结算失败：' + e.message + (e.data && e.data.error ? '' : '');
  }
}

async function showAdjust(orderId, settlement) {
  const o = await api(`/api/orders/${orderId}`);
  const fd = state.staff.find((s) => s.role === 'front_desk');
  const el = document.createElement('div');
  el.className = 'quote-box';
  el.style.marginTop = '12px';
  el.innerHTML = `
    <b>前台调价</b>（原报价保留，仅记录调整后金额与原因）
    <div style="display:flex;gap:8px;margin-top:8px">
      <input type="number" id="adj-amt" value="${settlement.payable}" min="0" />
      <input type="text" id="adj-note" placeholder="调价原因" />
      <button class="btn green" id="adj-btn">保存调价</button>
    </div>
    <div class="note-line">标准应收 ${yuan(settlement.payable)}，差异将以调整项计入模拟房账。</div>`;
  $('#settle-result').after(el);
  $('#adj-btn').onclick = async () => {
    try {
      const s = await api(`/api/orders/${orderId}/adjust`, {
        adjusted_total: Number($('#adj-amt').value),
        note: $('#adj-note').value, operator: fd.id
      });
      toast(`已保存调价，最终 ${yuan(s.adjusted_total)}；原报价 ${yuan(s.original_quote_total)} 不变`);
      el.remove();
    } catch (e) { toast(e.message, true); }
  };
}

// 初始化
(async function init() {
  state.staff = await api('/api/staff');
  await loadRooms();
})();
