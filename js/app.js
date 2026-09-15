/* ระบบสั่งอาหาร QR — one shop QR, four screens.
 *
 * customer  scan -> service type -> table -> menu -> cart -> track
 * owner     accept orders, floor plan, close bills          (staff / staff123)
 * manager   dashboard, menu, promotions, expenses           (owner / owner123)
 * kitchen   two-column food + drink prep queue              (kitchen / kitchen123)
 *
 * State lives in S; every mutation calls render(), which rebuilds #root and
 * rebinds through delegation. Text inputs update S without re-rendering, so
 * typing never loses the caret.
 */
'use strict';

/* ── design tokens used as values ──────────────────────────── */
const INK = 'var(--color-text)';
const GROUND = 'var(--color-bg)';
const SURF = 'var(--color-surface)';
const RED = 'var(--color-accent)';
const PAPER = 'var(--color-neutral-100)';

/* ── per-browser client identity ──────────────────────────────
 * No login is required to order, so "which orders are mine" is tracked by a
 * random id stashed in localStorage rather than a server session. */
const CLIENT_ID = (() => {
  const KEY = 'qr_client_id';
  let v = localStorage.getItem(KEY);
  if (!v) { v = crypto.randomUUID(); localStorage.setItem(KEY, v); }
  return v;
})();

/* Staff logins survive a refresh via the same localStorage pattern — no
 * server session, so this is just remembering which role was last signed in. */
const ROLE_KEY = 'qr_role';

/* ── server API ────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { 'X-Client-Id': CLIENT_ID } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) throw new Error((data && data.detail) || (res.status + ' ' + res.statusText));
  return data;
}

/** Runs a mutating API call, reconciles shared state from the server, and
 *  surfaces any failure as a toast instead of leaving the UI stuck. */
async function mutate(promise, successMsg) {
  try {
    await promise;
    await refreshState();
    if (successMsg) flash(successMsg);
  } catch (e) {
    flash(e.message || 'เกิดข้อผิดพลาด — ลองใหม่อีกครั้ง');
  }
}

const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function uploadMenuPhoto(itemId, file) {
  const t = T();
  if (!PHOTO_TYPES.includes(file.type)) { flash(t.photoBadType); return; }
  if (file.size > PHOTO_MAX_BYTES) { flash(t.photoTooBig); return; }
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(`/api/menu/${itemId}/photo`, {
      method: 'POST', headers: { 'X-Client-Id': CLIENT_ID }, body: fd
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail || t.photoUploadFailed);
    await refreshState();
    flash(t.tSaved);
  } catch (e) {
    flash(e.message || t.photoUploadFailed);
  }
}

/* ── state ─────────────────────────────────────────────────── */
const S = {
  booted: false,
  role: localStorage.getItem(ROLE_KEY) || 'customer', lang: 'th', cust: 'home', ownerTab: 'queue', adminTab: 'master',
  service: 'dinein', tableNo: 0, custName: '', custPhone: '',
  cat: 'rec', openId: null, itemQty: 1, itemLevel: 1, itemExtras: [], itemNote: '',
  cart: [], orderNote: '', myId: null, editingId: null,
  billId: null, slip: null, cancelAsk: false, toast: '',
  salesToday: 0, qdId: null, swapOrderId: null, swapLineIdx: null,
  loginOpen: false, loginUser: '', loginPass: '', loginError: '', menuOpen: false,
  readyAlerts: [],

  /* everything below is shared, server-owned state — refreshed by applyState() */
  shopName: '', prefixes: [], cats: [], menu: [], users: [], promos: [], expenses: [], orders: [],

  f: {
    prefixTh: '', prefixEn: '', catTh: '', catEn: '',
    userName: '', userRole: 'server', userPhone: '',
    menuTh: '', menuEn: '', menuCat: 'rice', menuPrice: '', menuHasSpice: true,
    promoName: '', promoValue: '',
    expDate: new Date().toISOString().slice(0, 10), expCat: 'วัตถุดิบ', expNote: '', expAmount: ''
  }
};

/** Merges the server snapshot into S without touching local-only UI state
 *  (cart draft, which screen is open, form drafts, modals). */
function applyState(data) {
  Object.assign(S, {
    shopName: data.shopName, salesToday: data.salesToday,
    prefixes: data.prefixes, cats: data.categories, menu: data.menu,
    users: data.users, promos: data.promos, expenses: data.expenses, orders: data.orders
  });
}

let lastSnapshot = '';

/** Returns true only when the fetched data actually differs from what's on
 *  screen — the poll loop uses this to skip render() (and the DOM rebuild +
 *  animation restarts that come with it) on the common case where nothing
 *  changed since the last tick. */
async function refreshState() {
  const data = await api('GET', '/api/state');
  const snapshot = JSON.stringify(data);
  const changed = snapshot !== lastSnapshot;
  lastSnapshot = snapshot;
  applyState(data);
  detectReadyTransitions();
  return changed;
}

/** Per-browser memory of each order's last-seen combined status, kept outside
 *  S since it's bookkeeping for the alert below, not something a screen renders
 *  directly. Only a live 'ready' transition observed *while this tab is open*
 *  fires an alert — an order that's already ready on first load does not. */
let prevOrderStatus = {};

function detectReadyTransitions() {
  const next = {};
  S.orders.forEach(o => {
    const key = ostatus(o);
    next[o.id] = key;
    if (S.role === 'owner' && key === 'ready' && prevOrderStatus[o.id] && prevOrderStatus[o.id] !== 'ready') {
      pushReadyAlert(o);
    }
  });
  prevOrderStatus = next;
}

function pushReadyAlert(o) {
  const key = o.id + ':' + Date.now();
  S.readyAlerts = S.readyAlerts.concat([{ key, orderId: o.id, where: whereOf(o) }]);
  playReadyChime();
  setTimeout(() => {
    S.readyAlerts = S.readyAlerts.filter(a => a.key !== key);
    render();
  }, 6000);
}

/* A short two-tone chime for the ready-to-serve alert. Browsers only allow
 * audio after a user gesture, so the AudioContext is created lazily on the
 * page's first click (see the unlockAudio listener near boot()) — if that
 * hasn't happened yet, this just silently does nothing. */
let audioCtx = null;
function playReadyChime() {
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.24);
    });
  } catch (_) { /* audio is a nicety, never block on it */ }
}

/* ── helpers ───────────────────────────────────────────────── */
const T = () => (S.lang === 'th' ? TH : EN);
const L = o => (S.lang === 'th' ? o.th : o.en);
const baht = n => '฿' + Number(n || 0).toLocaleString('en-US');
const uid = p => p + Math.random().toString(36).slice(2, 7);
const dict = id => S.menu.find(m => m.id === id) || { id, th: '(ลบแล้ว)', en: '(removed)', price: 0, kind: 'food' };
const lineTotal = l => l.price * l.qty;
const orderTotal = o => o.lines.reduce((s, l) => s + lineTotal(l), 0);
const hasKind = (o, k) => o.lines.some(l => l.kind === k);
const findOrder = id => S.orders.find(o => o.id === id);

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function optText(l) {
  const t = T();
  const parts = (l.opts || []).map(L);
  if (parts.length) return parts.join(' · ');
  return l.kind === 'drink' ? t.sweet + ': ' + t.standard : '—';
}

/** Drinks offer a sweetness pick, food a spice-level pick — both gated by the
 *  same "has options" flag, off for items like plain bottled water. */
function levelInfo(m) {
  if (m.kind === 'drink') return { show: m.hasSpice !== false, list: SWEET, title: T().sweet };
  return { show: m.hasSpice !== false, list: SPICE, title: T().spice };
}

/** Overall status of an order: while accepted, the slowest station wins. */
function ostatus(o) {
  if (o.st !== 'accepted') return o.st;
  const ks = ['food', 'drink'].filter(k => hasKind(o, k)).map(k => o[k]);
  if (ks.length && ks.every(s => s === 'ready')) return 'ready';
  return 'accepted';
}

function statusChip(key, type) {
  const t = T(), takeaway = type !== 'dinein';
  const map = {
    new:       { label: t.sNew,      bg: 'var(--color-accent-200)', fg: 'var(--color-accent-700)' },
    accepted:  { label: t.sAccepted, bg: SURF, fg: INK },
    ready:     { label: takeaway ? t.sReadyTake : t.sReady, bg: INK, fg: GROUND },
    closed:    { label: t.sClosed,   bg: 'var(--color-neutral-300)', fg: 'var(--color-neutral-700)' },
    cancelled: { label: t.sCancelled, bg: PAPER, fg: 'var(--color-neutral-500)' },
    queued:    { label: t.sQueued,   bg: SURF, fg: INK }
  };
  return map[key] || map.accepted;
}

function etaFor(key) {
  const t = T();
  return key === 'new' ? t.etaNew : key === 'accepted' ? t.etaAccepted
    : key === 'ready' ? t.etaReady
    : key === 'closed' ? t.etaClosed : t.etaCancelled;
}

function stepsFor(o) {
  const t = T(), key = ostatus(o);
  const seq = ['accepted', 'ready', 'closed'];
  const cur = key === 'new' ? -1 : seq.indexOf(key);
  const labels = [t.sAccepted, o.type === 'dinein' ? t.sReady : t.sReadyTake, t.sClosed];
  const times = [o.acceptedAt || '—', o.readyAt || '—', o.closedAt || '—'];
  return labels.map((label, i) => {
    const done = i < cur, now = i === cur;
    return {
      label, num: String(i + 1), time: times[i], w: now ? 800 : 500,
      bg: done ? INK : now ? RED : 'transparent',
      fg: done || now ? GROUND : 'var(--color-neutral-500)',
      ring: done ? INK : now ? RED : 'var(--color-neutral-400)',
      line: done ? INK : 'var(--color-neutral-300)',
      textFg: done || now ? INK : 'var(--color-neutral-500)'
    };
  });
}

const whereOf = o => (o.type === 'dinein' ? T().tableLabel + ' ' + o.table : T().takeaway);
const typeLabel = type => (type === 'dinein' ? T().dinein : T().takeaway);
const summaryOf = o => o.lines.map(l => l.qty + '× ' + L(dict(l.id))).join(', ');
const roleLabelOf = r => (r === 'server' ? T().rServer : r === 'kitchen' ? T().rKitchen : T().rBar);
const catLabelOf = id => { const c = S.cats.find(x => x.id === id); return c ? L(c) : '—'; };

let toastTimer = null;
function flash(msg) {
  clearTimeout(toastTimer);
  S.toast = msg;
  toastTimer = setTimeout(() => { S.toast = ''; render(); }, 2600);
}

function myOrder() {
  return S.orders.find(o => o.id === S.myId)
    || S.orders.find(o => o.mine && o.st !== 'closed')
    || null;
}

/* ── derived views ─────────────────────────────────────────── */
const orderSeq = id => Number(String(id).replace(/^\D+/, '')) || 0;
/** Oldest pending order first — position 1 is genuinely "next up", and each
 *  newly placed order queues in behind whoever is already waiting. */
const queueOrders = () => S.orders
  .filter(o => o.st === 'new' || o.st === 'accepted')
  .sort((a, b) => orderSeq(a.id) - orderSeq(b.id));
const openBillOrders = () => S.orders.filter(o => o.st === 'accepted' || o.st === 'new');
const cartCount = () => S.cart.reduce((a, l) => a + l.qty, 0);
const cartSum = () => S.cart.reduce((a, l) => a + lineTotal(l), 0);
const tableBusy = no => S.orders.some(o => o.type === 'dinein' && o.table === no && (o.st === 'new' || o.st === 'accepted'));

function currentBill() {
  const open = openBillOrders();
  return open.find(o => o.id === S.billId) || open[0] || S.orders[0] || null;
}

/* ── actions ───────────────────────────────────────────────── */
function openItem(id) {
  Object.assign(S, { cust: 'item', openId: id, itemQty: 1, itemLevel: 1, itemExtras: [], itemNote: '' });
}

function addToCart() {
  const m = dict(S.openId);
  const li = levelInfo(m);
  const exList = m.kind === 'drink' ? EX_DRINK : EX_FOOD;
  const chosen = exList.filter(e => S.itemExtras.includes(e.id));
  const price = m.price + chosen.reduce((a, e) => a + e.p, 0);
  const opts = (li.show ? [li.list[S.itemLevel]] : []).concat(chosen.map(e => ({ th: e.th, en: e.en })));
  S.cart = S.cart.concat([{ id: m.id, qty: S.itemQty, price, kind: m.kind, note: S.itemNote.trim(), opts }]);
  S.cust = 'menu';
  flash(T().tAddedCart);
}

async function submitOrder() {
  const t = T();
  if (!S.cart.length) return;
  if (S.service === 'dinein' && !S.tableNo) { S.cust = 'table'; flash(t.pickTableFirst); return; }

  if (S.editingId) {
    const editingId = S.editingId;
    try {
      await api('PATCH', `/api/orders/${editingId}`, {
        lines: S.cart, note: S.orderNote, custName: S.custName, custPhone: S.custPhone
      });
      Object.assign(S, { cart: [], myId: editingId, editingId: null, cust: 'track' });
      await refreshState();
      flash(t.tSent);
    } catch (e) {
      flash(e.message || 'ส่งออเดอร์ไม่สำเร็จ');
    }
    return;
  }

  try {
    const order = await api('POST', '/api/orders', {
      service: S.service, tableNo: S.tableNo, custName: S.custName, custPhone: S.custPhone,
      note: S.orderNote, lines: S.cart
    });
    Object.assign(S, { myId: order.id, cart: [], cust: 'track', ownerTab: 'queue' });
    await refreshState();
    flash(t.tSent);
  } catch (e) {
    await refreshState();
    if (e.message === 'table_taken') {
      Object.assign(S, { tableNo: 0, cust: 'table' });
      flash(t.tableTakenError);
    } else {
      flash(e.message || 'ส่งออเดอร์ไม่สำเร็จ');
    }
  }
}

