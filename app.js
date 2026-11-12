'use strict';
/* Pocket Ledger — a local-first expense tracker. All data lives in IndexedDB on this device. */

const VERSION = '1.0.0';
const DB_NAME = 'pocket-ledger';
const STORES = ['transactions', 'categories', 'budgets', 'recurring', 'paymentMethods', 'prefs', 'receipts'];

const DEFAULT_CATS = [
  ['Groceries', '🛒', 'expense'], ['Takeout & delivery', '🍜', 'expense'], ['Travel', '🚕', 'expense'],
  ['Rent & housing', '🏠', 'expense'], ['Utilities', '💡', 'expense'], ['Subscriptions', '🔁', 'expense'],
  ['Shopping', '🛍️', 'expense'], ['Health', '💊', 'expense'], ['Entertainment', '🎬', 'expense'],
  ['Education', '🎓', 'expense'], ['Other', '📦', 'expense'],
  ['Salary', '💼', 'income'], ['Other income', '💵', 'income'],
];
const DEFAULT_PMS = ['Credit card', 'Debit card', 'Cash', 'Apple Pay', 'Bank transfer'];
const COLORS = ['#0f766e', '#d97706', '#2563eb', '#db2777', '#7c3aed', '#65a30d', '#dc2626', '#0891b2', '#ca8a04', '#64748b', '#9333ea', '#059669', '#ea580c'];
// Merchant keyword → category name, used only as a first guess for a merchant you have not logged before.
const HINTS = [
  ['uber eats', 'Takeout & delivery'], ['doordash', 'Takeout & delivery'], ['grubhub', 'Takeout & delivery'],
  ['uber one', 'Subscriptions'], ['netflix', 'Subscriptions'], ['spotify', 'Subscriptions'],
  ['uber', 'Travel'], ['lyft', 'Travel'],
  ['instacart', 'Groceries'], ['costco', 'Groceries'], ['kroger', 'Groceries'], ['patel brothers', 'Groceries'],
];
const FREQS = [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = cents => usd.format(cents / 100);
const toCents = v => Math.round(parseFloat(String(v).replace(/[^0-9.]/g, '')) * 100) || 0;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const monthDate = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1); };
const monthLabel = key => monthDate(key).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const daysInMonth = key => { const d = monthDate(key); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };
const shortDate = s => parseYmd(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const longDate = s => parseYmd(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');

/* ---------- IndexedDB ---------- */
let dbh;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function txn(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = dbh.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const all = store => txn(store, 'readonly', s => s.getAll());
const getOne = (store, id) => txn(store, 'readonly', s => s.get(id));
const put = (store, val) => txn(store, 'readwrite', s => { s.put(val); });
const del = (store, id) => txn(store, 'readwrite', s => { s.delete(id); });
const clearStore = store => txn(store, 'readwrite', s => { s.clear(); });
const bulkPut = (store, arr) => txn(store, 'readwrite', s => { arr.forEach(v => s.put(v)); });

/* ---------- state ---------- */
const S = {
  tx: [], cats: [], budgets: [], recurring: [], pms: [], prefs: {},
  view: 'home', month: today().slice(0, 7),
  f: { q: '', period: 'month', type: 'all', cat: 'all', pm: 'all', from: '', to: '' },
};
const V = $('#view');
const cat = id => S.cats.find(c => c.id === id);
const pm = id => S.pms.find(p => p.id === id);
const sortTx = () => S.tx.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
const inMonth = key => S.tx.filter(t => t.date.startsWith(key));
const sum = (list, type) => list.reduce((n, t) => n + (t.type === type ? t.amount : 0), 0);
const fp = t => [t.date, t.type, t.amount, (cat(t.categoryId)?.name || '').toLowerCase(), (t.merchant || '').trim().toLowerCase()].join('|');
const setPref = (k, v) => { S.prefs[k] = v; return put('prefs', { id: k, value: v }); };

async function loadAll() {
  [S.tx, S.cats, S.budgets, S.recurring, S.pms] = await Promise.all(['transactions', 'categories', 'budgets', 'recurring', 'paymentMethods'].map(all));
  S.prefs = {};
  (await all('prefs')).forEach(p => { S.prefs[p.id] = p.value; });
  S.cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  S.pms.sort((a, b) => (a.order || 0) - (b.order || 0));
  sortTx();
}
async function seed() {
  if (!S.cats.length) {
    S.cats = DEFAULT_CATS.map(([name, icon, type], i) => ({ id: uid(), name, icon, type, color: COLORS[i % COLORS.length], order: i }));
    await bulkPut('categories', S.cats);
  }
  if (!S.pms.length) {
    S.pms = DEFAULT_PMS.map((name, i) => ({ id: uid(), name, order: i }));
    await bulkPut('paymentMethods', S.pms);
  }
  await setPref('seeded', true);
}

/* ---------- toast, sheets, dialogs ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
const head = (title, action) => `<div class="sheet-head"><button type="button" data-act="close-sheet">Close</button><h2>${esc(title)}</h2>${action ? `<button type="button" class="do" data-do>${esc(action)}</button>` : '<button type="button" style="visibility:hidden">Close</button>'}</div>`;
function openSheet(html, { onClose, tall } = {}) {
  const el = document.createElement('div');
  el.className = 'sheet-wrap';
  el.innerHTML = `<div class="backdrop" data-act="close-sheet"></div><div class="sheet${tall ? ' tall' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  el._onClose = onClose;
  $('#sheets').append(el);
  return el;
}
function closeSheet(el) {
  el = el || $('#sheets').lastElementChild;
  if (!el || !el.isConnected) return;
  el.remove();
  el._onClose?.();
}
// Returns true (primary), 'alt' (secondary) or false (dismissed).
function confirmSheet(title, msg, ok = 'OK', danger = false, alt = '') {
  return new Promise(res => {
    let out = false;
    const el = openSheet(`${head(title)}<div class="sheet-body"><p>${esc(msg)}</p><div>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>
      ${alt ? `<button class="btn soft" data-alt>${esc(alt)}</button>` : ''}
      <button class="btn soft" data-act="close-sheet">Cancel</button></div></div>`, { onClose: () => res(out) });
    $('[data-ok]', el).onclick = () => { out = true; closeSheet(el); };
    if (alt) $('[data-alt]', el).onclick = () => { out = 'alt'; closeSheet(el); };
  });
}
// Generic small form. Resolves with values, 'delete', or null when dismissed.
function formSheet({ title, fields, submit = 'Save', del: delLabel }) {
  return new Promise(res => {
    let out = null;
    const body = fields.map(f => {
      if (f.type === 'checkbox') return `<label class="check"><input type="checkbox" name="${f.name}"${f.value ? ' checked' : ''}> ${esc(f.label)}</label>`;
      const lab = `<label for="ff-${f.name}">${esc(f.label)}</label>`;
      if (f.type === 'select') return `<div class="field">${lab}<select id="ff-${f.name}" name="${f.name}">${opts(f.options, f.value)}</select></div>`;
      if (f.type === 'money') return `<div class="field">${lab}<input id="ff-${f.name}" name="${f.name}" type="text" inputmode="decimal" placeholder="${esc(f.placeholder || '0.00')}" value="${f.value ? (f.value / 100).toFixed(2) : ''}" autocomplete="off"></div>`;
      return `<div class="field">${lab}<input id="ff-${f.name}" name="${f.name}" type="${f.type || 'text'}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value ?? '')}" autocomplete="off"${f.max ? ` maxlength="${f.max}"` : ''}></div>`;
    }).join('');
    const el = openSheet(`${head(title)}<form class="sheet-body">${body}<div><button class="btn primary" type="submit">${esc(submit)}</button>${delLabel ? `<button class="btn danger-ghost" type="button" data-del>${esc(delLabel)}</button>` : ''}</div></form>`, { onClose: () => res(out) });
    const form = $('form', el);
    form.onsubmit = e => {
      e.preventDefault();
      out = {};
      fields.forEach(f => { const i = form.elements[f.name]; out[f.name] = f.type === 'checkbox' ? i.checked : f.type === 'money' ? toCents(i.value) : i.value.trim(); });
      closeSheet(el);
    };
    if (delLabel) $('[data-del]', el).onclick = () => { out = 'delete'; closeSheet(el); };
  });
}

/* ---------- shared view pieces ---------- */
function txRow(t, showDate) {
  const c = cat(t.categoryId);
  const sub = [t.merchant ? c?.name : null, pm(t.paymentMethodId)?.name, showDate ? shortDate(t.date) : null, t.note || null, t.receiptId ? '📎' : null, t.recurringId ? '↻' : null].filter(Boolean).join(' · ');
  return `<button class="tx" data-act="edit-tx" data-id="${t.id}"><span class="ico" style="background:${c?.color || '#888888'}26">${esc(c?.icon || '❔')}</span><span class="mid"><b>${esc(t.merchant || c?.name || 'Uncategorized')}</b><small>${esc(sub)}</small></span><span class="amt ${t.type}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</span></button>`;
}
function barHtml(spent, budget) {
  const p = budget ? spent / budget : 0;
  return `<div class="bar"><i class="${p > 1 ? 'over' : p >= 0.8 ? 'warn' : ''}" style="width:${Math.min(100, p * 100).toFixed(1)}%"></i></div>`;
}
const budgetNote = (spent, budget) => spent > budget ? `${fmt(spent - budget)} over budget` : `${fmt(budget - spent)} left of ${fmt(budget)}`;
const monthNav = () => `<div class="monthnav"><button data-act="month" data-d="-1" aria-label="Previous month">‹</button><b>${monthLabel(S.month)}</b><button data-act="month" data-d="1" aria-label="Next month">›</button></div>`;
function delta(cur, prev) {
  if (!prev) return cur ? '<span class="muted">new</span>' : '';
  const p = Math.round((cur - prev) / prev * 100);
  if (!p) return '<span class="muted">no change</span>';
  return `<span class="${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
}
const byCat = list => { const m = new Map(); list.forEach(t => { if (t.type === 'expense') m.set(t.categoryId, (m.get(t.categoryId) || 0) + t.amount); }); return m; };

/* ---------- recurring ---------- */
function advance(r) {
  const d = parseYmd(r.nextDate);
  if (r.freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (r.freq === 'biweekly') d.setDate(d.getDate() + 14);
  else {
    const day = r.anchorDay || d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + (r.freq === 'yearly' ? 12 : 1));
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return ymd(d);
}
async function logRecurring(r, date) {
  const now = Date.now();
  const t = { id: uid(), type: r.type, amount: r.amount, categoryId: r.categoryId, merchant: r.name, paymentMethodId: r.paymentMethodId, date, note: '', receiptId: null, recurringId: r.id, createdAt: now, updatedAt: now };
  if (!S.tx.some(x => fp(x) === fp(t))) { await put('transactions', t); S.tx.push(t); sortTx(); }
  r.nextDate = advance(r);
  await put('recurring', r);
}
async function processRecurring() {
  const t = today();
  for (const r of S.recurring) {
    if (!r.auto || r.active === false) continue;
    for (let i = 0; i < 60 && r.nextDate <= t; i++) await logRecurring(r, r.nextDate);
  }
}
const upcoming = () => { const lim = ymd(addDays(new Date(), 30)); return S.recurring.filter(r => r.active !== false && r.nextDate <= lim).sort((a, b) => a.nextDate.localeCompare(b.nextDate)); };
function dueLabel(d) {
  const n = Math.round((parseYmd(d) - parseYmd(today())) / 864e5);
  if (n < 0) return `<span class="late">Overdue by ${-n} day${n === -1 ? '' : 's'}</span>`;
  return n === 0 ? '<span class="late">Due today</span>' : n === 1 ? 'Due tomorrow' : `Due ${shortDate(d)} · in ${n} days`;
}

/* ---------- views ---------- */
const TITLES = { home: 'Pocket Ledger', transactions: 'Transactions', analytics: 'Analytics', budgets: 'Budgets', settings: 'Settings' };
function render() {
  $('#title').textContent = TITLES[S.view];
  $$('#nav button').forEach(b => { const on = b.dataset.view === S.view; b.classList.toggle('on', on); on ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'); });
  VIEWS[S.view]();
}

const VIEWS = {
  home() {
    const mk = today().slice(0, 7), list = inMonth(mk), spent = sum(list, 'expense'), inc = sum(list, 'income');
    const ob = S.budgets.find(b => b.id === 'overall');
    const day = new Date().getDate();
    const bills = upcoming();
    const last = S.prefs.lastBackup ? new Date(S.prefs.lastBackup) : null;
    const stale = S.tx.length >= 5 && (!last || Date.now() - last > 14 * 864e5) && !(S.prefs.backupSnooze > Date.now());
    V.innerHTML = `
      <section class="hero">
        <div class="lbl">Spent in ${monthLabel(mk)}</div>
        <div class="big">${fmt(spent)}</div>
        ${ob ? `${barHtml(spent, ob.amount)}<div class="barnote">${budgetNote(spent, ob.amount)}</div>` : ''}
        <div class="trio">
          <div><small>Income</small><b>${fmt(inc)}</b></div>
          <div><small>Net</small><b>${fmt(inc - spent)}</b></div>
          <div><small>Per day</small><b>${fmt(Math.round(spent / day))}</b></div>
        </div>
      </section>
      ${stale ? `<div class="card banner"><p><b>Back up your data.</b> ${last ? `Last backup was ${last.toLocaleDateString()}.` : 'You have not made a backup yet.'} It only lives on this device.</p><button class="pill" data-act="backup">Back up</button><button class="link" data-act="snooze">Later</button></div>` : ''}
      <div class="sec"><h2>Upcoming bills</h2><button class="link" data-act="recurring">${S.recurring.length ? 'Manage' : 'Add'}</button></div>
      <div class="card flush">${bills.length ? bills.map(r => `<div class="bill"><span class="ico" style="background:${cat(r.categoryId)?.color || '#888888'}26">${esc(cat(r.categoryId)?.icon || '🔁')}</span><span class="mid"><b>${esc(r.name)}</b><small>${dueLabel(r.nextDate)}${r.auto ? ' · auto' : ''}</small></span><span class="amt ${r.type}">${fmt(r.amount)}</span>${r.auto ? '' : `<button class="pill" data-act="log-rec" data-id="${r.id}">Log</button>`}</div>`).join('')
        : `<div class="empty">${S.recurring.length ? 'Nothing due in the next 30 days.' : 'Add rent, subscriptions and other repeating bills to see what is coming up.'}</div>`}</div>
      <div class="sec"><h2>Recent</h2>${S.tx.length ? '<button class="link" data-act="nav" data-view="transactions">See all</button>' : ''}</div>
      <div class="card flush">${S.tx.length ? S.tx.slice(0, 6).map(t => txRow(t, true)).join('') : '<div class="empty"><b>No transactions yet</b>Tap the + button to record your first expense.</div>'}</div>`;
  },

  transactions() {
    const f = S.f;
    V.innerHTML = `<div class="filters">
        <input type="search" data-f="q" placeholder="Search merchant, category, note" value="${esc(f.q)}" aria-label="Search transactions" autocomplete="off">
        <div class="frow">
          <select data-f="period" aria-label="Date range">${opts([['month', 'This month'], ['last', 'Last month'], ['90', 'Last 90 days'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom range']], f.period)}</select>
          <select data-f="type" aria-label="Type">${opts([['all', 'Expenses & income'], ['expense', 'Expenses'], ['income', 'Income']], f.type)}</select>
          <select data-f="cat" aria-label="Category">${opts([['all', 'All categories'], ...S.cats.map(c => [c.id, `${c.icon} ${c.name}`])], f.cat)}</select>
          <select data-f="pm" aria-label="Payment method">${opts([['all', 'All payment methods'], ...S.pms.map(p => [p.id, p.name])], f.pm)}</select>
        </div>
        ${f.period === 'custom' ? `<div class="frow"><input type="date" data-f="from" value="${f.from}" aria-label="From date"><input type="date" data-f="to" value="${f.to}" aria-label="To date"></div>` : ''}
      </div><div id="txlist"></div>`;
    renderTxList();
  },

  analytics() {
    const mk = S.month, list = inMonth(mk), prev = inMonth(addMonths(mk, -1));
    const exp = sum(list, 'expense'), inc = sum(list, 'income'), pexp = sum(prev, 'expense'), pinc = sum(prev, 'income');
    const cur = byCat(list), pc = byCat(prev);
    const rows = [...cur].sort((a, b) => b[1] - a[1]);
    const expenses = list.filter(t => t.type === 'expense');
    const days = mk === today().slice(0, 7) ? new Date().getDate() : daysInMonth(mk);
    const biggest = expenses.reduce((m, t) => (!m || t.amount > m.amount ? t : m), null);
    const merch = new Map(); expenses.forEach(t => { if (t.merchant) merch.set(t.merchant, (merch.get(t.merchant) || 0) + t.amount); });
    const topM = [...merch].sort((a, b) => b[1] - a[1])[0];
    let acc = 0; const C = 2 * Math.PI * 70;
    const donut = rows.map(([id, amt]) => { const len = amt / exp * C; const s = `<circle cx="100" cy="100" r="70" fill="none" stroke="${cat(id)?.color || '#888'}" stroke-width="26" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}"/>`; acc += len; return s; }).join('');
    const months = [...Array(6)].map((_, i) => addMonths(mk, i - 5)).map(k => { const l = inMonth(k); return { k, e: sum(l, 'expense'), i: sum(l, 'income') }; });
    const max = Math.max(1, ...months.flatMap(d => [d.e, d.i]));
    const W = 320, H = 130, gw = W / 6, bw = 15;
    const bars = months.map((d, n) => { const x = n * gw + gw / 2, he = d.e / max * H, hi = d.i / max * H; return `<rect x="${x - bw - 1}" y="${H - hi}" width="${bw}" height="${hi}" rx="3" class="b-inc"/><rect x="${x + 1}" y="${H - he}" width="${bw}" height="${he}" rx="3" class="b-exp"/><text x="${x}" y="${H + 16}" text-anchor="middle">${monthDate(d.k).toLocaleDateString('en-US', { month: 'short' })}</text>`; }).join('');
    V.innerHTML = `${monthNav()}
      <div class="card"><div class="stats">
        <div><small>Spent</small><b>${fmt(exp)}</b><div class="sub">${delta(exp, pexp)} <span class="muted">vs last month</span></div></div>
        <div><small>Income</small><b>${fmt(inc)}</b><div class="sub muted">${pinc ? `${fmt(pinc)} last month` : '&nbsp;'}</div></div>
        <div><small>Net</small><b>${fmt(inc - exp)}</b></div>
        <div><small>Savings rate</small><b>${inc ? Math.round((inc - exp) / inc * 100) + '%' : '—'}</b></div>
      </div></div>
      <div class="sec"><h2>Monthly summary</h2></div>
      <div class="card facts">
        <div><span>Transactions</span><span>${list.length}</span></div>
        <div><span>Average spend per day</span><span>${fmt(Math.round(exp / days))}</span></div>
        <div><span>Largest expense</span><span>${biggest ? `${fmt(biggest.amount)} · ${esc(biggest.merchant || cat(biggest.categoryId)?.name || '')}` : '—'}</span></div>
        <div><span>Top merchant</span><span>${topM ? `${esc(topM[0])} · ${fmt(topM[1])}` : '—'}</span></div>
        <div><span>Top category</span><span>${rows[0] ? `${esc(cat(rows[0][0])?.name || 'Uncategorized')} · ${fmt(rows[0][1])}` : '—'}</span></div>
      </div>
      <div class="sec"><h2>Spending by category</h2></div>
      <div class="card">${rows.length ? `
        <svg class="donut" viewBox="0 0 200 200" role="img" aria-label="Spending by category"><g transform="rotate(-90 100 100)">${donut}</g><text x="100" y="98" text-anchor="middle" font-size="19">${fmt(exp)}</text><text class="dl" x="100" y="116" text-anchor="middle" font-size="11">spent</text></svg>
        ${rows.map(([id, amt]) => `<div class="catrow"><span class="dot" style="background:${cat(id)?.color || '#888'}"></span><span>${esc(cat(id)?.icon || '')} ${esc(cat(id)?.name || 'Uncategorized')}</span><span class="r">${fmt(amt)}<small>${Math.round(amt / exp * 100)}% · ${delta(amt, pc.get(id) || 0)}</small></span></div>`).join('')}`
        : '<div class="empty">No expenses recorded this month.</div>'}</div>
      <div class="sec"><h2>Last 6 months</h2></div>
      <div class="card">
        <div class="legend"><span><i style="background:var(--accent)"></i>Spent</span><span><i style="background:var(--muted);opacity:.45"></i>Income</span></div>
        <svg class="bars" viewBox="0 0 ${W} ${H + 22}" role="img" aria-label="Income and spending for the last six months">${bars}<line class="axis" x1="0" x2="${W}" y1="${H}" y2="${H}"/></svg>
        <table class="mini"><tr><th>Month</th><th>Spent</th><th>Income</th><th>Net</th></tr>${months.slice().reverse().map(d => `<tr><td>${monthDate(d.k).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</td><td>${fmt(d.e)}</td><td>${fmt(d.i)}</td><td>${fmt(d.i - d.e)}</td></tr>`).join('')}</table>
      </div>`;
  },

  budgets() {
    const list = inMonth(S.month), spent = sum(list, 'expense'), per = byCat(list);
    const ob = S.budgets.find(b => b.id === 'overall');
    const row = (id, label, s, b) => `<button class="bud" data-act="set-budget" data-id="${id}"><div class="top"><b>${label}</b><span class="num">${fmt(s)}${b ? ` <span class="muted">/ ${fmt(b.amount)}</span>` : ''}</span></div>${b ? `${barHtml(s, b.amount)}<div class="note">${budgetNote(s, b.amount)}</div>` : '<div class="note">Tap to set a monthly budget</div>'}</button>`;
    V.innerHTML = `${monthNav()}
      <div class="card flush">${row('overall', 'Total monthly budget', spent, ob)}</div>
      <div class="sec"><h2>By category</h2></div>
      <div class="card flush">${S.cats.filter(c => c.type === 'expense').map(c => row(c.id, `${esc(c.icon)} ${esc(c.name)}`, per.get(c.id) || 0, S.budgets.find(b => b.id === c.id))).join('')}</div>
      <p class="note">Budgets repeat every month. Set an amount to 0 to remove it.</p>`;
  },

  settings() {
    const th = S.prefs.theme || 'system';
    const last = S.prefs.lastBackup ? new Date(S.prefs.lastBackup).toLocaleString() : 'Never';
    V.innerHTML = `
      <div class="sec" style="margin-top:4px"><h2>Appearance</h2></div>
      <div class="seg">${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button data-act="theme" data-v="${v}" class="${th === v ? 'on' : ''}" aria-pressed="${th === v}">${l}</button>`).join('')}</div>
      <div class="sec"><h2>Customize</h2></div>
      <div class="card flush">
        <button class="rowbtn" data-act="cats"><span class="mid"><b>Categories</b><small>${S.cats.length} categories</small></span><span class="chev">›</span></button>
        <button class="rowbtn" data-act="pms"><span class="mid"><b>Payment methods</b><small>${S.pms.map(p => esc(p.name)).join(', ') || 'None'}</small></span><span class="chev">›</span></button>
        <button class="rowbtn" data-act="recurring"><span class="mid"><b>Recurring & bills</b><small>${S.recurring.length} set up</small></span><span class="chev">›</span></button>
      </div>
      <div class="sec"><h2>Backup & data</h2></div>
      <div class="card flush">
        <button class="rowbtn" data-act="backup"><span class="mid"><b>Back up now</b><small>Save everything to one JSON file</small></span><span class="chev">›</span></button>
        <label class="rowbtn"><span class="mid"><b>Restore from backup</b><small>Choose a Pocket Ledger JSON file</small></span><span class="chev">›</span><input type="file" data-file="restore" accept=".json,application/json" hidden></label>
        <button class="rowbtn" data-act="csv"><span class="mid"><b>Export CSV</b><small>All transactions, for a spreadsheet</small></span><span class="chev">›</span></button>
        <label class="rowbtn"><span class="mid"><b>Import CSV</b><small>Columns: Date, Type, Amount, Category, Merchant, Payment Method, Note</small></span><span class="chev">›</span><input type="file" data-file="csv" accept=".csv,text/csv" hidden></label>
      </div>
      <div class="card flush">
        <div class="kv"><span>Last backup</span><span>${esc(last)}</span></div>
        <div class="kv"><span>Transactions stored</span><span>${S.tx.length}</span></div>
        <div class="kv"><span>Protected storage</span><span id="persist">Checking…</span></div>
        <div class="kv"><span>Works offline</span><span id="offline">Checking…</span></div>
      </div>
      <p class="note"><b>Your data stays on this device.</b> Nothing is uploaded and there is no account. That also means it does not sync to other devices, and deleting the app or clearing Safari website data erases it. Back up regularly and keep the file in iCloud Drive or Files.</p>
      <div style="margin-top:18px"><button class="btn danger-ghost" data-act="erase">Erase all data</button></div>
      <p class="note" style="text-align:center;margin-top:6px">Pocket Ledger ${VERSION}</p>`;
    navigator.storage?.persisted?.().then(p => { const e = $('#persist'); if (e) e.textContent = p ? 'On' : 'Not granted yet'; }).catch(() => {});
    if (!navigator.storage?.persisted) $('#persist').textContent = 'Unavailable';
    const off = $('#offline');
    if (!('serviceWorker' in navigator)) off.textContent = 'Unavailable';
    else navigator.serviceWorker.getRegistration().then(r => { if (off.isConnected) off.textContent = r?.active ? 'Ready' : 'Not yet — reload once online'; });
  },
};

function filteredTx() {
  const f = S.f, t = today(), mk = t.slice(0, 7);
  let from = '0000', to = '9999';
  if (f.period === 'month') [from, to] = [mk + '-01', mk + '-31'];
  else if (f.period === 'last') { const k = addMonths(mk, -1); [from, to] = [k + '-01', k + '-31']; }
  else if (f.period === '90') from = ymd(addDays(new Date(), -90));
  else if (f.period === 'year') [from, to] = [t.slice(0, 4) + '-01-01', t.slice(0, 4) + '-12-31'];
  else if (f.period === 'custom') [from, to] = [f.from || '0000', f.to || '9999'];
  const q = f.q.trim().toLowerCase();
  return S.tx.filter(x => x.date >= from && x.date <= to
    && (f.type === 'all' || x.type === f.type) && (f.cat === 'all' || x.categoryId === f.cat) && (f.pm === 'all' || x.paymentMethodId === f.pm)
    && (!q || [x.merchant, x.note, cat(x.categoryId)?.name, pm(x.paymentMethodId)?.name, (x.amount / 100).toFixed(2)].some(v => v && v.toLowerCase().includes(q))));
}
function renderTxList() {
  const list = filteredTx(), box = $('#txlist');
  if (!box) return;
  if (!list.length) { box.innerHTML = `<div class="empty"><b>${S.tx.length ? 'Nothing matches' : 'No transactions yet'}</b>${S.tx.length ? 'Try a wider date range or clear the filters.' : 'Tap the + button to add one.'}</div>`; return; }
  const groups = new Map();
  list.forEach(t => { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); });
  box.innerHTML = `<p class="note" style="margin:12px 4px 0">${list.length} transaction${list.length === 1 ? '' : 's'} · spent ${fmt(sum(list, 'expense'))} · income ${fmt(sum(list, 'income'))}</p>`
    + [...groups].map(([d, items]) => `<div class="daterow"><span>${d === today() ? 'Today' : longDate(d)}</span><span class="num">${fmt(sum(items, 'income') - sum(items, 'expense'))}</span></div><div class="card flush">${items.map(t => txRow(t)).join('')}</div>`).join('');
}

/* ---------- add / edit transaction ---------- */
function fileToDataUrl(file, max = 1400) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image')); };
    img.src = url;
  });
}
function guessCat(merchant, type) {
  const m = merchant.trim().toLowerCase();
  if (!m) return null;
  const past = S.tx.find(t => t.type === type && (t.merchant || '').trim().toLowerCase() === m);
  if (past && cat(past.categoryId)) return past.categoryId;
  if (type !== 'expense') return null;
  const hit = HINTS.find(([k]) => m.includes(k));
  return hit ? S.cats.find(c => c.type === 'expense' && c.name === hit[1])?.id || null : null;
}

function openTxSheet(orig) {
  const isNew = !orig;
  const d = orig ? { ...orig } : { id: uid(), type: 'expense', amount: 0, categoryId: null, merchant: '', paymentMethodId: pm(S.prefs.lastPm) ? S.prefs.lastPm : S.pms[0]?.id || null, date: today(), note: '', receiptId: null };
  let newReceipt = null, dropReceipt = false, catTouched = !isNew, busy = false;
  const el = openSheet(`${head(isNew ? 'New transaction' : 'Edit transaction', 'Save')}
    <div class="sheet-body">
      <div class="seg" id="f-type"><button type="button" data-t="expense">Expense</button><button type="button" data-t="income">Income</button></div>
      <div class="amount"><span>$</span><input id="f-amt" type="text" inputmode="decimal" placeholder="0.00" aria-label="Amount" autocomplete="off" value="${d.amount ? (d.amount / 100).toFixed(2) : ''}"></div>
      <div><span class="lab">Category</span><div class="chips" id="f-cats"></div></div>
      <div><label class="lab" for="f-merchant">Merchant (optional)</label><input id="f-merchant" type="text" placeholder="Where?" autocomplete="off" autocapitalize="words" value="${esc(d.merchant)}"><div class="chips sug" id="f-sug" style="margin-top:7px"></div></div>
      <div><span class="lab">Payment method</span><div class="chips" id="f-pms"></div></div>
      <div class="two">
        <div><label class="lab" for="f-date">Date</label><input id="f-date" type="date" value="${d.date}"></div>
        <div><span class="lab">Receipt</span><label class="btn soft" style="min-height:46px;font-weight:600;font-size:15px">📎 Attach<input id="f-file" type="file" accept="image/*" hidden></label></div>
      </div>
      <div class="thumb" id="f-thumb" hidden><img alt="Receipt" id="f-img"><button type="button" class="link" id="f-view">View</button><button type="button" class="link" id="f-rm" style="color:var(--danger)">Remove</button></div>
      <div><label class="lab" for="f-note">Note (optional)</label><input id="f-note" type="text" autocomplete="off" value="${esc(d.note || '')}"></div>
      ${isNew ? '' : '<button type="button" class="btn danger-ghost" id="f-del">Delete transaction</button>'}
    </div>`, { tall: true });
  const q = s => $(s, el);
  const amt = q('#f-amt'), merchant = q('#f-merchant');

  const paint = () => {
    $$('#f-type button', el).forEach(b => b.classList.toggle('on', b.dataset.t === d.type));
    const recents = S.prefs.recentCats || [];
    const rank = c => { const i = recents.indexOf(c.id); return i < 0 ? 1e3 + (c.order || 0) : i; };
    q('#f-cats').innerHTML = S.cats.filter(c => c.type === d.type).sort((a, b) => rank(a) - rank(b))
      .map(c => `<button type="button" class="chip${c.id === d.categoryId ? ' on' : ''}" data-cat="${c.id}" aria-pressed="${c.id === d.categoryId}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');
    q('#f-pms').innerHTML = S.pms.map(p => `<button type="button" class="chip${p.id === d.paymentMethodId ? ' on' : ''}" data-pm="${p.id}" aria-pressed="${p.id === d.paymentMethodId}">${esc(p.name)}</button>`).join('');
  };
  const paintSug = () => {
    const v = merchant.value.trim().toLowerCase(), seen = new Set(), out = [];
    for (const t of S.tx) {
      const m = (t.merchant || '').trim(), k = m.toLowerCase();
      if (!m || t.type !== d.type || seen.has(k) || k === v || (v && !k.includes(v))) continue;
      seen.add(k); out.push(m);
      if (out.length >= 6) break;
    }
    q('#f-sug').innerHTML = out.map(m => `<button type="button" class="chip" data-m="${esc(m)}">${esc(m)}</button>`).join('');
  };
  const showThumb = src => { q('#f-thumb').hidden = !src; if (src) q('#f-img').src = src; };
  const applyGuess = () => { if (catTouched) return; const g = guessCat(merchant.value, d.type); if (g) { d.categoryId = g; paint(); } };

  paint(); paintSug();
  if (d.receiptId) getOne('receipts', d.receiptId).then(r => r && showThumb(r.dataUrl));

  q('#f-type').onclick = e => { const b = e.target.closest('[data-t]'); if (!b || b.dataset.t === d.type) return; d.type = b.dataset.t; d.categoryId = null; catTouched = false; paint(); paintSug(); applyGuess(); };
  q('#f-cats').onclick = e => { const b = e.target.closest('[data-cat]'); if (!b) return; d.categoryId = b.dataset.cat; catTouched = true; paint(); };
  q('#f-pms').onclick = e => { const b = e.target.closest('[data-pm]'); if (!b) return; d.paymentMethodId = b.dataset.pm; paint(); };
  q('#f-sug').onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; merchant.value = b.dataset.m; applyGuess(); paintSug(); };
  merchant.oninput = () => { paintSug(); applyGuess(); };
  q('#f-file').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { newReceipt = await fileToDataUrl(file); dropReceipt = false; showThumb(newReceipt); } catch (err) { toast(err.message); }
    e.target.value = '';
  };
  q('#f-rm').onclick = () => { newReceipt = null; dropReceipt = true; showThumb(null); };
  q('#f-view').onclick = () => { const v = document.createElement('div'); v.className = 'viewer'; v.innerHTML = `<img alt="Receipt" src="${q('#f-img').src}">`; v.onclick = () => v.remove(); document.body.append(v); };

  const save = async () => {
    if (busy) return;
    d.amount = toCents(amt.value); d.merchant = merchant.value.trim(); d.date = q('#f-date').value || today(); d.note = q('#f-note').value.trim();
    if (!(d.amount > 0)) { toast('Enter an amount'); amt.focus(); return; }
    if (!d.categoryId) { toast('Pick a category'); return; }
    busy = true;
    try {
      const dupe = S.tx.find(t => t.id !== d.id && fp(t) === fp(d));
      if (dupe && (isNew || fp(orig) !== fp(d))) {
        const ok = await confirmSheet('Possible duplicate', `You already recorded ${fmt(d.amount)}${d.merchant ? ' at ' + d.merchant : ''} in ${cat(d.categoryId).name} on ${longDate(d.date)}. Save this one too?`, 'Save anyway');
        if (!ok) return;
      }
      if (newReceipt || dropReceipt) {
        if (d.receiptId) await del('receipts', d.receiptId);
        d.receiptId = null;
        if (newReceipt) { d.receiptId = uid(); await put('receipts', { id: d.receiptId, dataUrl: newReceipt }); }
      }
      d.updatedAt = Date.now(); if (isNew) d.createdAt = d.updatedAt;
      await put('transactions', d);
      const i = S.tx.findIndex(t => t.id === d.id);
      if (i >= 0) S.tx[i] = d; else S.tx.push(d);
      sortTx();
      await setPref('recentCats', [d.categoryId, ...(S.prefs.recentCats || []).filter(x => x !== d.categoryId)].slice(0, 12));
      if (d.paymentMethodId) await setPref('lastPm', d.paymentMethodId);
      closeSheet(el); toast(isNew ? 'Saved' : 'Updated'); render();
      navigator.storage?.persist?.().catch(() => {});
    } catch (err) { toast('Could not save: ' + err.message); } finally { busy = false; }
  };
  q('[data-do]').onclick = save;
  amt.onkeydown = merchant.onkeydown = q('#f-note').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  if (!isNew) q('#f-del').onclick = async () => {
    if (!await confirmSheet('Delete transaction?', `${fmt(d.amount)} · ${d.merchant || cat(d.categoryId)?.name || ''} · ${longDate(d.date)}. This cannot be undone.`, 'Delete', true)) return;
    await del('transactions', d.id);
    if (d.receiptId) await del('receipts', d.receiptId);
    S.tx = S.tx.filter(t => t.id !== d.id);
    closeSheet(el); toast('Deleted'); render();
  };
  if (isNew) amt.focus();
}

/* ---------- manage sheets ---------- */
function manageSheet(title, addLabel, rowsFn, onAdd, onEdit) {
  const el = openSheet(`${head(title)}<div class="sheet-body"><div class="card flush" style="margin:0" data-list></div><button class="btn primary" data-add>${esc(addLabel)}</button></div>`, { tall: true, onClose: render });
  const paint = () => { $('[data-list]', el).innerHTML = rowsFn() || '<div class="empty">Nothing here yet.</div>'; };
  paint();
  $('[data-add]', el).onclick = async () => { await onAdd(); paint(); };
  $('[data-list]', el).onclick = async e => { const b = e.target.closest('[data-id]'); if (!b) return; await onEdit(b.dataset.id); paint(); };
}

function openCategories() {
  const fields = (c, isNew) => [
    { name: 'name', label: 'Name', value: c.name, max: 30 },
    { name: 'icon', label: 'Icon (one emoji)', value: c.icon, max: 4 },
    ...(isNew ? [{ name: 'type', label: 'Used for', type: 'select', value: 'expense', options: [['expense', 'Expenses'], ['income', 'Income']] }] : []),
  ];
  const clash = (name, type, id) => S.cats.some(c => c.id !== id && c.type === type && c.name.toLowerCase() === name.toLowerCase());
  manageSheet('Categories', 'Add category',
    () => S.cats.map(c => `<button class="rowbtn" data-id="${c.id}"><span class="ico" style="background:${c.color}26">${esc(c.icon)}</span><span class="mid"><b>${esc(c.name)}</b><small>${c.type === 'income' ? 'Income' : 'Expense'}</small></span><span class="chev">›</span></button>`).join(''),
    async () => {
      const v = await formSheet({ title: 'New category', fields: fields({ name: '', icon: '🏷️' }, true), submit: 'Add' });
      if (!v || !v.name) return;
      if (clash(v.name, v.type)) return toast('That category already exists');
      const c = { id: uid(), name: v.name, icon: v.icon || '🏷️', type: v.type, color: COLORS[S.cats.length % COLORS.length], order: Math.max(0, ...S.cats.map(x => x.order || 0)) + 1 };
      await put('categories', c); S.cats.push(c);
    },
    async id => {
      const c = cat(id);
      const v = await formSheet({ title: 'Edit category', fields: fields(c), del: 'Delete category' });
      if (!v) return;
      if (v === 'delete') {
        const used = S.tx.filter(t => t.categoryId === id);
        let fallback = null;
        if (used.length) {
          const fname = c.type === 'income' ? 'Other income' : 'Other';
          fallback = S.cats.find(x => x.type === c.type && x.name === fname);
          if (fallback?.id === id) return toast(`"${fname}" is in use by ${used.length} transactions and cannot be deleted`);
          if (!await confirmSheet('Delete category?', `${used.length} transaction${used.length === 1 ? '' : 's'} in "${c.name}" will move to "${fname}".`, 'Delete', true)) return;
          if (!fallback) { fallback = { id: uid(), name: fname, icon: '📦', type: c.type, color: '#64748b', order: 999 }; await put('categories', fallback); S.cats.push(fallback); }
          used.forEach(t => { t.categoryId = fallback.id; });
          await bulkPut('transactions', used);
        }
        await del('categories', id); await del('budgets', id);
        S.cats = S.cats.filter(x => x.id !== id); S.budgets = S.budgets.filter(b => b.id !== id);
        for (const r of S.recurring.filter(r => r.categoryId === id)) { r.categoryId = fallback?.id || null; await put('recurring', r); }
        return;
      }
      if (!v.name) return;
      if (clash(v.name, c.type, id)) return toast('That category already exists');
      c.name = v.name; c.icon = v.icon || c.icon;
      await put('categories', c);
    });
}

function openPaymentMethods() {
  manageSheet('Payment methods', 'Add payment method',
    () => S.pms.map(p => `<button class="rowbtn" data-id="${p.id}"><span class="mid"><b>${esc(p.name)}</b></span><span class="chev">›</span></button>`).join(''),
    async () => {
      const v = await formSheet({ title: 'New payment method', fields: [{ name: 'name', label: 'Name', value: '', placeholder: 'e.g. Amex Gold', max: 30 }], submit: 'Add' });
      if (!v || !v.name) return;
      const p = { id: uid(), name: v.name, order: Math.max(0, ...S.pms.map(x => x.order || 0)) + 1 };
      await put('paymentMethods', p); S.pms.push(p);
    },
    async id => {
      const p = pm(id);
      const v = await formSheet({ title: 'Edit payment method', fields: [{ name: 'name', label: 'Name', value: p.name, max: 30 }], del: 'Delete payment method' });
      if (!v) return;
      if (v === 'delete') { await del('paymentMethods', id); S.pms = S.pms.filter(x => x.id !== id); return; }
      if (v.name) { p.name = v.name; await put('paymentMethods', p); }
    });
}

function openRecurring() {
  const edit = async r => {
    const isNew = !r;
    r = r || { id: uid(), name: '', amount: 0, type: 'expense', categoryId: S.cats.find(c => c.type === 'expense')?.id, paymentMethodId: S.pms[0]?.id || '', freq: 'monthly', nextDate: today(), auto: false, active: true };
    const v = await formSheet({
      title: isNew ? 'New recurring item' : 'Edit recurring item', submit: isNew ? 'Add' : 'Save', del: isNew ? '' : 'Delete',
      fields: [
        { name: 'name', label: 'Name', value: r.name, placeholder: 'e.g. Rent, Netflix, Paycheck', max: 40 },
        { name: 'amount', label: 'Amount', type: 'money', value: r.amount },
        { name: 'categoryId', label: 'Category', type: 'select', value: r.categoryId, options: S.cats.map(c => [c.id, `${c.icon} ${c.name}${c.type === 'income' ? ' (income)' : ''}`]) },
        { name: 'paymentMethodId', label: 'Payment method', type: 'select', value: r.paymentMethodId, options: S.pms.map(p => [p.id, p.name]) },
        { name: 'freq', label: 'Repeats', type: 'select', value: r.freq, options: FREQS },
        { name: 'nextDate', label: 'Next due date', type: 'date', value: r.nextDate },
        { name: 'auto', label: 'Add the transaction automatically on the due date', type: 'checkbox', value: r.auto },
      ],
    });
    if (!v) return;
    if (v === 'delete') { await del('recurring', r.id); S.recurring = S.recurring.filter(x => x.id !== r.id); return; }
    if (!v.name || !(v.amount > 0) || !v.nextDate) return toast('Name, amount and due date are required');
    Object.assign(r, v, { type: cat(v.categoryId)?.type || 'expense', anchorDay: parseYmd(v.nextDate).getDate() });
    await put('recurring', r);
    if (isNew) S.recurring.push(r);
    await processRecurring();
  };
  manageSheet('Recurring & bills', 'Add recurring item',
    () => S.recurring.slice().sort((a, b) => a.nextDate.localeCompare(b.nextDate)).map(r => `<button class="rowbtn" data-id="${r.id}"><span class="ico" style="background:${cat(r.categoryId)?.color || '#888888'}26">${esc(cat(r.categoryId)?.icon || '🔁')}</span><span class="mid"><b>${esc(r.name)}</b><small>${FREQS.find(f => f[0] === r.freq)?.[1]} · next ${shortDate(r.nextDate)}${r.auto ? ' · auto' : ''}</small></span><span class="amt ${r.type}">${fmt(r.amount)}</span></button>`).join(''),
    () => edit(), id => edit(S.recurring.find(r => r.id === id)));
}

/* ---------- backup, restore, CSV ---------- */
async function deliver(name, mime, text) {
  const file = new File([text], name, { type: mime });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
async function buildBackup() {
  const data = {};
  for (const s of STORES) data[s] = await all(s);
  return { app: 'pocket-ledger', version: 1, exportedAt: new Date().toISOString(), data };
}
async function backup() {
  const text = JSON.stringify(await buildBackup());
  if (await deliver(`pocket-ledger-backup-${today()}.json`, 'application/json', text)) { await setPref('lastBackup', new Date().toISOString()); toast('Backup created'); render(); }
}
async function restore(file) {
  let b;
  try { b = JSON.parse(await file.text()); } catch { return toast('That file is not a valid backup'); }
  if (b?.app !== 'pocket-ledger' || !b.data || !Array.isArray(b.data.transactions)) return toast('That file is not a Pocket Ledger backup');
  const d = b.data;
  const choice = await confirmSheet('Restore backup', `This backup from ${new Date(b.exportedAt).toLocaleString()} holds ${d.transactions.length} transactions. Merge adds whatever is missing here and skips duplicates. Replace erases what is on this device first.`, 'Merge', false, 'Replace everything');
  if (!choice) return;
  if (choice === 'alt') {
    if (!await confirmSheet('Replace everything?', 'All data currently on this device will be erased and replaced with the backup.', 'Replace', true)) return;
    for (const s of STORES) { await clearStore(s); await bulkPut(s, d[s] || []); }
    await loadAll(); applyTheme(); render();
    return toast(`Restored ${d.transactions.length} transactions`);
  }
  const catMap = {}, pmMap = {};
  for (const c of d.categories || []) {
    const ex = cat(c.id) || S.cats.find(x => x.type === c.type && x.name.toLowerCase() === c.name.toLowerCase());
    if (ex) catMap[c.id] = ex.id; else { await put('categories', c); S.cats.push(c); catMap[c.id] = c.id; }
  }
  for (const p of d.paymentMethods || []) {
    const ex = pm(p.id) || S.pms.find(x => x.name.toLowerCase() === p.name.toLowerCase());
    if (ex) pmMap[p.id] = ex.id; else { await put('paymentMethods', p); S.pms.push(p); pmMap[p.id] = p.id; }
  }
  const ids = new Set(S.tx.map(t => t.id)), fps = new Set(S.tx.map(fp)), rec = new Map((d.receipts || []).map(r => [r.id, r]));
  const fresh = [], freshRec = [];
  let skipped = 0;
  for (const t of d.transactions) {
    const nt = { ...t, categoryId: catMap[t.categoryId] ?? t.categoryId, paymentMethodId: pmMap[t.paymentMethodId] ?? t.paymentMethodId };
    if (ids.has(nt.id) || fps.has(fp(nt))) { skipped++; continue; }
    ids.add(nt.id); fps.add(fp(nt)); fresh.push(nt);
    if (nt.receiptId && rec.has(nt.receiptId)) freshRec.push(rec.get(nt.receiptId));
  }
  await bulkPut('transactions', fresh); await bulkPut('receipts', freshRec);
  for (const bu of d.budgets || []) { const id = bu.id === 'overall' ? 'overall' : catMap[bu.id]; if (id && !S.budgets.some(x => x.id === id)) await put('budgets', { ...bu, id }); }
  for (const r of d.recurring || []) {
    if (S.recurring.some(x => x.id === r.id || (x.name.toLowerCase() === r.name.toLowerCase() && x.amount === r.amount))) continue;
    await put('recurring', { ...r, categoryId: catMap[r.categoryId] ?? r.categoryId, paymentMethodId: pmMap[r.paymentMethodId] ?? r.paymentMethodId });
  }
  await loadAll(); render();
  toast(`Added ${fresh.length}, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
}

const CSV_HEAD = ['Date', 'Type', 'Amount', 'Category', 'Merchant', 'Payment Method', 'Note'];
const csvCell = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
async function exportCsv() {
  if (!S.tx.length) return toast('No transactions to export');
  const rows = S.tx.map(t => [t.date, t.type, (t.amount / 100).toFixed(2), cat(t.categoryId)?.name || '', t.merchant || '', pm(t.paymentMethodId)?.name || '', t.note || '']);
  const text = [CSV_HEAD, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  if (await deliver(`pocket-ledger-${today()}.csv`, 'text/csv', text)) toast('CSV exported');
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
function normDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}
async function importCsv(file) {
  const rows = parseCsv(await file.text());
  if (rows.length < 2) return toast('That CSV has no rows');
  const h = rows[0].map(x => x.trim().toLowerCase());
  const col = (...names) => h.findIndex(x => names.includes(x));
  const ci = { date: col('date'), type: col('type'), amount: col('amount'), cat: col('category'), merchant: col('merchant', 'description', 'payee'), pm: col('payment method', 'payment', 'account'), note: col('note', 'notes', 'memo') };
  if (ci.date < 0 || ci.amount < 0) return toast('The CSV needs at least Date and Amount columns');
  const fps = new Set(S.tx.map(fp)), fresh = [];
  let skipped = 0, bad = 0;
  for (const r of rows.slice(1)) {
    const get = i => (i >= 0 ? (r[i] || '').trim() : '');
    const date = normDate(get(ci.date)), amount = toCents(get(ci.amount));
    if (!date || !(amount > 0)) { bad++; continue; }
    const type = get(ci.type).toLowerCase() === 'income' ? 'income' : 'expense';
    const cname = get(ci.cat) || (type === 'income' ? 'Other income' : 'Other');
    let c = S.cats.find(x => x.type === type && x.name.toLowerCase() === cname.toLowerCase());
    if (!c) { c = { id: uid(), name: cname, icon: '🏷️', type, color: COLORS[S.cats.length % COLORS.length], order: Math.max(0, ...S.cats.map(x => x.order || 0)) + 1 }; await put('categories', c); S.cats.push(c); }
    const pname = get(ci.pm);
    let p = pname ? S.pms.find(x => x.name.toLowerCase() === pname.toLowerCase()) : null;
    if (pname && !p) { p = { id: uid(), name: pname, order: Math.max(0, ...S.pms.map(x => x.order || 0)) + 1 }; await put('paymentMethods', p); S.pms.push(p); }
    const now = Date.now();
    const t = { id: uid(), type, amount, categoryId: c.id, merchant: get(ci.merchant), paymentMethodId: p?.id || null, date, note: get(ci.note), receiptId: null, createdAt: now, updatedAt: now };
    if (fps.has(fp(t))) { skipped++; continue; }
    fps.add(fp(t)); fresh.push(t);
  }
  await bulkPut('transactions', fresh);
  S.tx.push(...fresh); sortTx(); render();
  toast(`Imported ${fresh.length}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}${bad ? `, ${bad} unreadable` : ''}`);
}

/* ---------- theme ---------- */
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = S.prefs.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && darkMq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = dark ? '#0b1513' : '#10231f';
}
darkMq.addEventListener?.('change', applyTheme);

/* ---------- actions ---------- */
const ACT = {
  nav(b) { S.view = b.dataset.view; render(); V.scrollTop = 0; },
  add() { openTxSheet(); },
  'edit-tx'(b) { const t = S.tx.find(x => x.id === b.dataset.id); if (t) openTxSheet(t); },
  'close-sheet'(b) { closeSheet(b.closest('.sheet-wrap')); },
  month(b) { S.month = addMonths(S.month, +b.dataset.d); render(); },
  async theme(b) { await setPref('theme', b.dataset.v); applyTheme(); render(); },
  cats: openCategories, pms: openPaymentMethods, recurring: openRecurring,
  backup, csv: exportCsv,
  async snooze() { await setPref('backupSnooze', Date.now() + 7 * 864e5); render(); },
  async 'log-rec'(b) { const r = S.recurring.find(x => x.id === b.dataset.id); if (!r) return; await logRecurring(r, r.nextDate < today() ? r.nextDate : today()); toast(`Logged ${r.name}`); render(); },
  async 'set-budget'(b) {
    const id = b.dataset.id, ex = S.budgets.find(x => x.id === id);
    const v = await formSheet({ title: id === 'overall' ? 'Total monthly budget' : `${cat(id)?.name} budget`, fields: [{ name: 'amount', label: 'Monthly amount', type: 'money', value: ex?.amount }] });
    if (!v) return;
    if (v.amount > 0) { const rec = { id, amount: v.amount }; await put('budgets', rec); S.budgets = [...S.budgets.filter(x => x.id !== id), rec]; }
    else { await del('budgets', id); S.budgets = S.budgets.filter(x => x.id !== id); }
    render();
  },
  async erase() {
    if (!await confirmSheet('Erase all data?', 'Every transaction, budget, category, recurring item and receipt on this device will be permanently deleted. Make a backup first if you might want it back.', 'Erase everything', true)) return;
    for (const s of STORES) await clearStore(s);
    await loadAll(); await seed(); applyTheme(); render(); toast('All data erased');
  },
};
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) ACT[b.dataset.act]?.(b); });
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.file) { const file = t.files[0]; t.value = ''; if (file) (t.dataset.file === 'restore' ? restore : importCsv)(file).catch(err => toast('Import failed: ' + err.message)); }
  else if (t.dataset.f && t.tagName === 'SELECT') { S.f[t.dataset.f] = t.value; render(); }
  else if (t.dataset.f && t.type === 'date') { S.f[t.dataset.f] = t.value; renderTxList(); }
});
document.addEventListener('input', e => { if (e.target.dataset.f === 'q') { S.f.q = e.target.value; renderTxList(); } });

/* ---------- start ---------- */
(async () => {
  try {
    dbh = await openDB();
    await loadAll();
    if (!S.prefs.seeded) await seed();
    applyTheme();
    await processRecurring();
    render();
  } catch (err) {
    V.innerHTML = `<div class="empty"><b>Could not open storage</b>${esc(err?.message || err)}. If you are in Private Browsing, switch to a normal tab.</div>`;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
