// 通用工具
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

function yuan(cents) {
  const v = Math.abs(cents) / 100;
  return (cents < 0 ? "-￥" : "￥") + v.toFixed(2);
}

const STATUS_LABELS = {
  submitted: ["待派单", "badge-gold"],
  rejected: ["已驳回", "badge-red"],
  assigned: ["已派单", "badge-green"],
  delivered: ["已送达", "badge-green"],
  confirmed: ["住客已确认", "badge-green"],
  early_removed: ["提前撤床", "badge-gray"],
  checked_out: ["已退房结算", "badge-gray"],
  pending: ["待认领", "badge-gold"],
  claimed: ["已认领", "badge-green"],
  recovered: ["已回收", "badge-gray"],
};

function badge(status) {
  const [text, cls] = STATUS_LABELS[status] || [status, "badge-gray"];
  return `<span class="badge ${cls}">${text}</span>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, ok = false) {
  let box = document.querySelector(".toast");
  if (!box) {
    box = document.createElement("div");
    box.className = "toast";
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = "t " + (ok ? "ok" : "err");
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

function runWithToast(promise, okMsg, after) {
  return promise
    .then((r) => { toast(okMsg, true); after && after(r); return r; })
    .catch((e) => { toast(e.message); throw e; });
}