/** Owner swaps a sold-out line for another item from the same station. */
async function doSwap(orderId, lineIdx, newId) {
  if (!newId) return;
  S.swapOrderId = null;
  S.swapLineIdx = null;
  await mutate(api('POST', `/api/orders/${orderId}/swap`, { lineIdx, newId }), T().tMenuSwapped);
}

const ACT = {
  /* header + shell */
  lang: el => { S.lang = el.dataset.v; },
  toggleNav: () => { S.menuOpen = !S.menuOpen; },
  closeNav: () => { S.menuOpen = false; },
  navOrder: () => { S.cust = 'home'; S.menuOpen = false; },
  exitStaff: () => { S.role = 'customer'; S.menuOpen = false; localStorage.removeItem(ROLE_KEY); },
  openLogin: () => Object.assign(S, { loginOpen: true, loginUser: '', loginPass: '', loginError: '', menuOpen: false }),
  cancelLogin: () => Object.assign(S, { loginOpen: false, loginError: '' }),
  doLogin: async () => {
    const username = S.loginUser, password = S.loginPass;
    try {
      const { role } = await api('POST', '/api/login', { username, password });
      localStorage.setItem(ROLE_KEY, role);
      Object.assign(S, {
        role, loginOpen: false, loginUser: '', loginPass: '', loginError: '',
        adminTab: role === 'manager' ? 'dash' : S.adminTab
      });
    } catch (e) {
      S.loginError = T().loginInvalid;
    }
  },

  /* customer navigation */
  go: el => { S.cust = el.dataset.v; },
  goTable: () => Object.assign(S, { cust: 'table', service: 'dinein' }),
  service: el => { S.service = el.dataset.v; },
  setTable: el => { S.tableNo = Number(el.dataset.v) || 0; },
  startFlow: () => {
    if (S.service === 'dinein' && !S.tableNo) { flash(T().pickTableFirst); return; }
    S.cust = 'menu';
  },
  cat: el => { S.cat = el.dataset.v; },
  openItem: el => openItem(el.dataset.id),

  /* item detail */
  level: el => { S.itemLevel = Number(el.dataset.i); },
  extra: el => {
    const id = el.dataset.id;
    S.itemExtras = S.itemExtras.includes(id) ? S.itemExtras.filter(x => x !== id) : S.itemExtras.concat([id]);
  },
  qty: el => {
    const d = Number(el.dataset.v);
    S.itemQty = Math.min(20, Math.max(1, S.itemQty + d));
  },
  addToCart,

  /* cart */
  lineQty: el => {
    const i = Number(el.dataset.i), d = Number(el.dataset.v);
    S.cart = S.cart.map((x, j) => (j === i ? { ...x, qty: Math.max(1, x.qty + d) } : x));
  },
  lineRemove: el => { const i = Number(el.dataset.i); S.cart = S.cart.filter((x, j) => j !== i); },
  submit: submitOrder,

  /* tracking */
  editOrder: () => {
    const mo = myOrder();
    if (!mo || trackLocked(mo)) return;
    Object.assign(S, { cart: mo.lines.map(l => ({ ...l })), orderNote: mo.note || '', editingId: mo.id, cust: 'cart' });
    flash(T().tEdit);
  },
  askCancel: () => { const mo = myOrder(); if (mo && !trackLocked(mo)) S.cancelAsk = true; },
  closeCancel: () => { S.cancelAsk = false; },
  doCancel: () => {
    const mo = myOrder();
    S.cancelAsk = false;
    if (!mo) return;
    return mutate(api('POST', `/api/orders/${mo.id}/cancel`), T().tCancelled);
  },
  reorder: el => {
    const o = findOrder(el.dataset.id);
    if (!o) return;
    Object.assign(S, { cart: o.lines.map(l => ({ ...l })), cust: 'cart', editingId: null });
    flash(T().tReorder);
  },

  /* queue detail modal */
  openQd: el => { S.qdId = el.dataset.id; },
  closeQd: () => Object.assign(S, { qdId: null, swapOrderId: null, swapLineIdx: null }),
  openSwap: el => Object.assign(S, { swapOrderId: el.dataset.id, swapLineIdx: Number(el.dataset.i) }),
  closeSwap: () => Object.assign(S, { swapOrderId: null, swapLineIdx: null }),
  qdStatus: el => {
    const id = el.dataset.id, key = el.dataset.v;
    S.qdId = null;
    return mutate(api('POST', `/api/orders/${id}/status`, { key }), T().tSaved);
  },

  /* owner */
  ownerTab: el => { S.ownerTab = el.dataset.v; },
  accept: el => mutate(api('POST', `/api/orders/${el.dataset.id}/accept`), T().tAccepted),
  reject: el => mutate(api('POST', `/api/orders/${el.dataset.id}/reject`), T().tRejected),
  tableAction: el => {
    const o = findOrder(el.dataset.id);
    if (!o) return;
    Object.assign(S, { ownerTab: 'bill', billId: o.id });
  },
  pickBill: el => { S.billId = el.dataset.id; },
  pickBillGo: el => { Object.assign(S, { ownerTab: 'bill', billId: el.dataset.id }); },
  dismissReadyAlert: el => { S.readyAlerts = S.readyAlerts.filter(a => a.key !== el.dataset.key); },
  print: el => {
    const id = el.dataset.id || (currentBill() && currentBill().id);
    if (id) S.slip = { id, station: el.dataset.v };
  },
  closeSlip: () => { S.slip = null; },
  confirmPrint: () => { S.slip = null; flash(T().tPrinted); },
  closeBill: () => {
    const bo = currentBill();
    if (!bo || ostatus(bo) !== 'ready') return;
    return mutate(api('POST', `/api/orders/${bo.id}/close`), T().tClosed);
  },

  /* kitchen */
  kAdvance: el => {
    const o = findOrder(el.dataset.id), kind = el.dataset.v;
    if (!o || o[kind] === 'ready') return;
    return mutate(api('POST', `/api/orders/${o.id}/station`, { kind, action: 'advance' }), T().tReady);
  },
  kUndo: el => {
    const o = findOrder(el.dataset.id), kind = el.dataset.v;
    if (!o) return;
    return mutate(api('POST', `/api/orders/${o.id}/station`, { kind, action: 'undo' }));
  },

  /* admin */
  adminTab: el => { S.adminTab = el.dataset.v; },
  addPrefix: () => {
    const th = S.f.prefixTh.trim();
    if (!th) return;
    const en = S.f.prefixEn.trim();
    S.f.prefixTh = ''; S.f.prefixEn = '';
    return mutate(api('POST', '/api/prefixes', { th, en }), T().tSaved);
  },
  delPrefix: el => mutate(api('DELETE', `/api/prefixes/${el.dataset.id}`), T().tDeleted),
  addCat: () => {
    const th = S.f.catTh.trim();
    if (!th) return;
    const en = S.f.catEn.trim();
    S.f.catTh = ''; S.f.catEn = '';
    return mutate(api('POST', '/api/categories', { th, en }), T().tSaved);
  },
  delCat: el => mutate(api('DELETE', `/api/categories/${el.dataset.id}`), T().tDeleted),
  cycleUserRole: () => {
    const seq = ['server', 'kitchen', 'bar'];
    S.f.userRole = seq[(seq.indexOf(S.f.userRole) + 1) % seq.length];
  },
  addUser: () => {
    const name = S.f.userName.trim();
    if (!name) return;
    const role = S.f.userRole, phone = S.f.userPhone.trim();
    S.f.userName = ''; S.f.userPhone = '';
    return mutate(api('POST', '/api/users', { name, role, phone }), T().tSaved);
  },
  toggleUser: el => {
    const u = S.users.find(x => x.id === el.dataset.id);
    if (!u) return;
    return mutate(api('PATCH', `/api/users/${u.id}`, { active: !u.active }));
  },
  delUser: el => mutate(api('DELETE', `/api/users/${el.dataset.id}`), T().tDeleted),
  cycleMenuCat: () => {
    const ids = S.cats.map(c => c.id);
    if (!ids.length) return;
    S.f.menuCat = ids[(ids.indexOf(S.f.menuCat) + 1) % ids.length];
  },
  addMenuItem: () => {
    const th = S.f.menuTh.trim(), price = parseInt(S.f.menuPrice, 10);
    if (!th || !price) return;
    const en = S.f.menuEn.trim(), cat = S.f.menuCat, hasSpice = S.f.menuHasSpice;
    S.f.menuTh = ''; S.f.menuEn = ''; S.f.menuPrice = '';
    return mutate(api('POST', '/api/menu', { th, en, cat, price, hasSpice }), T().tSaved);
  },
  toggleMenu: el => {
    const m = S.menu.find(x => x.id === el.dataset.id);
    if (!m) return;
    return mutate(api('PATCH', `/api/menu/${m.id}`, { available: !m.available }));
  },
  delMenu: el => mutate(api('DELETE', `/api/menu/${el.dataset.id}`), T().tDeleted),
  addPromo: () => {
    const th = S.f.promoName.trim();
    if (!th) return;
    const value = parseInt(S.f.promoValue, 10) || 0;
    S.f.promoName = ''; S.f.promoValue = '';
    return mutate(api('POST', '/api/promos', { th, value }), T().tSaved);
  },
  togglePromo: el => {
    const p = S.promos.find(x => x.id === el.dataset.id);
    if (!p) return;
    return mutate(api('PATCH', `/api/promos/${p.id}`, { active: !p.active }));
  },
  togglePromoDay: el => mutate(api('PATCH', `/api/promos/${el.dataset.id}`, { toggleDay: Number(el.dataset.i) })),
  delPromo: el => mutate(api('DELETE', `/api/promos/${el.dataset.id}`), T().tDeleted),
  cycleExpCat: () => { S.f.expCat = EXP_CATS[(EXP_CATS.indexOf(S.f.expCat) + 1) % EXP_CATS.length]; },
  addExpense: () => {
    const amount = parseInt(S.f.expAmount, 10);
    if (!amount || !S.f.expDate) return;
    const date = S.f.expDate, cat = S.f.expCat, note = S.f.expNote.trim();
    S.f.expNote = ''; S.f.expAmount = '';
    return mutate(api('POST', '/api/expenses', { date, cat, note, amount }), T().tSaved);
  },
  delExpense: el => mutate(api('DELETE', `/api/expenses/${el.dataset.id}`), T().tDeleted)
};

/** A guest may edit or cancel only until the shop accepts the order. */
function trackLocked(o) {
  if (!o) return true;
  const key = ostatus(o);
  return ['accepted', 'ready', 'closed', 'cancelled'].includes(key);
}

/* Text fields write straight to state — no re-render, so the caret stays put. */
const INP = {
  itemNote: v => { S.itemNote = v; },
  orderNote: v => { S.orderNote = v; },
  custName: v => { S.custName = v; },
  custPhone: v => { S.custPhone = v; },
  loginUser: v => { S.loginUser = v; },
  loginPass: v => { S.loginPass = v; }
};

/* ── rendering ─────────────────────────────────────────────── */
const tabColors = on => `background:${on ? INK : 'transparent'};color:${on ? GROUND : INK}`;
const ico = d => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICON_HOME = 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
const ICON_CLOCK = '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>';
const ICON_CART = '<circle cx="8" cy="21" r="1"></circle><circle cx="19" cy="21" r="1"></circle><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 2-1.75l1.65-9.25H5.12"></path>';
const ICON_BAG = '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path>';
const ICON_LOGIN = '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" y1="12" x2="3" y2="12"></line>';
const ICON_EXIT = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>';
const ICON_BADGE = '<path d="M20.618 5.984A11 11 0 0 0 3.382 5.984"></path><circle cx="12" cy="12" r="4"></circle><path d="M12 2v4"></path>';
const ICON_PRINTER = '<polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect>';
const ICON_UTENSILS = '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"></path><path d="M7 2v20"></path><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"></path>';
const ICON_CUP = '<path d="M17 8h1a4 4 0 1 1 0 8h-1"></path><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"></path><line x1="6" y1="2" x2="6" y2="4"></line><line x1="10" y1="2" x2="10" y2="4"></line><line x1="14" y1="2" x2="14" y2="4"></line>';
const ICON_BELL = '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>';

function chipHtml(c) {
  return `<span class="chip" style="background:${c.bg};color:${c.fg}">${esc(c.label)}</span>`;
}

function stepsHtml(o, minLine) {
  return stepsFor(o).map(st => `
    <div class="step">
      <div class="step__rail">
        <div class="step__num" style="border:2px solid ${st.ring};background:${st.bg};color:${st.fg}">${st.num}</div>
        <div class="step__line" style="background:${st.line};min-height:${minLine}px"></div>
      </div>
      <div class="step__body">
        <div style="font-size:15px;font-weight:${st.w};color:${st.textFg}">${esc(st.label)}</div>
        <div style="font-size:12px;color:var(--color-neutral-600)">${esc(st.time)}</div>
      </div>
    </div>`).join('');
}

/* ── header ────────────────────────────────────────────────── */
function headerHtml() {
  const t = T(), isStaff = S.role !== 'customer';
  const badge = S.role === 'manager' ? t.roleOwner : S.role === 'admin' ? t.roleAdmin
    : S.role === 'owner' ? t.roleStaff : t.roleKitchen;
  return `
  <header class="hdr">
    <div class="hdr__row">
      <button class="hdr__burger" data-act="toggleNav" aria-label="Menu">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
      </button>
      <div class="hdr__spacer"></div>
      <div class="langsw langsw--sm">
        <button data-act="lang" data-v="th" style="${tabColors(S.lang === 'th')}">TH</button>
        <button data-act="lang" data-v="en" style="${tabColors(S.lang === 'en')}">EN</button>
      </div>
    </div>
    ${S.menuOpen ? `
    <div class="navDrawer">
      <div class="navDrawer__backdrop" data-act="closeNav"></div>
      <div class="navDrawer__panel">
        <div class="navDrawer__head">
          <div class="navDrawer__title">${esc(t.navMenuTitle)}</div>
          <button class="navDrawer__close" data-act="closeNav" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div class="navDrawer__body">
          ${isStaff ? `
          <div class="navDrawer__item navDrawer__item--info">
            <span class="navDrawer__ico navDrawer__ico--accent">${ico(ICON_BADGE)}</span>
            <span>${esc(badge)}</span>
          </div>
          <button class="navDrawer__item" data-act="exitStaff">
            <span class="navDrawer__ico">${ico(ICON_EXIT)}</span>
            <span>${esc(t.navExitStaff)}</span>
          </button>` : `
          <button class="navDrawer__item" data-act="navOrder">
            <span class="navDrawer__ico navDrawer__ico--accent">${ico(ICON_BAG)}</span>
            <span>${esc(t.navOrderFood)}</span>
          </button>
          <button class="navDrawer__item" data-act="openLogin">
            <span class="navDrawer__ico">${ico(ICON_LOGIN)}</span>
            <span>${esc(t.staffLogin)}</span>
          </button>`}
        </div>
      </div>
    </div>` : ''}
  </header>`;
}

/* ── customer: 01 home ─────────────────────────────────────── */
function homeHtml() {
  const t = T(), qo = queueOrders();

  const rows = qo.map((o, i) => {
    const c = statusChip(ostatus(o), o.type), mine = !!o.mine;
    return `
    <button class="queue__row" data-act="openQd" data-id="${esc(o.id)}"
            style="background:${mine ? 'var(--color-accent-100)' : 'transparent'};color:${INK}">
      <span class="queue__pos">${i + 1}</span>
      <span class="queue__where">
        <span style="font-size:14px;font-weight:700">${esc(mine ? t.yourOrder + ' · ' + whereOf(o) : whereOf(o))}</span>
        <span class="mono" style="font-size:10px;opacity:.7">${esc(o.id)} · ${esc(o.at)}</span>
      </span>
      <span style="display:flex;align-items:center;gap:8px">
        <span class="chip" style="background:${mine ? GROUND : c.bg};color:${mine ? 'var(--color-accent-700)' : c.fg}">${esc(c.label)}</span>
        <span class="mono" style="font-size:13px;opacity:.6">›</span>
      </span>
    </button>`;
  }).join('');

  const svcOpts = [
    { key: 'dinein', label: t.dinein, hint: t.dineinHint },
    { key: 'takeaway', label: t.takeaway, hint: t.takeawayHint }
  ].map(o => {
    const on = S.service === o.key;
    return `
    <button class="svc" data-act="service" data-v="${o.key}" style="background:${on ? INK : 'transparent'};color:${on ? GROUND : INK}">
      <span class="svc__dot" style="border:2px solid ${on ? GROUND : INK};background:${on ? RED : 'transparent'}"></span>
      <span style="display:flex;flex-direction:column;gap:2px">
        <span style="font-size:15px;font-weight:700">${esc(o.label)}</span>
        <span style="font-size:12px;opacity:.72">${esc(o.hint)}</span>
      </span>
    </button>`;
  }).join('');

  const tableSelect = S.service === 'dinein' ? `
    <div class="tablepick">
      <label class="mono" style="font-size:10px;letter-spacing:.1em;color:var(--color-neutral-700)">${esc(t.chooseTable)}</label>
      <select data-chg="table">
        <option value="">${esc(t.pickTableFirst)}</option>
        ${TABLE_NOS.map(no => {
          const busy = tableBusy(no);
          return `<option value="${no}"${busy ? ' disabled' : ''}${S.tableNo === no ? ' selected' : ''}>${esc(t.tableLabel + ' ' + no + (busy ? ' · ' + t.tableBusy : ''))}</option>`;
        }).join('')}
      </select>
    </div>` : '';

  const blocked = S.service === 'dinein' && !S.tableNo;

  return `
  <div class="${screenCls}">
    <div class="home__head">
      <div class="kicker">${esc(t.scanned)}</div>
      <div class="home__title">${esc(S.shopName)}</div>
      <div class="pretty" style="font-size:13px;color:var(--color-neutral-700)">${esc(t.shopTagline)}</div>
    </div>
    <div class="photoslot photoslot--home"><img src="images/shopfront.jpg" alt="${esc(S.shopName)}"></div>
    <div class="home__grid">
      <div class="home__queue">
        <div class="queue__head">
          <span class="queue__title">${esc(t.queueTitle)}</span>
          <span class="live" style="font-size:9px;letter-spacing:.12em"><span class="live__dot"></span>${esc(t.live)}</span>
        </div>
        <div class="queue__hint">${esc(t.queueHint)}</div>
        <div class="queue__cols"><span>${esc(t.colQueue)}</span><span>${esc(t.colWhere)}</span><span>${esc(t.colStatus)}</span></div>
        ${qo.length ? `<div class="queue__scroll">${rows}</div>` : `<div class="queue__empty">${esc(t.queueEmpty)}</div>`}
      </div>
      <div class="home__start">
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="font-size:13px;font-weight:700">${esc(t.pickService)}</div>
          ${svcOpts}
        </div>
        ${tableSelect}
        <button class="btn-cta" data-act="startFlow"${blocked ? ' disabled' : ''} style="opacity:${blocked ? 0.45 : 1}">
          <span class="btn-cta__label">${esc(t.toMenu)}</span><span class="btn-cta__arrow">→</span>
        </button>
        <div class="pretty" style="font-size:11px;color:var(--color-neutral-600);line-height:1.7">${esc(t.payAtCounter)}</div>
      </div>
    </div>
  </div>`;
}

/* ── customer: 02 table ────────────────────────────────────── */
function tableHtml() {
  const t = T();
  const cells = TABLE_NOS.map(no => {
    const busy = tableBusy(no), on = S.tableNo === no;
    return `
    <button class="tablecell" data-act="setTable" data-v="${no}" style="background:${on ? INK : 'transparent'};color:${on ? GROUND : INK}">
      <span style="display:flex;align-items:baseline;gap:8px;width:100%">
        <span class="mono" style="font-size:9px;letter-spacing:.12em;opacity:.7">${esc(t.tableLabel)}</span>
        <span class="tablecell__no">${no}</span>
        ${on ? `<span style="margin-left:auto;width:12px;height:12px;background:${RED}"></span>` : ''}
      </span>
      <span class="chip" style="background:${on ? GROUND : busy ? 'var(--color-accent-200)' : SURF};color:${on ? INK : busy ? 'var(--color-accent-700)' : 'var(--color-neutral-700)'}">${esc(busy ? t.tableBusy : t.tableOpen)}</span>
    </button>`;
  }).join('');

  const blocked = !S.tableNo;
  return `
  <div class="${screenCls}">
    <div class="scr__head">
      <div style="display:flex;flex-direction:column;gap:4px">
        <div class="kicker">${esc(t.stepTable)}</div>
        <div class="scr__title">${esc(t.chooseTable)}</div>
      </div>
      <button class="btn-outline" style="flex:none" data-act="go" data-v="home">← ${esc(t.back)}</button>
    </div>
    <div class="pretty" style="padding:12px 18px;border-bottom:1px solid var(--color-neutral-300);font-size:12px;color:var(--color-neutral-700)">${esc(t.chooseTableHint)}</div>
    <div class="tablegrid">${cells}</div>
    <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
      <button class="btn-cta" data-act="go" data-v="menu"${blocked ? ' disabled' : ''} style="opacity:${blocked ? 0.45 : 1}">
        <span class="btn-cta__label">${esc(blocked ? t.pickTableFirst : t.toMenu)}</span><span class="btn-cta__arrow">→</span>
      </button>
      <div class="pretty" style="font-size:11px;color:var(--color-neutral-600);line-height:1.7">${esc(t.tableNote)}</div>
    </div>
  </div>`;
}

/* ── customer: 03 menu ─────────────────────────────────────── */
function menuHtml() {
  const t = T();
  const ctxLine = S.service === 'dinein' && S.tableNo
    ? typeLabel(S.service) + ' · ' + t.tableLabel + ' ' + S.tableNo
    : typeLabel(S.service);

  const cats = S.cats.map(c => {
    const on = S.cat === c.id;
    return `<button class="menu__cat" data-act="cat" data-v="${esc(c.id)}" style="font-weight:${on ? 700 : 400};${tabColors(on)}">${esc(L(c))}</button>`;
  }).join('');

  const list = S.menu
    .filter(m => m.available !== false)
    .filter(m => (S.cat === 'rec' ? (m.tth || m.cat === 'rec') : m.cat === S.cat))
    .map(m => {
      const tag = S.lang === 'th' ? m.tth : m.ten;
      const desc = S.lang === 'th' ? m.dth : m.den;
      return `
      <div class="mrow">
        <button class="mrow__thumb ${m.photo ? '' : 'hatch'}" data-act="openItem" data-id="${esc(m.id)}" style="${m.photo ? `background-image:url('${esc(m.photo)}')` : ''}"></button>
        <div class="mrow__body">
          <div style="display:flex;align-items:baseline;gap:8px">
            <button class="mrow__name" data-act="openItem" data-id="${esc(m.id)}">${esc(L(m))}</button>
            ${tag ? `<span class="mrow__tag">${esc(tag)}</span>` : ''}
          </div>
          <div class="mono" style="font-size:11px;color:var(--color-neutral-600)">${esc(S.lang === 'th' ? m.en : m.th)}</div>
          ${desc ? `<div class="pretty" style="font-size:12px;color:var(--color-neutral-700);line-height:1.5">${esc(desc)}</div>` : ''}
          <div class="mrow__foot">
            <span style="font-size:15px;font-weight:700">${esc(baht(m.price))}</span>
            <button class="btn-ink" data-act="openItem" data-id="${esc(m.id)}">${esc(t.add)}</button>
          </div>
        </div>
      </div>`;
    }).join('');

  return `
  <div class="${screenCls}">
    <div class="menu__bar">
      <div class="menu__barTop">
        <div style="display:flex;flex-direction:column;gap:1px">
          <div class="mono" style="font-size:9px;letter-spacing:.16em;color:var(--color-neutral-700)">${esc(ctxLine)}</div>
          <div style="font-size:20px;font-weight:800">${esc(t.menu)}</div>
        </div>
        <button class="btn-outline" data-act="go" data-v="home">${esc(t.change)}</button>
      </div>
      <div class="menu__cats">${cats}</div>
    </div>
    ${list || `<div style="padding:40px 18px;font-size:14px;color:var(--color-neutral-600)">${esc(t.queueEmpty)}</div>`}
    <div class="pretty" style="padding:16px 18px 90px;font-size:11px;color:var(--color-neutral-600);line-height:1.7">${esc(t.payAtCounter)}</div>
  </div>`;
}

/* ── customer: 04 item detail ──────────────────────────────── */
function itemHtml() {
  const t = T();
  const m = dict(S.openId || 'f1');
  const isDrink = m.kind === 'drink';
  const li = levelInfo(m);
  const exList = isDrink ? EX_DRINK : EX_FOOD;
  const chosen = exList.filter(e => S.itemExtras.includes(e.id));
  const unit = m.price + chosen.reduce((a, e) => a + e.p, 0);

  const levelBtns = li.list.map((o, i) => {
    const on = S.itemLevel === i;
    return `
    <button class="opt" data-act="level" data-i="${i}" style="background:${on ? SURF : 'transparent'};color:${INK}">
      <span class="opt__dot" style="border:2px solid ${INK};background:${on ? RED : 'transparent'}"></span>
      <span style="font-size:14px;font-weight:500">${esc(L(o))}</span>
    </button>`;
  }).join('');

  const extraBtns = exList.map(e => {
    const on = S.itemExtras.includes(e.id);
    return `
    <button class="opt" data-act="extra" data-id="${esc(e.id)}" style="background:${on ? SURF : 'transparent'};color:${INK}">
      <span class="opt__dot" style="border:2px solid ${INK};background:${on ? RED : 'transparent'}"></span>
      <span style="flex:1;font-size:14px;font-weight:500">${esc(L(e))}</span>
      <span class="mono" style="font-size:12px">${e.p ? '+' + baht(e.p) : '—'}</span>
    </button>`;
  }).join('');

  const desc = S.lang === 'th' ? m.dth : m.den;

  return `
  <div class="${screenCls}">
    <div class="photoslot photoslot--item ${m.photo ? '' : 'hatch'}" style="${m.photo ? `background-image:url('${esc(m.photo)}');background-size:cover;background-position:center` : ''}">
      ${m.photo ? '' : `<span class="photoslot__tag">${esc(t.photoSlot)}</span>`}
      <button class="btn-outline" style="background:var(--color-bg)" data-act="go" data-v="menu">← ${esc(t.back)}</button>
    </div>
    <div style="padding:16px 18px;display:flex;flex-direction:column;gap:5px;border-bottom:1px solid var(--color-neutral-300)">
      <div style="font-size:22px;font-weight:800;line-height:1.25">${esc(L(m))}</div>
      <div class="mono" style="font-size:11px;color:var(--color-neutral-600)">${esc(S.lang === 'th' ? m.en : m.th)}</div>
      ${desc ? `<div class="pretty" style="font-size:13px;color:var(--color-neutral-700)">${esc(desc)}</div>` : ''}
      <div style="font-size:20px;font-weight:800;margin-top:4px">${esc(baht(m.price))}</div>
    </div>
    ${li.show ? `
    <div class="sect">
      <div style="display:flex;align-items:baseline;gap:8px">
        <span class="sect__title">${esc(li.title)}</span>
        <span class="mono" style="font-size:10px;color:var(--color-neutral-600)">${esc(t.required)}</span>
      </div>
      ${levelBtns}
    </div>` : ''}
    ${(!isDrink || m.hasSpice !== false) ? `
    <div class="sect">
      <div class="sect__title">${esc(t.extras)}</div>
      ${extraBtns}
    </div>` : ''}
    <div class="sect" style="gap:8px">
      <div class="sect__title">${esc(t.noteToKitchen)}</div>
      <textarea class="fld" rows="3" data-inp="itemNote" placeholder="${esc(t.notePlaceholder)}">${esc(S.itemNote)}</textarea>
    </div>
    <div class="addbar">
      <div class="stepper">
        <button data-act="qty" data-v="-1">−</button>
        <span>${S.itemQty}</span>
        <button data-act="qty" data-v="1">+</button>
      </div>
      <button class="addbar__cta" data-act="addToCart">
        <span style="font-size:15px;font-weight:700">${esc(t.addToCart)}</span>
        <span class="mono" style="font-size:14px">${esc(baht(unit * S.itemQty))}</span>
      </button>
    </div>
  </div>`;
}

/* ── customer: 05 cart ─────────────────────────────────────── */
function cartHtml() {
  const t = T();
  const ctxTable = S.service === 'dinein'
    ? (S.tableNo ? t.tableLabel + ' ' + S.tableNo : t.pickTableFirst)
    : t.takeawayHint;

  const lines = S.cart.map((l, i) => `
    <div class="cart__line">
      <div style="flex:1;display:flex;flex-direction:column;gap:3px">
        <div style="font-size:15px;font-weight:700">${esc(L(dict(l.id)))}</div>
        <div style="font-size:12px;color:var(--color-neutral-700)">${esc(optText(l))}</div>
        ${l.note ? `<div class="cart__note">“${esc(l.note)}”</div>` : ''}
        <div style="display:flex;align-items:center;gap:10px;margin-top:5px">
          <div class="stepper-sm">
            <button data-act="lineQty" data-i="${i}" data-v="-1">−</button>
            <span>${l.qty}</span>
            <button data-act="lineQty" data-i="${i}" data-v="1">+</button>
          </div>
          <button class="linkbtn" data-act="lineRemove" data-i="${i}">${esc(t.remove)}</button>
        </div>
      </div>
      <div class="mono" style="font-size:15px;font-weight:700">${esc(baht(lineTotal(l)))}</div>
    </div>`).join('');

  const takeawayFields = S.service !== 'dinein' ? `
    <div class="sect" style="gap:10px">
      <div class="sect__title">${esc(t.custInfo)}</div>
      <input class="fld" data-inp="custName" value="${esc(S.custName)}" placeholder="${esc(t.custNamePh)}">
      <input class="fld" data-inp="custPhone" value="${esc(S.custPhone)}" placeholder="${esc(t.custPhonePh)}">
    </div>` : '';

  const foot = S.cart.length ? `
    <div style="display:flex;flex-direction:column">
      ${takeawayFields}
      <div class="sect" style="gap:8px">
        <div class="sect__title">${esc(t.orderNote)}</div>
        <textarea class="fld" rows="2" data-inp="orderNote" placeholder="${esc(t.orderNotePlaceholder)}">${esc(S.orderNote)}</textarea>
      </div>
      <div style="padding:16px 18px;display:flex;flex-direction:column;gap:9px;border-bottom:2px solid var(--color-text)">
        <div class="sumrow"><span>${esc(t.subtotal)}</span><span class="mono">${esc(baht(cartSum()))}</span></div>
        <div class="sumrow"><span>${esc(t.itemCount)}</span><span class="mono">${cartCount()}</span></div>
        <div class="sumtotal">
          <span style="font-size:15px;font-weight:800">${esc(t.total)}</span>
          <span class="mono" style="font-size:22px;font-weight:800">${esc(baht(cartSum()))}</span>
        </div>
        <div style="font-size:11px;color:var(--color-neutral-600);line-height:1.6">${esc(t.payAtCounter)}</div>
      </div>
      <div style="padding:16px 18px 24px">
        <button class="btn-cta" style="padding:16px" data-act="submit">
          <span class="btn-cta__label">${esc(S.editingId ? t.resendOrder : t.sendOrder)}</span>
          <span class="btn-cta__arrow">→</span>
        </button>
      </div>
    </div>` : '';

  return `
  <div class="${screenCls}">
    <div class="cart__head">
      <div style="font-size:20px;font-weight:800">${esc(t.cartTitle)}</div>
      <button class="btn-outline" data-act="go" data-v="menu">+ ${esc(t.addMore)}</button>
    </div>
    <div class="cart__ctx">
      <span class="mono" style="font-size:10px;letter-spacing:.12em;color:var(--color-neutral-700)">${esc(typeLabel(S.service))}</span>
      <span style="font-size:13px;font-weight:600">${esc(ctxTable)}</span>
    </div>
    ${S.cart.length ? lines : `
      <div style="padding:60px 18px;display:flex;flex-direction:column;gap:14px;align-items:flex-start">
        <div style="font-size:15px;font-weight:700">${esc(t.cartEmpty)}</div>
        <button style="padding:12px 18px;border:0;background:${RED};color:${GROUND};cursor:pointer;font-size:14px;font-weight:700" data-act="go" data-v="menu">${esc(t.browseMenu)}</button>
      </div>`}
    ${foot}
  </div>`;
}

/* ── customer: 06 tracking ─────────────────────────────────── */
function trackHtml() {
  const t = T();
  const mo = myOrder();
  const key = mo ? ostatus(mo) : 'new';
  const chip = statusChip(key, mo ? mo.type : S.service);
  const locked = trackLocked(mo);
  const headBg = key === 'ready' ? INK : SURF;
  const headFg = key === 'ready' ? GROUND : INK;

  const lines = (mo ? mo.lines : []).map(l => `
    <div class="trkline">
      <span class="mono" style="font-size:12px;color:var(--color-neutral-700);flex:none">${l.qty}×</span>
      <span style="flex:1;display:flex;flex-direction:column;gap:2px">
        <span style="font-size:14px;font-weight:600">${esc(L(dict(l.id)))}</span>
        <span style="font-size:12px;color:var(--color-neutral-600)">${esc(optText(l))}</span>
        ${l.note ? `<span style="font-size:12px;color:var(--color-accent-700)">“${esc(l.note)}”</span>` : ''}
      </span>
      <span class="mono" style="font-size:13px;font-weight:600">${esc(baht(lineTotal(l)))}</span>
    </div>`).join('');

  return `
  <div class="${screenCls}">
    <div class="trk__head" style="background:${headBg};color:${headFg}">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="mono" style="font-size:11px;letter-spacing:.12em">${esc(mo ? mo.id : '—')}</span>
        <span class="mono" style="display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.1em">
          <span style="width:6px;height:6px;background:currentColor;animation:blip 1.6s infinite"></span>${esc(t.live)}
        </span>
      </div>
      <div class="trk__status">${esc(chip.label)}</div>
      <div style="font-size:13px;opacity:.8">${esc(etaFor(key))}</div>
    </div>
    ${mo ? `<div class="steps">${stepsHtml(mo, 18)}</div>` : ''}
    <div class="sect" style="gap:11px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span class="sect__title">${esc(t.yourItems)}</span>
        <span class="mono" style="font-size:11px;color:var(--color-neutral-700)">${esc(mo ? whereOf(mo) + ' · ' + typeLabel(mo.type) : '—')}</span>
      </div>
      ${lines}
      <div style="display:flex;justify-content:space-between;padding-top:10px;border-top:1px solid var(--color-neutral-300)">
        <span style="font-size:14px;font-weight:800">${esc(t.total)}</span>
        <span class="mono" style="font-size:16px;font-weight:800">${esc(mo ? baht(orderTotal(mo)) : '฿0')}</span>
      </div>
    </div>
    <div class="trk__acts">
      <div class="rulebox" style="background:${locked ? SURF : 'var(--color-accent-100)'};border-left:2px solid ${locked ? 'var(--color-neutral-600)' : RED};color:${locked ? 'var(--color-neutral-700)' : 'var(--color-accent-700)'}">${esc(locked ? t.ruleLocked : t.ruleOpen)}</div>
      <div class="row">
        <button data-act="editOrder"${locked ? ' disabled' : ''} style="border:2px solid ${INK};opacity:${locked ? 0.4 : 1};cursor:${locked ? 'not-allowed' : 'pointer'}">${esc(t.editOrder)}</button>
        <button data-act="askCancel"${locked ? ' disabled' : ''} style="border:2px solid ${RED};color:var(--color-accent-700);opacity:${locked ? 0.4 : 1};cursor:${locked ? 'not-allowed' : 'pointer'}">${esc(t.cancelOrder)}</button>
      </div>
      <button style="padding:12px;border:1px solid var(--color-neutral-600);background:transparent;cursor:pointer;font-size:13px;font-weight:600;color:var(--color-neutral-700)" data-act="go" data-v="history">${esc(t.viewHistory)}</button>
    </div>
  </div>`;
}

/* ── customer: 07 history ──────────────────────────────────── */
function historyHtml() {
  const t = T();
  const rows = S.orders
    .filter(o => o.mine && (o.st === 'closed' || o.st === 'cancelled'))
    .map(o => {
      const c = statusChip(o.st, o.type);
      return `
      <div class="hist">
        <div class="hist__top">
          <span class="mono" style="font-size:11px;letter-spacing:.1em;color:var(--color-neutral-700)">${esc(o.id)} · ${esc(S.lang === 'th' ? o.at : (o.atEn || o.at))}</span>
          ${chipHtml(c)}
        </div>
        <div class="pretty" style="font-size:14px;font-weight:600;line-height:1.5">${esc(summaryOf(o))}</div>
        <div class="hist__foot">
          <span style="font-size:12px;color:var(--color-neutral-600)">${esc(whereOf(o) + ' · ' + o.lines.length + ' ' + t.lines)}</span>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="mono" style="font-size:16px;font-weight:800">${esc(baht(orderTotal(o)))}</span>
            <button class="btn-ink" style="padding:7px 12px" data-act="reorder" data-id="${esc(o.id)}">${esc(t.reorder)}</button>
          </div>
        </div>
      </div>`;
    }).join('');

  return `
  <div class="${screenCls}">
    <div class="cart__head">
      <div style="font-size:20px;font-weight:800">${esc(t.history)}</div>
      <button class="btn-outline" data-act="go" data-v="track">${esc(t.current)}</button>
    </div>
    ${rows || `<div style="padding:40px 18px;font-size:14px;color:var(--color-neutral-600)">${esc(t.queueEmpty)}</div>`}
    <div style="padding:18px;font-size:11px;color:var(--color-neutral-600);line-height:1.7">${esc(t.historyNote)}</div>
  </div>`;
}

/* ── customer shell ────────────────────────────────────────── */
function customerHtml() {
  const t = T();
  const screens = { home: homeHtml, table: tableHtml, menu: menuHtml, item: itemHtml, cart: cartHtml, track: trackHtml, history: historyHtml };
  const body = (screens[S.cust] || homeHtml)();
  const count = cartCount();

  const quickNav = S.cust !== 'home' ? `
    <div class="quicknav">
      <button class="qbtn" data-act="go" data-v="home" style="background:transparent;color:${INK}">${ico(`<path d="${ICON_HOME}"></path><polyline points="9 22 9 12 15 12 15 22"></polyline>`)}</button>
      <button class="qbtn" data-act="go" data-v="track" style="${tabColors(S.cust === 'track')}">${ico(ICON_CLOCK)}${esc(t.railTrack)}</button>
      <button class="qbtn" data-act="go" data-v="cart" style="${tabColors(S.cust === 'cart')}">
        ${ico(ICON_CART)}${esc(t.railCart)}
        ${count ? `<span class="qbtn__badge">${count}</span>` : ''}
      </button>
    </div>` : '';

  const cartBar = count && (S.cust === 'menu' || S.cust === 'item') ? `
    <div class="cartbar">
      <button data-act="go" data-v="cart">
        <span class="mono" style="padding:4px 9px;background:${RED};color:${GROUND};font-size:12px;font-weight:500">${count}</span>
        <span style="flex:1;font-size:14px;font-weight:700">${esc(t.goToCart)}</span>
        <span class="mono" style="font-size:15px;font-weight:500">${esc(baht(cartSum()))}</span>
      </button>
    </div>` : '';

  return `
  <div class="cust">
    <div class="cust__panel" style="max-width:${S.cust === 'home' ? 'none' : '720px'}">
      ${quickNav}
      <div class="grow">${body}</div>
      ${cartBar}
    </div>
  </div>`;
}

/* ── owner ─────────────────────────────────────────────────── */
function ownerQueueHtml() {
  const t = T();
  const news = S.orders.filter(o => o.st === 'new');
  const active = S.orders.filter(o => o.st === 'accepted');
  const ready = active.filter(o => ostatus(o) === 'ready');
  const inProgress = active.filter(o => ostatus(o) !== 'ready');

  const readyCards = ready.map(o => `
    <div class="ocard ocard--ready">
      <div class="ocard__top">
        <span style="display:flex;align-items:baseline;gap:10px">
          <span class="mono" style="font-size:13px;font-weight:500;letter-spacing:.08em">${esc(o.id)}</span>
          <span class="chip" style="background:${GROUND};color:${INK};letter-spacing:.1em">${esc(typeLabel(o.type))}</span>
        </span>
        <span style="font-size:18px;font-weight:800">${esc(whereOf(o))}</span>
      </div>
      <div class="pretty" style="font-size:13px;opacity:.85">${esc(summaryOf(o))}</div>
      <div style="display:flex;gap:8px">
        <button style="flex:1;padding:12px;border:0;background:${GROUND};color:${INK};cursor:pointer;font-size:14px;font-weight:700;text-align:left" data-act="pickBillGo" data-id="${esc(o.id)}">${esc(t.goToBill)}</button>
      </div>
    </div>`).join('');

  const inProgressRows = inProgress.map(o => {
    const c = statusChip(ostatus(o), o.type);
    return `
    <button class="oq__active" data-act="openQd" data-id="${esc(o.id)}">
      <span class="oq__dot" style="background:${c.bg}"></span>
      <span style="flex:1;display:flex;flex-direction:column;gap:2px;min-width:0">
        <span style="font-size:13px;font-weight:700">${esc(o.id)} · ${esc(whereOf(o))}</span>
        <span class="mono" style="font-size:10px;color:var(--color-neutral-600)">${esc(o.at)} · [${esc(c.label)}]</span>
      </span>
    </button>`;
  }).join('');

  return `
  <div class="kNew">
    <div class="kNew__head">
      <span style="font-size:15px;font-weight:800">${esc(t.newOrders)}</span>
      <span class="mono" style="font-size:10px;color:var(--color-neutral-600)">${esc(t.confirmRule)}</span>
    </div>
    <div class="kNew__cards">
      ${news.length ? news.map(newOrderCardHtml).join('') : `<div style="padding:22px;font-size:13px;color:var(--color-neutral-600)">${esc(t.noNewOrders)}</div>`}
    </div>
  </div>
  <div class="oq">
    <div class="oq__left">
      <div class="oq__head">
        <span style="font-size:17px;font-weight:800">${esc(t.readyToServe)}</span>
        <span class="mono" style="font-size:11px;color:var(--color-neutral-600)">${esc(t.readyToServeHint)}</span>
      </div>
      ${ready.length ? readyCards : `<div style="padding:40px 22px;font-size:14px;color:var(--color-neutral-600)">${esc(t.noReadyOrders)}</div>`}
    </div>
    <div class="oq__right">
      <div style="padding:16px 18px 12px;font-size:15px;font-weight:800;border-bottom:1px solid var(--color-neutral-300)">${esc(t.inProgress)} (${inProgress.length})</div>
      ${inProgress.length ? inProgressRows : `<div style="padding:20px 18px;font-size:13px;color:var(--color-neutral-600)">${esc(t.noNewOrders)}</div>`}
      <div class="grow"></div>
      <button style="padding:13px 18px;border:0;border-top:2px solid ${INK};background:transparent;cursor:pointer;font-size:13px;font-weight:700;text-align:left" data-act="ownerTab" data-v="bill">${esc(t.openBills)} →</button>
    </div>
  </div>`;
}

function ownerTablesHtml() {
  const t = T();
  const legend = [
    { label: t.legendFree, bg: GROUND }, { label: t.legendWait, bg: 'var(--color-accent-200)' },
    { label: t.legendReady, bg: INK }
  ].map(lg => `<span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--color-neutral-700)"><span style="width:10px;height:10px;background:${lg.bg};border:1px solid ${INK}"></span>${esc(lg.label)}</span>`).join('');

  const cells = TABLE_NOS.map(no => {
    const o = S.orders.find(x => x.type === 'dinein' && x.table === no && (x.st === 'new' || x.st === 'accepted'));
    if (!o) {
      return `
      <div class="floor__cell" style="background:${GROUND};color:${INK}">
        <div style="display:flex;align-items:baseline;justify-content:space-between">
          <span class="floor__no">${no}</span>
          <span class="chip" style="background:${SURF};color:var(--color-neutral-700);letter-spacing:.1em">${esc(t.legendFree)}</span>
        </div>
        <div class="floor__rule"></div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <span style="font-size:13px;color:var(--color-neutral-600)">${esc(t.tableFree)}</span>
          <span class="mono" style="font-size:10px;color:var(--color-neutral-500);letter-spacing:.06em">${esc(t.oneQrShort)}</span>
        </div>
      </div>`;
    }
    const k = ostatus(o), c = statusChip(k, o.type);
    const dark = k === 'ready';
    const bg = dark ? INK : k === 'new' ? 'var(--color-accent-200)' : SURF;
    return `
    <div class="floor__cell" style="background:${bg};color:${dark ? GROUND : INK}">
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <span class="floor__no">${no}</span>
        <span class="chip" style="background:${dark ? GROUND : c.bg};color:${dark ? INK : c.fg};letter-spacing:.1em">${esc(c.label)}</span>
      </div>
      <div class="floor__rule"></div>
      <div style="display:flex;flex-direction:column;gap:7px">
        <span class="mono" style="font-size:11px;opacity:.75">${esc(o.id)} · ${esc(o.at)}</span>
        <span class="pretty" style="font-size:13px;line-height:1.55">${esc(summaryOf(o))}</span>
        <span class="mono" style="font-size:18px;font-weight:800">${esc(baht(orderTotal(o)))}</span>
      </div>
      <div class="grow"></div>
      ${k === 'new'
        ? `<div class="floor__wait">${esc(t.waitingKitchen)}</div>`
        : `<button class="floor__btn" data-act="tableAction" data-id="${esc(o.id)}">${esc(t.closeBill)}</button>`}
    </div>`;
  }).join('');

  return `
  <div style="display:flex;flex-direction:column">
    <div class="floor__head">
      <span style="font-size:17px;font-weight:800">${esc(t.floorPlan)}</span>
      <span class="mono" style="font-size:11px;color:var(--color-neutral-600)">${esc(t.sixTables)}</span>
      <div class="grow"></div>
      ${legend}
    </div>
    <div class="floor__grid">${cells}</div>
  </div>`;
}

function ownerBillHtml() {
  const t = T();
  const open = openBillOrders();
  const bo = currentBill();
  const boKey = bo ? ostatus(bo) : 'accepted';
  const cantClose = boKey !== 'ready';

  const list = open.map(o => {
    const on = bo && bo.id === o.id, c = statusChip(ostatus(o), o.type);
    return `
    <button class="bill__item" data-act="pickBill" data-id="${esc(o.id)}" style="${tabColors(on)}">
      <span class="mono" style="font-size:11px;opacity:.8"><span>${esc(o.id)}</span><span>${esc(o.at)}</span></span>
      <span style="font-size:15px;font-weight:700;display:block;width:auto">${esc(whereOf(o))}</span>
      <span style="align-items:baseline"><span style="font-size:11px;opacity:.75">${esc(c.label)}</span><span class="mono" style="font-size:15px;font-weight:800">${esc(baht(orderTotal(o)))}</span></span>
    </button>`;
  }).join('');

  const lines = (bo ? bo.lines : []).map(l => `
    <div class="bill__row">
      <span class="bill__qty">${l.qty}</span>
      <span class="bill__name">
        <span class="pretty" style="font-size:14px;font-weight:600">${esc(L(dict(l.id)))}</span>
        <span style="font-size:11px;color:var(--color-neutral-600)">${esc(optText(l))}</span>
      </span>
      <span class="bill__price">${esc(baht(l.price))}</span>
      <span class="bill__amt">${esc(baht(lineTotal(l)))}</span>
    </div>`).join('');

  const stations = ['food', 'drink'].filter(k => bo && hasKind(bo, k)).map(k => {
    const c = statusChip(bo[k], bo.type);
    return `<div class="bill__station"><span style="font-size:13px;font-weight:600">${esc(k === 'food' ? t.stFood : t.stDrink)}</span>${chipHtml(c)}</div>`;
  }).join('');

  return `
  <div class="bill">
    <div class="bill__list">
      <div style="padding:15px 18px;border-bottom:1px solid var(--color-neutral-300);font-size:15px;font-weight:800">${esc(t.openBills)}</div>
      ${list || `<div style="padding:20px 18px;font-size:13px;color:var(--color-neutral-600)">${esc(t.noNewOrders)}</div>`}
    </div>
    <div style="display:flex;flex-direction:column;min-width:0">
      <div class="bill__head">
        <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
          <span class="mono" style="font-size:11px;letter-spacing:.12em;color:var(--color-neutral-700)">${esc(bo ? bo.id + ' · ' + typeLabel(bo.type) : '—')}</span>
          <span style="font-size:22px;font-weight:800">${esc(bo ? whereOf(bo) : '—')}</span>
        </div>
      </div>
      <div class="bill__body">
        <div class="bill__lines">
          <div class="bill__cols">
            <span class="bill__qty">${esc(t.qty)}</span><span class="bill__name">${esc(t.itemCol)}</span>
            <span class="bill__price">${esc(t.priceCol)}</span><span class="bill__amt">${esc(t.amountCol)}</span>
          </div>
          ${lines}
          <div class="grow"></div>
          <div class="bill__grand">
            <span style="font-size:16px;font-weight:800">${esc(t.grandTotal)}</span>
            <span class="mono" style="font-size:30px;font-weight:800">${esc(bo ? baht(orderTotal(bo)) : '฿0')}</span>
          </div>
        </div>
        <div class="bill__side">
          <div class="mono" style="font-size:10px;letter-spacing:.14em;color:var(--color-neutral-700)">${esc(t.closeBill)}</div>
          <div style="display:flex;flex-direction:column;gap:7px">${stations}</div>
          <div class="pretty" style="font-size:12px;line-height:1.7;color:var(--color-neutral-700)">${esc(t.cashNote)}</div>
          <div class="grow"></div>
          <button class="bill__close" data-act="closeBill"${cantClose ? ' disabled' : ''} style="opacity:${cantClose ? 0.45 : 1};cursor:${cantClose ? 'not-allowed' : 'pointer'}">
            <span>${esc(t.saveSale)}</span><span class="mono">${esc(bo ? baht(orderTotal(bo)) : '฿0')}</span>
          </button>
          <button class="btn-outline" style="padding:13px;text-align:center" data-act="print" data-id="${bo ? esc(bo.id) : ''}" data-v="bill">${esc(t.printBill)}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function ownerHtml() {
  const t = T();
  const news = S.orders.filter(o => o.st === 'new');
  const ready = S.orders.filter(o => o.st === 'accepted' && ostatus(o) === 'ready');
  const busy = TABLE_NOS.filter(no => S.orders.some(x => x.type === 'dinein' && x.table === no && (x.st === 'new' || x.st === 'accepted'))).length;

  const nav = [
    { key: 'queue', label: t.readyToServe }, { key: 'tables', label: t.floorPlan }, { key: 'bill', label: t.openBills }
  ].map(n => {
    const on = S.ownerTab === n.key;
    return `<button class="owner__navBtn" data-act="ownerTab" data-v="${n.key}" style="font-weight:${on ? 800 : 500};${tabColors(on)}">${esc(n.label)}</button>`;
  }).join('');

  const stats = [
    { v: String(S.orders.length), l: t.ownerOrdersToday },
    { v: baht(S.salesToday), l: t.today },
    { v: String(busy), l: t.ownerTablesBusy },
    { v: String(ready.length), l: t.ownerPending }
  ].map(d => `<div class="owner__stat"><b>${esc(d.v)}</b><span style="font-size:11px;color:var(--color-neutral-600)">${esc(d.l)}</span></div>`).join('');

  const tabs = [
    { key: 'queue', label: t.readyToServe, count: (news.length + ready.length) ? String(news.length + ready.length) : '' },
    { key: 'tables', label: t.floorPlan, count: '' },
    { key: 'bill', label: t.openBills, count: '' }
  ].map(o => {
    const on = S.ownerTab === o.key;
    return `
    <button class="owner__tab" data-act="ownerTab" data-v="${o.key}" style="${tabColors(on)}">
      <span style="font-size:14px;font-weight:700">${esc(o.label)}</span>
      ${o.count ? `<span class="mono" style="padding:2px 7px;background:${on ? RED : INK};color:${GROUND};font-size:11px">${o.count}</span>` : ''}
    </button>`;
  }).join('');

  const body = S.ownerTab === 'tables' ? ownerTablesHtml()
    : S.ownerTab === 'bill' ? ownerBillHtml()
    : ownerQueueHtml();

  return `
  <div class="owner">
    <div class="owner__nav">
      <div class="owner__navTitle">${esc(t.ownerNavTitle)}</div>
      ${nav}
      <div class="grow"></div>
      <button class="owner__exit" data-act="exitStaff">${esc(t.backToSite)}</button>
    </div>
    <div class="owner__body">
      <div class="owner__head">
        <div style="font-size:22px;font-weight:800">${esc(S.shopName)}</div>
        <span class="hdr__badge" style="padding:7px 13px;font-size:11px;flex:none">${esc(t.roleStaff)}</span>
      </div>
      <div class="owner__stats">${stats}</div>
      <div class="owner__tabs">
        ${tabs}
        <div class="grow"></div>
        <div class="mono" style="display:flex;align-items:center;padding:0 20px;font-size:11px;color:var(--color-neutral-700);white-space:nowrap">${esc(t.today)} · ${esc(baht(S.salesToday))}</div>
      </div>
      <div class="owner__scroll">${body}</div>
    </div>
  </div>`;
}

/* ── admin / manager ───────────────────────────────────────── */
function adminMasterHtml() {
  const t = T();
  const prefixes = S.prefixes.map(p => `
    <div class="listRow">
      <span style="flex:1;font-size:14px;font-weight:600">${esc(p.th)}</span>
      <span class="mono" style="font-size:11px;color:var(--color-neutral-600)">${esc(p.en)}</span>
      <button class="btn-del" data-act="delPrefix" data-id="${esc(p.id)}">${esc(t.del)}</button>
    </div>`).join('');

  const cats = S.cats.map(c => `
    <div class="listRow">
      <span style="flex:1;font-size:14px;font-weight:600">${esc(L(c))}</span>
      <span class="mono" style="font-size:11px;color:var(--color-neutral-600)">${S.menu.filter(m => m.cat === c.id).length} ${esc(t.items)}</span>
      <button class="btn-del" data-act="delCat" data-id="${esc(c.id)}">${esc(t.del)}</button>
    </div>`).join('');

  return `
  <div class="split2">
    <div class="col col--div">
      <div class="secHead">${esc(t.prefixTitle)}</div>
      ${prefixes}
      <div class="addRow">
        <input class="fld-sm" style="flex:1" data-f="prefixTh" value="${esc(S.f.prefixTh)}" placeholder="${esc(t.prefixPh)}">
        <input class="fld-sm" style="width:84px" data-f="prefixEn" value="${esc(S.f.prefixEn)}" placeholder="EN">
        <button class="btn-add" data-act="addPrefix">${esc(t.addBtn)}</button>
      </div>
    </div>
    <div class="col">
      <div class="secHead">${esc(t.catTitle)}</div>
      ${cats}
      <div class="addRow">
        <input class="fld-sm" style="flex:1" data-f="catTh" value="${esc(S.f.catTh)}" placeholder="${esc(t.catPh)}">
        <input class="fld-sm" style="width:84px" data-f="catEn" value="${esc(S.f.catEn)}" placeholder="EN">
        <button class="btn-add" data-act="addCat">${esc(t.addBtn)}</button>
      </div>
    </div>
  </div>`;
}

function adminUsersHtml() {
  const t = T();
  const rows = S.users.map(u => `
    <div class="grid-row g-users">
      <span style="font-size:14px;font-weight:600">${esc(u.name)}</span>
      <span style="font-size:13px;color:var(--color-neutral-700)">${esc(roleLabelOf(u.role))}</span>
      <span class="mono" style="font-size:12px;color:var(--color-neutral-700)">${esc(u.phone)}</span>
      <button class="badgeBtn" data-act="toggleUser" data-id="${esc(u.id)}" style="background:${u.active ? INK : SURF};color:${u.active ? GROUND : 'var(--color-neutral-600)'}">${esc(u.active ? t.uActive : t.uInactive)}</button>
      <button class="btn-del" data-act="delUser" data-id="${esc(u.id)}">${esc(t.del)}</button>
    </div>`).join('');

  return `
  <div class="col">
    <div class="secHead secHead--flex"><b>${esc(t.userTitle)}</b><span class="mono" style="font-size:11px;color:var(--color-neutral-600)">${S.users.length} ${esc(t.items)}</span></div>
    <div class="grid-head g-users"><span>${esc(t.colName)}</span><span>${esc(t.colRole)}</span><span>${esc(t.colPhone)}</span><span>${esc(t.colStatus)}</span><span></span></div>
    ${rows}
    <div class="addRow">
      <input class="fld-sm" style="flex:1 1 170px" data-f="userName" value="${esc(S.f.userName)}" placeholder="${esc(t.namePh)}">
      <button class="btn-cycle" data-act="cycleUserRole">${esc(roleLabelOf(S.f.userRole))}</button>
      <input class="fld-sm" style="flex:0 1 150px" data-f="userPhone" value="${esc(S.f.userPhone)}" placeholder="${esc(t.phonePh)}">
      <button class="btn-add" style="padding:10px 16px" data-act="addUser">${esc(t.addBtn)}</button>
    </div>
  </div>`;
}

function adminMenuHtml() {
  const t = T();
  const rows = S.menu.map(m => `
    <div class="grid-row g-menu">
      <span style="display:flex;align-items:center;gap:10px;min-width:0">
        <label class="menuThumb" title="${esc(m.photo ? t.changePhoto : t.uploadPhoto)}" style="${m.photo ? `background-image:url('${esc(m.photo)}')` : ''}">
          ${m.photo ? '' : '<span>+</span>'}
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-upload="menuPhoto" data-id="${esc(m.id)}">
        </label>
        <span style="display:flex;flex-direction:column;gap:1px;min-width:0">
          <span style="font-size:14px;font-weight:600">${esc(m.th)}</span>
          <span class="mono" style="font-size:10px;color:var(--color-neutral-600)">${esc(m.en)}</span>
        </span>
      </span>
      <span style="font-size:13px;color:var(--color-neutral-700)">${esc(catLabelOf(m.cat))}</span>
      <span class="chip" style="justify-self:start;background:${m.kind === 'food' ? SURF : 'var(--color-accent-200)'};color:${m.kind === 'food' ? INK : 'var(--color-accent-700)'}">${esc(m.kind === 'food' ? t.stFood : t.stDrink)}</span>
      <span class="mono" style="text-align:right;font-size:14px;font-weight:600">${esc(baht(m.price))}</span>
      <button class="badgeBtn" data-act="toggleMenu" data-id="${esc(m.id)}" style="background:${m.available ? INK : SURF};color:${m.available ? GROUND : 'var(--color-neutral-600)'}">${esc(m.available ? t.mOn : t.mOff)}</button>
      <button class="btn-del" data-act="delMenu" data-id="${esc(m.id)}">${esc(t.del)}</button>
    </div>`).join('');

  return `
  <div class="col">
    <div class="secHead secHead--flex"><b>${esc(t.menuTitle)}</b><span class="mono" style="font-size:11px;color:var(--color-neutral-600)">${S.menu.length} ${esc(t.items)}</span></div>
    <div class="grid-head g-menu"><span>${esc(t.colMenu)}</span><span>${esc(t.colCat)}</span><span>${esc(t.colKind)}</span><span style="text-align:right">${esc(t.colPrice)}</span><span>${esc(t.colAvail)}</span><span></span></div>
    <div class="scrollY">${rows}</div>
    <div class="addRow" style="border-top:1px solid var(--color-neutral-300)">
      <input class="fld-sm" style="flex:1 1 170px" data-f="menuTh" value="${esc(S.f.menuTh)}" placeholder="${esc(t.menuNamePh)}">
      <input class="fld-sm" style="flex:1 1 130px" data-f="menuEn" value="${esc(S.f.menuEn)}" placeholder="EN">
      <button class="btn-cycle" data-act="cycleMenuCat">${esc(catLabelOf(S.f.menuCat))}</button>
      <input class="fld-sm" style="flex:0 1 100px" data-f="menuPrice" value="${esc(S.f.menuPrice)}" placeholder="${esc(t.pricePh)}">
      ${S.f.menuCat !== 'drink' ? `
      <label style="display:flex;align-items:center;gap:6px;flex:none;padding:0 4px;font-size:12px;color:var(--color-neutral-700);cursor:pointer">
        <input type="checkbox" data-fchk="menuHasSpice" ${S.f.menuHasSpice ? 'checked' : ''}>
        ${esc(t.hasSpiceLabel)}
      </label>` : ''}
      <button class="btn-add" style="padding:10px 16px" data-act="addMenuItem">${esc(t.addBtn)}</button>
    </div>
  </div>`;
}

function adminPromosHtml() {
  const t = T();
  const rows = S.promos.map(p => {
    const days = t.dayNames.map((dn, i) => {
      const on = p.days.includes(i);
      return `<button class="promoDay" data-act="togglePromoDay" data-id="${esc(p.id)}" data-i="${i}" style="background:${on ? INK : 'transparent'};color:${on ? GROUND : 'var(--color-neutral-600)'}">${esc(dn)}</button>`;
    }).join('');
    return `
    <div class="promoRow" style="background:${p.active ? 'transparent' : SURF}">
      <span style="flex:1 1 220px;display:flex;flex-direction:column;gap:3px;min-width:0">
        <span style="font-size:15px;font-weight:700">${esc(L(p))}</span>
        <span style="font-size:12px;color:var(--color-neutral-700)">${esc(t.promoOff2 + ' ' + p.value + '%')}</span>
      </span>
      <span style="display:flex;gap:4px;flex:none">${days}</span>
      <button class="mono" data-act="togglePromo" data-id="${esc(p.id)}" style="flex:none;padding:7px 13px;border:0;cursor:pointer;font-size:10px;letter-spacing:.08em;background:${p.active ? RED : SURF};color:${p.active ? '#fff' : 'var(--color-neutral-600)'}">${esc(p.active ? t.promoOn : t.promoOff)}</button>
      <button class="btn-del" style="padding:6px 11px" data-act="delPromo" data-id="${esc(p.id)}">${esc(t.del)}</button>
    </div>`;
  }).join('');

  return `
  <div class="col">
    <div class="secHead secHead--flex"><b>${esc(t.promoTitle)}</b><span class="mono" style="font-size:11px;color:var(--color-neutral-600)">${esc(t.promoHint)}</span></div>
    ${rows}
    <div class="addRow">
      <input class="fld-sm" style="flex:1 1 220px" data-f="promoName" value="${esc(S.f.promoName)}" placeholder="${esc(t.promoNamePh)}">
      <input class="fld-sm" style="flex:0 1 120px" data-f="promoValue" value="${esc(S.f.promoValue)}" placeholder="${esc(t.promoValuePh)}">
      <button class="btn-add" style="padding:10px 16px" data-act="addPromo">${esc(t.addBtn)}</button>
    </div>
  </div>`;
}

function adminExpensesHtml() {
  const t = T();
  const sorted = S.expenses.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const total = S.expenses.reduce((a, e) => a + e.amount, 0);

  const rows = sorted.map(e => `
    <div class="grid-row g-exp">
      <span class="mono" style="font-size:12px">${esc(e.date)}</span>
      <span style="font-size:13px;font-weight:600">${esc(e.cat)}</span>
      <span style="font-size:13px;color:var(--color-neutral-700)">${esc(e.note)}</span>
      <span class="mono" style="text-align:right;font-size:14px;font-weight:600">${esc(baht(e.amount))}</span>
      <button class="btn-del" data-act="delExpense" data-id="${esc(e.id)}">${esc(t.del)}</button>
    </div>`).join('');

  return `
  <div class="col">
    <div class="expBar">
      <input class="fld-sm-ink" style="flex:0 1 160px" type="date" data-f="expDate" value="${esc(S.f.expDate)}">
      <button class="btn-cycle" style="background:var(--color-bg)" data-act="cycleExpCat">${esc(S.f.expCat)}</button>
      <input class="fld-sm-ink" style="flex:1 1 200px" data-f="expNote" value="${esc(S.f.expNote)}" placeholder="${esc(t.colNote)}">
      <input class="fld-sm-ink" style="flex:0 1 120px" data-f="expAmount" value="${esc(S.f.expAmount)}" placeholder="${esc(t.amountPh)}">
      <button class="btn-add" style="padding:10px 18px" data-act="addExpense">${esc(t.expAdd)}</button>
    </div>
    <div class="secHead" style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <span>${esc(t.expHistory)}</span>
      <span style="display:flex;align-items:baseline;gap:8px">
        <span class="mono" style="font-size:10px;letter-spacing:.1em;color:var(--color-neutral-600);font-weight:400">${esc(t.expTotal)}</span>
        <span class="mono" style="font-size:20px;font-weight:800">${esc(baht(total))}</span>
      </span>
    </div>
    <div class="grid-head g-exp"><span>${esc(t.colDate)}</span><span>${esc(t.colExpCat)}</span><span>${esc(t.colNote)}</span><span style="text-align:right">${esc(t.colAmount)}</span><span></span></div>
    <div class="scrollY" style="max-height:400px">${rows}</div>
  </div>`;
}

function adminDashHtml() {
  const t = T();
  const manager = S.role === 'manager';
  const expSum = S.expenses.reduce((a, e) => a + e.amount, 0);
  const closed = S.orders.filter(o => o.st === 'closed').length;

  const stats = [
    { label: t.dSales, value: baht(S.salesToday), sub: t.dSalesSub, bg: INK, fg: GROUND },
    { label: t.dOrders, value: String(closed), sub: t.dOrdersSub, bg: 'transparent', fg: INK },
    ...(manager ? [] : [{ label: t.dExpense, value: baht(expSum), sub: t.dExpenseSub, bg: 'transparent', fg: INK }]),
    { label: t.dProfit, value: baht(S.salesToday - expSum), sub: t.dProfitSub, bg: RED, fg: '#fff' }
  ].map(d => `
    <div class="dashStat" style="background:${d.bg};color:${d.fg}">
      <span class="mono" style="font-size:9px;letter-spacing:.12em;opacity:.75">${esc(d.label)}</span>
      <b>${esc(d.value)}</b>
      <span style="font-size:11px;opacity:.75">${esc(d.sub)}</span>
    </div>`).join('');

  const sold = {};
  S.orders.forEach(o => o.lines.forEach(l => {
    if (!sold[l.id]) sold[l.id] = { qty: 0, rev: 0 };
    sold[l.id].qty += l.qty;
    sold[l.id].rev += lineTotal(l);
  }));
  const top = Object.keys(sold).map(k => ({ id: k, ...sold[k] })).sort((a, b) => b.qty - a.qty).slice(0, 3);
  const topMax = top.length ? top[0].qty : 1;
  const topRows = top.map((x, i) => `
    <div class="barRow">
      <div class="barRow__top">
        <span class="mono" style="font-size:18px;font-weight:500;color:${RED}">${i + 1}</span>
        <span style="flex:1;font-size:15px;font-weight:700">${esc(L(dict(x.id)))}</span>
        <span class="mono" style="font-size:12px;color:var(--color-neutral-700)">${x.qty} ${esc(t.unitsSuffix)}</span>
        <span class="mono" style="font-size:15px;font-weight:600">${esc(baht(x.rev))}</span>
      </div>
      <div class="bar"><i style="width:${Math.round((x.qty / topMax) * 100)}%;background:${RED}"></i></div>
    </div>`).join('');

  const catMap = {};
  S.expenses.forEach(e => { catMap[e.cat] = (catMap[e.cat] || 0) + e.amount; });
  const catArr = Object.keys(catMap).map(k => ({ cat: k, amt: catMap[k] })).sort((a, b) => b.amt - a.amt);
  const catMax = catArr.length ? catArr[0].amt : 1;
  const catRows = catArr.map(c => `
    <div class="barRow">
      <div class="barRow__top">
        <span style="flex:1;font-size:14px;font-weight:600">${esc(c.cat)}</span>
        <span class="mono" style="font-size:11px;color:var(--color-neutral-600)">${expSum ? Math.round((c.amt / expSum) * 100) : 0}%</span>
        <span class="mono" style="font-size:15px;font-weight:600">${esc(baht(c.amt))}</span>
      </div>
      <div class="bar"><i style="width:${Math.round((c.amt / catMax) * 100)}%;background:${INK}"></i></div>
    </div>`).join('');

  return `
  <div class="col">
    <div class="dashStats">${stats}</div>
    <div class="split2--wide">
      <div class="${manager ? 'col' : 'col col--div'}">
        <div class="secHead">${esc(t.top3Title)}</div>
        ${topRows}
      </div>
      ${manager ? '' : `
      <div class="col">
        <div class="secHead">${esc(t.expByCat)}</div>
        ${catRows}
      </div>`}
    </div>
  </div>`;
}

function adminHtml() {
  const t = T();
  const manager = S.role === 'manager';
  const all = [
    { key: 'dash', label: t.atDash }, { key: 'menu', label: t.atMenu }, { key: 'promos', label: t.atPromos },
    { key: 'master', label: t.atMaster }, { key: 'users', label: t.atUsers }, { key: 'expenses', label: t.atExpenses }
  ];
  const allowed = manager ? all.filter(a => ['dash', 'menu', 'promos'].includes(a.key)) : all;
  if (!allowed.some(a => a.key === S.adminTab)) S.adminTab = allowed[0].key;

  const tabs = allowed.map(a =>
    `<button class="panel__tab" data-act="adminTab" data-v="${a.key}" style="${tabColors(S.adminTab === a.key)}">${esc(a.label)}</button>`).join('');

  const bodies = {
    master: adminMasterHtml, users: adminUsersHtml, menu: adminMenuHtml,
    promos: adminPromosHtml, expenses: adminExpensesHtml, dash: adminDashHtml
  };

  return `
  <div class="pageWrap">
    <div class="pageHead">
      <div style="display:flex;flex-direction:column;gap:5px;min-width:0">
        <div class="mono" style="font-size:10px;letter-spacing:.18em;color:var(--color-neutral-700)">${manager ? 'OWNER · DASHBOARD · MENU · PROMOTIONS' : 'ADMIN · MASTER DATA · EXPENSES · DASHBOARD'}</div>
        <div class="pageHead__title">${esc(manager ? t.adminHeadOwner : t.adminHead)}</div>
      </div>
      <p>${esc(manager ? t.adminNoteOwner : t.adminNote)}</p>
    </div>
    <div class="panel">
      <div class="panel__tabs">${tabs}</div>
      ${(bodies[S.adminTab] || adminDashHtml)()}
    </div>
  </div>`;
}

/* ── kitchen / bar ─────────────────────────────────────────── */
function stationHtml(kind) {
  const t = T();
  const orders = S.orders.filter(o => o.st === 'accepted' && hasKind(o, kind));

  const tickets = orders.map(o => {
    const st = o[kind], c = statusChip(st, o.type);
    const ready = st === 'ready';
    const btnLabel = ready ? t.doneAll : (o.type === 'dinein' ? t.markReady : t.markReadyTake);
    const btnBg = ready ? SURF : RED;
    const btnFg = ready ? 'var(--color-neutral-500)' : GROUND;
    const headBg = ready ? INK : SURF;
    const headFg = ready ? GROUND : INK;

    return `
    <div class="tick" style="background:${ready ? SURF : GROUND}">
      <div class="tick__head" style="background:${headBg};color:${headFg}">
        <span style="display:flex;align-items:baseline;gap:10px">
          <span class="mono" style="font-size:13px;font-weight:500;letter-spacing:.06em">${esc(o.id)}</span>
          <span style="font-size:15px;font-weight:800">${esc(whereOf(o))}</span>
        </span>
        <span style="display:flex;align-items:center;gap:9px">
          <span class="mono" style="font-size:10px;opacity:.8">${esc(o.at)}</span>
          <span class="chip" style="background:${c.bg};color:${c.fg};letter-spacing:.1em">${esc(c.label)}</span>
        </span>
      </div>
      <div class="tick__body">
        ${o.lines.filter(l => l.kind === kind).map(l => `
          <div class="tick__line">
            <span class="tick__qty">${l.qty}</span>
            <span style="flex:1;display:flex;flex-direction:column;gap:2px">
              <span class="tick__name">${esc(L(dict(l.id)))}</span>
              <span style="font-size:12px;color:var(--color-neutral-700)">${esc(optText(l))}</span>
              ${l.note ? `<span class="tick__lnote">! ${esc(l.note)}</span>` : ''}
            </span>
          </div>`).join('')}
        ${o.note ? `<div class="tick__onote">${esc(o.note)}</div>` : ''}
      </div>
      <div class="tick__acts">
        <button class="tick__go" data-act="kAdvance" data-id="${esc(o.id)}" data-v="${kind}" style="background:${btnBg};color:${btnFg}">${esc(btnLabel)}</button>
        ${st !== 'queued' ? `<button class="tick__undo" data-act="kUndo" data-id="${esc(o.id)}" data-v="${kind}">${esc(t.undo)}</button>` : ''}
      </div>
    </div>`;
  }).join('');

  const isFood = kind === 'food';
  return `
  <div class="kcol">
    <div class="kcol__head" style="background:${isFood ? INK : SURF};color:${isFood ? GROUND : INK}">
      <span class="kcol__title">${esc(isFood ? t.stFood : t.stDrink)}</span>
      <span class="mono" style="padding:3px 9px;background:${isFood ? RED : INK};color:${GROUND};font-size:11px">${orders.length}</span>
      <div class="grow"></div>
      <span class="mono" style="font-size:10px;letter-spacing:.1em;opacity:.8">${esc(isFood ? t.stFoodSub : t.stDrinkSub)}</span>
    </div>
    <div class="kcol__body">
      ${orders.length ? tickets : `<div style="padding:30px 6px;font-size:14px;color:var(--color-neutral-600)">${esc(isFood ? t.emptyFood : t.emptyDrink)}</div>`}
    </div>
  </div>`;
}

/** Shared by the kitchen's "new orders" strip: one order awaiting accept/reject. */
function newOrderCardHtml(o) {
  const t = T();
  return `
  <div class="ocard">
    <div class="ocard__top">
      <span style="display:flex;align-items:baseline;gap:10px">
        <span class="mono" style="font-size:13px;font-weight:500;letter-spacing:.08em">${esc(o.id)}</span>
        <span class="chip" style="background:${RED};color:${GROUND};letter-spacing:.1em">${esc(typeLabel(o.type))}</span>
      </span>
      <span style="font-size:18px;font-weight:800">${esc(whereOf(o))}</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${o.lines.map(l => `
        <div style="display:flex;gap:9px;align-items:baseline">
          <span class="mono" style="font-size:12px;color:var(--color-neutral-700)">${l.qty}×</span>
          <span style="flex:1;display:flex;flex-direction:column">
            <span style="font-size:13px;font-weight:600">${esc(L(dict(l.id)))}</span>
            <span style="font-size:11px;color:var(--color-neutral-600)">${esc(optText(l))}</span>
            ${l.note ? `<span style="font-size:11px;color:var(--color-accent-700);font-weight:600">“${esc(l.note)}”</span>` : ''}
          </span>
        </div>`).join('')}
    </div>
    ${o.note ? `<div style="padding:7px 9px;background:${GROUND};border-left:2px solid ${RED};font-size:12px;color:var(--color-accent-700)">${esc(o.note)}</div>` : ''}
    <div class="ocard__foot">
      <span class="mono" style="font-size:11px;color:var(--color-neutral-700)">${esc(o.at)}</span>
      <span class="mono" style="font-size:18px;font-weight:800">${esc(baht(orderTotal(o)))}</span>
    </div>
    <div style="display:flex;gap:8px">
      <button style="flex:1;padding:12px;border:0;background:${RED};color:${GROUND};cursor:pointer;font-size:14px;font-weight:700;text-align:left" data-act="accept" data-id="${esc(o.id)}">${esc(t.accept)}</button>
      ${hasKind(o, 'food') ? `<button class="btn-outline" style="padding:12px 14px" data-act="print" data-id="${esc(o.id)}" data-v="food" title="${esc(t.printFood)}" aria-label="${esc(t.printFood)}">${ico(ICON_PRINTER)}</button>` : ''}
      ${hasKind(o, 'drink') ? `<button class="btn-outline" style="padding:12px 14px" data-act="print" data-id="${esc(o.id)}" data-v="drink" title="${esc(t.printDrink)}" aria-label="${esc(t.printDrink)}">${ico(ICON_PRINTER)}</button>` : ''}
      <button class="btn-outline" style="padding:12px 14px;font-size:13px" data-act="reject" data-id="${esc(o.id)}">${esc(t.reject)}</button>
    </div>
  </div>`;
}

function kitchenHtml() {
  const t = T();
  return `
  <div class="pageWrap">
    <div class="pageHead">
      <div style="display:flex;flex-direction:column;gap:5px;min-width:0">
        <div class="mono" style="font-size:10px;letter-spacing:.18em;color:var(--color-neutral-700)">KITCHEN + BAR · ONE SCREEN, TWO COLUMNS</div>
        <div class="pageHead__title">${esc(t.kitchenHead)}</div>
      </div>
      <span class="hdr__badge" style="padding:7px 13px;font-size:11px;flex:none">${esc(t.roleKitchen)}</span>
    </div>
    <div class="kds">${stationHtml('food')}${stationHtml('drink')}</div>
  </div>`;
}

/* ── overlays ──────────────────────────────────────────────── */
function slipHtml() {
  if (!S.slip) return '';
  const t = T();
  const o = findOrder(S.slip.id);
  if (!o) return '';
  const kind = S.slip.station;
  const lines = kind === 'bill' ? o.lines : o.lines.filter(l => l.kind === kind);
  const eyebrow = kind === 'food' ? 'KITCHEN TICKET' : kind === 'drink' ? 'BAR TICKET' : 'RECEIPT';
  const label = kind === 'food' ? t.printFood : kind === 'drink' ? t.printDrink : t.printBill;
  const iconPath = kind === 'food' ? ICON_UTENSILS : kind === 'drink' ? ICON_CUP : ICON_CART;
  const stamp = new Date().toLocaleString('th-TH-u-ca-gregory', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return `
  <div class="${modalCls}">
    <div class="slip">
      <div class="slip__head">
        <div class="slip__stationRow">
          <span class="slip__stationIcon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>
          </span>
          <span class="slip__stationText">
            <span class="slip__stationEyebrow">${esc(eyebrow)}</span>
            <span class="slip__stationLabel">${esc(label)}</span>
          </span>
        </div>
        <span class="slip__id mono">${esc(o.id)}</span>
        <div class="slip__meta">
          <span>${esc(whereOf(o))} · ${esc(typeLabel(o.type))}</span>
          <span class="mono">${esc(stamp)}</span>
        </div>
      </div>
      <div class="slip__body">
        ${lines.map(l => `
          <div class="slip__line">
            <span class="slip__qty mono">${l.qty}</span>
            <span class="slip__item">
              <span class="slip__name">${esc(L(dict(l.id)))}</span>
              <span class="slip__opts">${esc(optText(l))}</span>
              ${l.note ? `<span class="slip__note">${esc(l.note)}</span>` : ''}
            </span>
            ${kind === 'bill' ? `
            <span class="slip__amt">
              <span class="mono slip__amt__unit">${esc(baht(l.price))}</span>
              <span class="mono slip__amt__sum">${esc(baht(lineTotal(l)))}</span>
            </span>` : ''}
          </div>`).join('')}
        ${o.note ? `<div class="slip__ordernote">${esc(o.note)}</div>` : ''}
        ${kind === 'bill' ? `<div class="slip__total"><span>${esc(t.total)}</span><span class="mono">${esc(baht(orderTotal(o)))}</span></div>` : ''}
      </div>
      <div class="modal__foot">
        <button class="primary" data-act="confirmPrint">${esc(t.sendToPrinter)}</button>
        <button class="ghost" data-act="closeSlip">${esc(t.close)}</button>
      </div>
    </div>
  </div>`;
}

function loginHtml() {
  if (!S.loginOpen) return '';
  const t = T();
  return `
  <div class="${modalCls} overlay--login" style="z-index:88">
    <div class="login">
      <div style="display:flex;flex-direction:column;align-items:center;gap:14px">
        <div class="login__mark">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"></path><path d="M7 2v20"></path><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"></path></svg>
        </div>
        <div class="login__shop">${esc(S.shopName)}</div>
      </div>
      <div class="login__card">
        <div class="login__form">
          <div style="display:flex;flex-direction:column;gap:3px">
            <div style="font-size:19px;font-weight:800">${esc(t.loginTitle)}</div>
            <div style="font-size:12px;color:var(--color-neutral-700)">${esc(t.loginSubtitle)}</div>
          </div>
          <div class="login__field">
            <label for="loginUser">${esc(t.loginUserPh)}</label>
            <input id="loginUser" data-inp="loginUser" value="${esc(S.loginUser)}" placeholder="${esc(t.loginUserPh)}" autocomplete="username">
          </div>
          <div class="login__field">
            <label for="loginPass">${esc(t.loginPassPh)}</label>
            <input id="loginPass" type="password" data-inp="loginPass" value="${esc(S.loginPass)}" placeholder="${esc(t.loginPassPh)}" autocomplete="current-password">
          </div>
          ${S.loginError ? `<div class="login__err">${esc(S.loginError)}</div>` : ''}
          <button class="login__submit" data-act="doLogin">${esc(t.loginSubmit)}</button>
        </div>
      </div>
      <button class="login__back" data-act="cancelLogin">${esc(t.backToSite)}</button>
    </div>
  </div>`;
}

function qdHtml() {
  if (!S.qdId) return '';
  const t = T();
  const qo = queueOrders();
  const idx = qo.findIndex(o => o.id === S.qdId);
  const o = qo[idx];
  if (!o) return '';

  const k = ostatus(o), c = statusChip(k, o.type);
  const headBg = k === 'ready' ? INK : SURF;
  const headFg = k === 'ready' ? GROUND : INK;
  const isOwner = S.role === 'owner';

  const lines = o.lines.map((l, i) => {
    const sc = statusChip(o[l.kind], o.type);
    const swapOpen = S.swapOrderId === o.id && S.swapLineIdx === i;
    const choices = S.menu.filter(m => m.kind === l.kind && m.id !== l.id && m.available !== false);
    return `
    <div style="display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;gap:10px;align-items:baseline">
        <span class="mono" style="font-size:12px;color:var(--color-neutral-700);flex:none">${l.qty}×</span>
        <span style="flex:1;display:flex;flex-direction:column;gap:2px;min-width:0">
          <span style="font-size:14px;font-weight:600">${esc(L(dict(l.id)))}</span>
          <span style="font-size:12px;color:var(--color-neutral-700)">${esc(optText(l))}</span>
          ${l.note ? `<span style="font-size:12px;color:var(--color-accent-700)">"${esc(l.note)}"</span>` : ''}
        </span>
        <span class="chip" style="background:${sc.bg};color:${sc.fg}">${esc((l.kind === 'food' ? t.stFood : t.stDrink) + ' · ' + sc.label)}</span>
      </div>
      ${isOwner ? `
        <button style="align-self:flex-start;padding:4px 9px;border:1px solid var(--color-neutral-600);background:transparent;cursor:pointer;font-size:11px;color:var(--color-neutral-700)" data-act="openSwap" data-id="${esc(o.id)}" data-i="${i}">${esc(t.outOfStockSwap)}</button>
        ${swapOpen ? `
        <div class="qd__swap">
          <select data-chg="swap" data-id="${esc(o.id)}" data-i="${i}">
            <option value="">${esc(t.chooseReplacement)}</option>
            ${choices.map(m => `<option value="${esc(m.id)}">${esc(L(m) + ' · ' + baht(m.price))}</option>`).join('')}
          </select>
          <button class="btn-outline" style="padding:8px 10px" data-act="closeSwap">${esc(t.close)}</button>
        </div>` : ''}` : ''}
    </div>`;
  }).join('');

  const statusOpts = [
    { key: 'accepted', label: t.sAccepted },
    { key: 'ready', label: o.type === 'dinein' ? t.sReady : t.sReadyTake }
  ].map(opt => `<button class="qd__statusOpt" data-act="qdStatus" data-id="${esc(o.id)}" data-v="${opt.key}" style="${tabColors(opt.key === k)}">${esc(opt.label)}</button>`).join('');

  return `
  <div class="${modalCls}" style="z-index:86">
    <div class="modal">
      <div class="qd__head" style="background:${headBg};color:${headFg}">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
          <span class="mono" style="font-size:11px;letter-spacing:.12em">${esc(o.id)} · ${esc(o.at)}</span>
          <span class="mono" style="font-size:10px;letter-spacing:.1em">${esc(t.queuePos + ' ' + (idx + 1) + '/' + qo.length)}</span>
        </div>
        <div class="qd__status">${esc(c.label)}</div>
        <div style="font-size:13px;opacity:.82">${esc(whereOf(o))} · ${esc(etaFor(k))}</div>
        ${o.custName ? `<div style="font-size:12px;opacity:.82">${esc(t.custLabel)} ${esc(o.custName)}${o.custPhone ? ' · ' + esc(o.custPhone) : ''}</div>` : ''}
      </div>
      <div style="padding:18px 20px;display:flex;flex-direction:column;border-bottom:1px solid var(--color-neutral-300)">${stepsHtml(o, 16)}</div>
      <div style="padding:16px 20px;display:flex;flex-direction:column;gap:9px">
        <div class="mono" style="font-size:10px;letter-spacing:.12em;color:var(--color-neutral-600)">${esc(t.queueItems)}</div>
        ${lines}
      </div>
      ${isOwner ? `
      <div class="qd__owner">
        <div class="mono" style="font-size:10px;letter-spacing:.12em;color:var(--color-neutral-700)">${esc(t.ownerUpdateStatus)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${statusOpts}</div>
        <div class="mono" style="font-size:10px;letter-spacing:.12em;color:var(--color-neutral-700);margin-top:6px">${esc(t.printKot)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${hasKind(o, 'food') ? `<button class="btn-outline" data-act="print" data-id="${esc(o.id)}" data-v="food">${esc(t.printFood)}</button>` : ''}
          ${hasKind(o, 'drink') ? `<button class="btn-outline" data-act="print" data-id="${esc(o.id)}" data-v="drink">${esc(t.printDrink)}</button>` : ''}
        </div>
      </div>` : ''}
      <div class="modal__foot">
        <button class="ghost wide" data-act="closeQd">${esc(t.close)}</button>
      </div>
    </div>
  </div>`;
}

function cancelHtml() {
  if (!S.cancelAsk) return '';
  const t = T();
  return `
  <div class="${modalCls}" style="z-index:85">
    <div class="modal modal--wide">
      <div style="padding:20px 22px 16px;display:flex;flex-direction:column;gap:9px">
        <div style="font-size:20px;font-weight:800">${esc(t.cancelTitle)}</div>
        <div class="pretty" style="font-size:13px;line-height:1.7;color:var(--color-neutral-700)">${esc(t.cancelBody)}</div>
        <div style="margin-top:4px;padding:10px 12px;background:${PAPER};border-left:2px solid ${RED};font-size:12px;line-height:1.6">${esc(t.cancelCallShop)} <strong>${esc(SHOP_PHONE)}</strong></div>
      </div>
      <div class="modal__foot">
        <button class="primary" data-act="doCancel">${esc(t.cancelConfirm)}</button>
        <button class="ghost" data-act="closeCancel">${esc(t.keepOrder)}</button>
      </div>
    </div>
  </div>`;
}

function readyAlertsHtml() {
  if (S.role !== 'owner' || !S.readyAlerts.length) return '';
  const t = T();
  return `
  <div class="readyAlerts">
    ${S.readyAlerts.map(a => `
    <button class="readyAlert" data-act="dismissReadyAlert" data-key="${esc(a.key)}">
      <span class="readyAlert__icon">${ico(ICON_BELL)}</span>
      <span class="readyAlert__text"><b>${esc(a.orderId)}</b> · ${esc(a.where)} ${esc(t.readyAlertText)}</span>
    </button>`).join('')}
  </div>`;
}

/* ── root ──────────────────────────────────────────────────── */
function loadingHtml() {
  return `<div class="app"><main class="main" style="align-items:center;justify-content:center;min-height:60vh">
    <div class="mono" style="font-size:13px;color:var(--color-neutral-600)">กำลังเชื่อมต่อ…</div>
  </main></div>`;
}

/* Every render() rebuilds the whole DOM (no diffing), which would normally
 * replay the riseIn entrance animation on *every* click — even one that just
 * bumps a quantity on the screen you're already looking at. screenCls/modalCls
 * only carry the animating class when the screen or open modal actually
 * changed identity since the last paint, so in-place updates stay still. */
let lastScreenKey = '', lastModalKey = '';
let screenCls = 'screen', modalCls = 'overlay';

function render() {
  if (!S.booted) {
    document.getElementById('root').innerHTML = loadingHtml();
    return;
  }

  const screenKey = S.role + '|' + S.cust + '|' + S.ownerTab + '|' + S.adminTab;
  screenCls = screenKey !== lastScreenKey ? 'screen screen-enter' : 'screen';
  lastScreenKey = screenKey;

  const modalKey = 'slip:' + (S.slip ? S.slip.id + ':' + S.slip.station : '')
    + '|qd:' + (S.qdId || '') + '|cancel:' + S.cancelAsk + '|login:' + S.loginOpen;
  modalCls = modalKey !== lastModalKey ? 'overlay overlay-enter' : 'overlay';
  lastModalKey = modalKey;

  const main = S.role === 'customer' ? customerHtml()
    : S.role === 'owner' ? ownerHtml()
    : S.role === 'kitchen' ? kitchenHtml()
    : adminHtml();

  document.getElementById('root').innerHTML = `
  <div class="app">
    ${headerHtml()}
    ${readyAlertsHtml()}
    ${S.toast ? `<div class="toast">${esc(S.toast)}</div>` : ''}
    <main class="main">${main}</main>
    ${slipHtml()}
    ${qdHtml()}
    ${cancelHtml()}
    ${loginHtml()}
  </div>`;

  document.documentElement.lang = S.lang;
}

/* ── event wiring ──────────────────────────────────────────── */
const root = document.getElementById('root');

root.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  await fn(el);
  render();
});

/* Text fields write straight to state so the caret survives; nothing on screen
   depends on them mid-keystroke. */
root.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.inp && INP[el.dataset.inp]) { INP[el.dataset.inp](el.value); return; }
  if (el.dataset.f && Object.prototype.hasOwnProperty.call(S.f, el.dataset.f)) S.f[el.dataset.f] = el.value;
  if (el.dataset.fchk && Object.prototype.hasOwnProperty.call(S.f, el.dataset.fchk)) S.f[el.dataset.fchk] = el.checked;
});

root.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.chg === 'table') { S.tableNo = Number(el.value) || 0; render(); }
  else if (el.dataset.chg === 'swap') { await doSwap(el.dataset.id, Number(el.dataset.i), el.value); render(); }
  else if (el.dataset.upload === 'menuPhoto') {
    const file = el.files[0];
    el.value = ''; // so re-picking the exact same file still fires change next time
    if (!file) return;
    await uploadMenuPhoto(el.dataset.id, file);
    render();
  }
});

root.addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  if (S.loginOpen && e.target.dataset.inp && e.target.dataset.inp.startsWith('login')) {
    e.preventDefault();
    await ACT.doLogin();
    render();
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (S.slip) S.slip = null;
  else if (S.qdId) ACT.closeQd();
  else if (S.cancelAsk) S.cancelAsk = false;
  else if (S.loginOpen) ACT.cancelLogin();
  else return;
  render();
});

/* ── boot + live sync ──────────────────────────────────────────
 * Poll rather than push (WebSockets): far simpler to get right, survives
 * ngrok/network hiccups on its own, and a few seconds' latency is plenty
 * for a restaurant queue. Skipped while the user is mid-keystroke so a poll
 * never rips focus out of a note field. */
function isEditingText() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && root.contains(el);
}

/* Audio can only start after a user gesture — grab the first click anywhere
 * on the page to unlock it, well before any ready-alert would ever need it. */
document.addEventListener('click', () => {
  if (audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { /* no audio, fine */ }
}, { once: true });

async function boot() {
  try {
    await refreshState();
  } catch (e) {
    document.getElementById('root').innerHTML =
      `<div style="padding:40px;font-family:monospace;font-size:13px">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้: ${esc(e.message)}</div>`;
    return;
  }
  S.booted = true;
  render();
  setInterval(async () => {
    if (isEditingText()) return;
    try { if (await refreshState()) render(); } catch (_) { /* try again next tick */ }
  }, 2500);
}

boot();
