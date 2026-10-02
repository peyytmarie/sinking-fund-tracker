'use strict';

/* =========================================================================
   Sinking Fund Tracker
   All data lives in the browser's localStorage. Use Settings → Export
   backup regularly; the JSON file is the only copy outside this browser.
   ========================================================================= */

const STORAGE_KEY = 'sinkingFund.v1';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EPS = 0.005;

// ---------- small helpers ----------
const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fmt = n => peso.format(round2(n || 0));
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISO(new Date());
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => s ? parseISO(s).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.ts || 0) - (b.ts || 0));

function addMonths(iso, n) {
  const d = parseISO(iso);
  const day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return toISO(t);
}

// ---------- state ----------
function defaultState() {
  return {
    version: 1,
    settings: {
      fundName: 'Sinking Fund',
      year: new Date().getFullYear(),
      perHead: 500,
      frequency: 'semimonthly', // or 'monthly'
      startMonth: 1,
      rates: { 1: 5, 2: 4, 3: 3 }, // % per month, by term in months
      retentionPct: 10,
      openingByYear: {}, // { "2026": 1234.5 } carry-over brought into that year
    },
    members: [],       // { id, name, heads, joined, notes, ts }
    contributions: [], // { id, memberId, date, amount, note, ts }
    loans: [],         // { id, memberId, date, principal, term, rate, note, ts }
    payments: [],      // { id, loanId, date, amount, note, ts }
    others: [],        // { id, date, type: 'in'|'out', amount, description, ts }
    history: [],       // closed-year snapshots
  };
}

function normalize(s) {
  const d = defaultState();
  const settings = { ...d.settings, ...(s.settings || {}) };
  settings.rates = { ...d.settings.rates, ...((s.settings || {}).rates || {}) };
  settings.openingByYear = { ...((s.settings || {}).openingByYear || {}) };
  return { ...d, ...s, settings };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { console.error('Could not load saved data', e); }
  return defaultState();
}

let state = load();

// Online mode (see cloud.js). Without Firebase config the app stays local-only and fully editable.
const cloud = { enabled: false, ready: true, canEdit: false, user: null, error: '' };
const canEdit = () => !cloud.enabled || cloud.canEdit;

function save() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (cloud.enabled && cloud.canEdit && window.cloudSave) {
    window.cloudSave(state).catch(err => alert('Could not save online: ' + err.message));
  }
}

// Hooks used by cloud.js
window.sfApp = {
  setCloud(patch) { Object.assign(cloud, patch); render(); },
  applyRemote(data) {
    state = data ? normalize(data) : defaultState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
  },
};
function commit(msg) { save(); render(); if (msg) toast(msg); }

const S = () => state.settings;
const Y = () => String(S().year);
const inYear = r => r.date && r.date.slice(0, 4) === Y();
const memberById = id => state.members.find(m => m.id === id);
const memberName = id => memberById(id)?.name || '(removed member)';
const openingCarryOver = () => Number(S().openingByYear[Y()] || 0);
const rateFor = term => Number(S().rates[term] || 0);

// ---------- calculations ----------
function loanInfo(loan, asOf = todayISO()) {
  const principal = Number(loan.principal);
  const interest = round2(principal * loan.rate / 100 * loan.term);
  const totalDue = round2(principal + interest);
  const installment = round2(totalDue / loan.term);
  const pays = state.payments.filter(p => p.loanId === loan.id).sort(byDate);
  const paid = round2(sum(pays, p => p.amount));
  const applied = Math.min(paid, totalDue);
  const balance = round2(Math.max(0, totalDue - paid));
  // Each payment is split between principal and interest in the same ratio as the loan itself.
  const interestShare = totalDue > 0 ? interest / totalDue : 0;
  const interestPaid = round2(applied * interestShare);
  const principalPaid = round2(applied - interestPaid);

  const schedule = [];
  let cum = 0;
  for (let i = 1; i <= loan.term; i++) {
    const amount = i === loan.term ? round2(totalDue - installment * (loan.term - 1)) : installment;
    cum = round2(cum + amount);
    schedule.push({ no: i, date: addMonths(loan.date, i), amount, cum });
  }
  const nextDue = schedule.find(s => paid < s.cum - EPS) || null;
  const dueNow = round2(Math.max(0, sum(schedule.filter(s => s.date <= asOf), s => s.amount) - paid));
  const status = balance <= EPS ? 'paid' : (nextDue && nextDue.date < asOf ? 'overdue' : 'active');

  return {
    loan, principal, interest, totalDue, installment, pays, paid, balance,
    interestShare, interestPaid, principalPaid,
    principalBalance: round2(principal - principalPaid),
    interestBalance: round2(interest - interestPaid),
    schedule, nextDue, dueNow, status,
    maturity: schedule[schedule.length - 1].date,
  };
}

/**
 * Number of contribution periods whose due date has arrived in the active year as of `asOf`.
 * Monthly dues fall due at month end; semi-monthly on the 15th and at month end.
 */
function periodsDue(asOf, joined) {
  const year = Number(Y());
  let startM = Number(S().startMonth) || 1;
  if (joined) {
    const jy = Number(joined.slice(0, 4));
    if (jy > year) return 0;
    if (jy === year) startM = Math.max(startM, Number(joined.slice(5, 7)));
  }
  let count = 0;
  for (let m = startM; m <= 12; m++) {
    const lastDay = new Date(year, m, 0).getDate();
    const dueDays = S().frequency === 'monthly' ? [lastDay] : [15, lastDay];
    for (const day of dueDays) if (`${year}-${pad(m)}-${pad(day)}` <= asOf) count++;
  }
  return count;
}

function compute({ includeRemainingDues = false } = {}) {
  const s = S();
  const today = todayISO();
  const members = state.members;
  const totalHeads = sum(members, m => m.heads);
  const loanInfos = state.loans.map(l => loanInfo(l, today));
  const infoById = new Map(loanInfos.map(li => [li.loan.id, li]));

  const contribsY = state.contributions.filter(inYear);
  const loansY = state.loans.filter(inYear);
  const paysY = state.payments.filter(inYear);
  const othersY = state.others.filter(inYear);

  const opening = openingCarryOver();
  const totalContrib = round2(sum(contribsY, c => c.amount));
  const loansReleased = round2(sum(loansY, l => l.principal));
  const paymentsIn = round2(sum(paysY, p => p.amount));
  const interestCollected = round2(sum(paysY, p => {
    const li = infoById.get(p.loanId);
    return li ? p.amount * li.interestShare : 0;
  }));
  const otherIn = round2(sum(othersY.filter(o => o.type === 'in'), o => o.amount));
  const otherOut = round2(sum(othersY.filter(o => o.type === 'out'), o => o.amount));
  const otherNet = round2(otherIn - otherOut);

  const cash = round2(opening + totalContrib + paymentsIn + otherIn - loansReleased - otherOut);
  const openLoans = loanInfos.filter(li => li.balance > EPS);
  const principalOutstanding = round2(sum(openLoans, li => li.principalBalance));
  const interestReceivable = round2(sum(openLoans, li => li.interestBalance));
  const fundValue = round2(cash + principalOutstanding);

  // Year-end projection: assumes every open loan is settled (by payment or payout deduction).
  const interestTotal = round2(interestCollected + interestReceivable);
  const fullPeriods = periodsDue(`${Y()}-12-31`);

  const rows = members.map(m => {
    const heads = Number(m.heads) || 0;
    const contrib = round2(sum(contribsY.filter(c => c.memberId === m.id), c => c.amount));
    const expected = round2(heads * s.perHead * periodsDue(today, m.joined));
    const expectedFull = round2(heads * s.perHead * periodsDue(`${Y()}-12-31`, m.joined));
    const remainingDues = round2(Math.max(0, expectedFull - contrib));
    const memberLoans = openLoans.filter(li => li.loan.memberId === m.id);
    const loanBalance = round2(sum(memberLoans, li => li.balance));
    return {
      member: m, heads, contrib, expected, expectedFull, remainingDues,
      arrears: round2(Math.max(0, expected - contrib)),
      advance: round2(Math.max(0, contrib - expected)),
      loanBalance, openLoanCount: memberLoans.length,
      overdue: memberLoans.some(li => li.status === 'overdue'),
      netContribution: round2(contrib - loanBalance),
    };
  });

  const projectedContrib = round2(totalContrib + (includeRemainingDues ? sum(rows, r => r.remainingDues) : 0));
  const earningsPool = round2(opening + interestTotal + otherNet);
  const totalBalance = round2(projectedContrib + earningsPool);
  const retentionRate = (Number(s.retentionPct) || 0) / 100;
  const retained = round2(totalBalance * retentionRate);
  const distributable = round2(totalBalance - retained);
  const earningsPerHead = totalHeads ? earningsPool / totalHeads : 0;

  for (const r of rows) {
    const contribForShare = r.contrib + (includeRemainingDues ? r.remainingDues : 0);
    r.contribForShare = round2(contribForShare);
    r.earningsShare = round2(earningsPerHead * r.heads);
    r.grossShare = round2(contribForShare + r.earningsShare);
    r.retainedShare = round2(r.grossShare * retentionRate);
    r.netShare = round2(r.grossShare - r.retainedShare);
    r.payout = round2(r.netShare - r.loanBalance);
  }

  return {
    today, totalHeads, opening, totalContrib, loansReleased, paymentsIn, interestCollected,
    otherIn, otherOut, otherNet, cash, principalOutstanding, interestReceivable, fundValue,
    interestTotal, earningsPool, totalBalance, retained, distributable, earningsPerHead,
    retentionRate, projectedContrib, fullPeriods, rows, loanInfos, openLoans, infoById,
  };
}

function ledgerRows() {
  const infoById = new Map(state.loans.map(l => [l.id, loanInfo(l)]));
  const rows = [];
  for (const c of state.contributions.filter(inYear)) {
    rows.push({ date: c.date, ts: c.ts, kind: 'Contribution', who: memberName(c.memberId), desc: c.note || '', inAmt: c.amount, outAmt: 0 });
  }
  for (const l of state.loans.filter(inYear)) {
    rows.push({ date: l.date, ts: l.ts, kind: 'Loan released', who: memberName(l.memberId), desc: `${l.term} mo @ ${l.rate}%/mo${l.note ? ' · ' + l.note : ''}`, inAmt: 0, outAmt: l.principal });
  }
  for (const p of state.payments.filter(inYear)) {
    const li = infoById.get(p.loanId);
    const who = li ? memberName(li.loan.memberId) : '(removed loan)';
    const intPart = li ? round2(p.amount * li.interestShare) : 0;
    rows.push({ date: p.date, ts: p.ts, kind: 'Loan payment', who, desc: `Principal ${fmt(p.amount - intPart)} · Interest ${fmt(intPart)}${p.note ? ' · ' + p.note : ''}`, inAmt: p.amount, outAmt: 0 });
  }
  for (const o of state.others.filter(inYear)) {
    rows.push({ date: o.date, ts: o.ts, kind: o.type === 'in' ? 'Other income' : 'Expense', who: '', desc: o.description || '', inAmt: o.type === 'in' ? o.amount : 0, outAmt: o.type === 'out' ? o.amount : 0 });
  }
  rows.sort(byDate);
  let bal = openingCarryOver();
  for (const r of rows) { bal = round2(bal + r.inAmt - r.outAmt); r.balance = bal; }
  return rows;
}

// ---------- UI infrastructure ----------
const view = document.getElementById('view');
const modal = document.getElementById('modal');
const modalForm = document.getElementById('modal-form');
let currentModal = null;
let ui = { tab: 'dashboard', contribFilter: '', showPaidLoans: false, includeRemainingDues: false };

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

function openModal({ title, body, submitLabel = 'Save', onSubmit, onInput, wide = false, footer }) {
  currentModal = { onSubmit, onInput };
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = footer ?? (onSubmit
    ? `<button type="button" data-close>Cancel</button><button type="submit" class="primary">${esc(submitLabel)}</button>`
    : `<button type="button" data-close>Close</button>`);
  modal.classList.toggle('wide', wide);
  applyReadOnly(modal);
  if (!modal.open) modal.showModal();
  if (onInput) onInput(modalForm);
  const first = modalForm.querySelector('.modal-body input:not([type=hidden]), .modal-body select');
  if (first) first.focus();
}
function closeModal() { modal.close(); currentModal = null; }

modalForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!currentModal?.onSubmit) return closeModal();
  const fd = new FormData(modalForm);
  if (currentModal.onSubmit(Object.fromEntries(fd), fd) !== false) closeModal();
});
modalForm.addEventListener('input', () => currentModal?.onInput?.(modalForm));
modalForm.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
modalForm.addEventListener('click', e => {
  const btn = e.target.closest('[data-modal-action]');
  if (!btn) return;
  e.preventDefault();
  if (EDIT_ACTIONS.has(btn.dataset.modalAction) && !canEdit()) return;
  modalActions[btn.dataset.modalAction]?.(btn.dataset);
});

function memberOptions(selected, placeholder = 'Select member…') {
  const opts = [...state.members].sort((a, b) => a.name.localeCompare(b.name))
    .map(m => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)} (${m.heads} head${m.heads == 1 ? '' : 's'})</option>`).join('');
  return `<option value="">${esc(placeholder)}</option>${opts}`;
}

function defaultDateInYear() {
  const t = todayISO();
  return t.slice(0, 4) === Y() ? t : `${Y()}-12-31` < t ? `${Y()}-12-31` : `${Y()}-01-01`;
}

function fail(msg) { alert(msg); return false; }
function parseAmount(v) { const n = round2(parseFloat(v)); return Number.isFinite(n) ? n : NaN; }

// Actions that change data; hidden and blocked for view-only visitors.
const EDIT_ACTIONS = new Set([
  'add-member', 'edit-member', 'delete-member', 'add-contribution', 'edit-contribution', 'delete-contribution',
  'bulk-contribution', 'add-loan', 'pay-loan', 'add-other', 'delete-other', 'close-year', 'import-json', 'load-sample', 'reset',
  'delete-payment', 'delete-loan', 'pay-from-details',
]);

function applyReadOnly(root) {
  if (canEdit()) return;
  root.querySelectorAll('[data-action], [data-modal-action]').forEach(el => {
    if (EDIT_ACTIONS.has(el.dataset.action || el.dataset.modalAction)) el.hidden = true;
  });
}

function renderAuthBox() {
  const box = document.getElementById('auth-box');
  if (!cloud.enabled) {
    box.innerHTML = '<span class="badge warn" title="Data is saved in this browser only">Saved on this computer only</span>';
    return;
  }
  const status = cloud.error
    ? `<span class="badge bad" title="${esc(cloud.error)}">Connection problem</span>`
    : '<span class="badge good">● Live</span>';
  box.innerHTML = cloud.user
    ? `${status} ${cloud.canEdit ? '<span class="badge accent">Admin</span>' : '<span class="badge">View only</span>'}
       <span class="small muted auth-email">${esc(cloud.user.email)}</span> <button class="sm" data-auth="out">Sign out</button>`
    : `${status} <button class="sm" data-auth="in">Admin sign in</button>`;
}

// ---------- render ----------
function render() {
  const s = S();
  document.body.classList.toggle('readonly', !canEdit());
  document.getElementById('fund-name').textContent = s.fundName;
  const updated = state.updatedAt ? ` · updated ${new Date(state.updatedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  document.getElementById('fund-year').textContent = `Fund year ${s.year} · ${state.members.length} members · ${sum(state.members, m => m.heads)} heads${updated}`;
  document.title = `${s.fundName} · ${s.year}`;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === ui.tab));
  renderAuthBox();
  if (cloud.enabled && !cloud.ready) {
    view.innerHTML = '<div class="card empty">Loading fund data…</div>';
    return;
  }
  view.innerHTML = (cloud.error ? `<div class="notice bad" style="margin-bottom:16px">Could not reach the online database (${esc(cloud.error)}). Showing the last data this browser saw.</div>` : '')
    + (views[ui.tab] || views.dashboard)();
  applyReadOnly(view);
}

function kpi(label, value, hint = '', cls = '') {
  return `<div class="card kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function statusBadge(status) {
  return { paid: '<span class="badge good">Paid</span>', overdue: '<span class="badge bad">Overdue</span>', active: '<span class="badge accent">Active</span>' }[status];
}

function emptyState(msg, action = '') {
  return `<div class="card empty"><p>${msg}</p>${action ? `<p style="margin-top:12px">${action}</p>` : ''}</div>`;
}

const views = {
  dashboard() {
    const c = compute();
    if (!state.members.length) {
      if (!canEdit()) return emptyState('No fund data has been added yet.');
      return emptyState('Welcome! Start by checking <a href="#settings">Settings</a> (contribution per head, schedule, rates), then add your members.',
        '<button class="primary" data-action="add-member">Add first member</button>');
    }
    const overdue = c.openLoans.filter(li => li.status === 'overdue');
    const behind = c.rows.filter(r => r.arrears > EPS);
    const recent = ledgerRows().slice(-8).reverse();

    return `
      <section class="section kpis">
        ${kpi('Total fund value', fmt(c.fundValue), 'Cash on hand + unpaid loan principal', 'primary')}
        ${kpi('Cash on hand', fmt(c.cash), 'Available for new loans')}
        ${kpi('Loans receivable', fmt(c.principalOutstanding), `${c.openLoans.length} open loan${c.openLoans.length === 1 ? '' : 's'} · +${fmt(c.interestReceivable)} interest to collect`)}
        ${kpi(`Contributions ${Y()}`, fmt(c.totalContrib), `${fmt(S().perHead)} per head, ${S().frequency === 'monthly' ? 'monthly' : 'twice a month'}`)}
        ${kpi('Interest earned', fmt(c.interestCollected), `Collected so far · ${fmt(c.interestTotal)} expected incl. open loans`)}
        ${kpi('Earnings per head (proj.)', fmt(c.earningsPerHead), `${c.totalHeads} heads · interest${c.opening ? ' + carry-over' : ''}${c.otherNet ? ' + other' : ''}`)}
        ${kpi(`Carry-over to ${Number(Y()) + 1} (proj.)`, fmt(c.retained), `${S().retentionPct}% of ${fmt(c.totalBalance)}`)}
      </section>

      ${overdue.length || behind.length ? `
      <section class="section grid-2">
        ${overdue.length ? `<div class="notice bad"><strong>Overdue loans:</strong> ${overdue.map(li => `${esc(memberName(li.loan.memberId))} (${fmt(li.dueNow)} due)`).join(', ')}</div>` : '<div></div>'}
        ${behind.length ? `<div class="notice warn"><strong>Behind on contributions:</strong> ${behind.map(r => `${esc(r.member.name)} (${fmt(r.arrears)})`).join(', ')}</div>` : ''}
      </section>` : ''}

      <section class="section">
        <div class="section-head"><h2>Members</h2>
          <div class="actions">
            <button data-action="add-contribution">+ Contribution</button>
            <button data-action="add-loan">+ Loan</button>
            <button data-action="add-member">+ Member</button>
          </div>
        </div>
        <div class="card table-wrap">
          <table>
            <thead><tr>
              <th>Member</th><th class="num">Heads</th><th class="num">Contributed</th><th class="num">Expected to date</th>
              <th class="num">Arrears</th><th class="num">Loan balance</th><th class="num">Net contribution</th><th class="num">Projected Dec payout</th>
            </tr></thead>
            <tbody>
              ${c.rows.map(r => `<tr>
                <td><a href="#" data-action="statement" data-id="${r.member.id}">${esc(r.member.name)}</a></td>
                <td class="num">${r.heads}</td>
                <td class="num">${fmt(r.contrib)}</td>
                <td class="num muted">${fmt(r.expected)}</td>
                <td class="num ${r.arrears > EPS ? 'warn' : 'muted'}">${r.arrears > EPS ? fmt(r.arrears) : '—'}</td>
                <td class="num ${r.overdue ? 'bad' : ''}">${r.loanBalance > EPS ? fmt(r.loanBalance) : '<span class="muted">—</span>'}</td>
                <td class="num">${fmt(r.netContribution)}</td>
                <td class="num"><strong>${fmt(r.payout)}</strong></td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <td>Total</td><td class="num">${c.totalHeads}</td><td class="num">${fmt(c.totalContrib)}</td>
              <td class="num">${fmt(sum(c.rows, r => r.expected))}</td><td class="num">${fmt(sum(c.rows, r => r.arrears))}</td>
              <td class="num">${fmt(sum(c.rows, r => r.loanBalance))}</td><td class="num">${fmt(sum(c.rows, r => r.netContribution))}</td>
              <td class="num">${fmt(sum(c.rows, r => r.payout))}</td>
            </tr></tfoot>
          </table>
        </div>
        <p class="small muted" style="margin-top:6px">Net contribution = contributed − unpaid loan balance. Projected payout uses contributions so far; see <a href="#yearend">Year-End</a> for the full breakdown.</p>
      </section>

      <section class="section">
        <div class="section-head"><h2>Recent activity</h2><a href="#ledger">View full ledger →</a></div>
        ${recent.length ? `<div class="card table-wrap"><table>
          <thead><tr><th>Date</th><th>Type</th><th>Member</th><th class="num">In</th><th class="num">Out</th><th class="num">Cash balance</th></tr></thead>
          <tbody>${recent.map(r => `<tr>
            <td>${fmtDate(r.date)}</td><td>${r.kind}</td><td>${esc(r.who)}</td>
            <td class="num good">${r.inAmt ? fmt(r.inAmt) : ''}</td><td class="num bad">${r.outAmt ? fmt(r.outAmt) : ''}</td>
            <td class="num">${fmt(r.balance)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('No transactions yet this year.')}
      </section>`;
  },

  members() {
    const c = compute();
    return `
      <section class="section">
        <div class="section-head"><h2>Members</h2>
          <div class="actions"><button class="primary" data-action="add-member">+ Add member</button></div>
        </div>
        ${state.members.length ? `<div class="card table-wrap"><table>
          <thead><tr><th>Name</th><th class="num">Heads</th><th class="num">Dues per period</th><th>Joined</th>
            <th class="num">Contributed ${Y()}</th><th class="num">Loan balance</th><th>Notes</th><th></th></tr></thead>
          <tbody>${c.rows.map(r => `<tr>
            <td><strong>${esc(r.member.name)}</strong></td>
            <td class="num">${r.heads}</td>
            <td class="num">${fmt(r.heads * S().perHead)}</td>
            <td>${r.member.joined ? fmtDate(r.member.joined) : '<span class="muted">—</span>'}</td>
            <td class="num">${fmt(r.contrib)}</td>
            <td class="num">${r.loanBalance > EPS ? fmt(r.loanBalance) : '<span class="muted">—</span>'}</td>
            <td class="muted">${esc(r.member.notes || '')}</td>
            <td><div class="row-actions">
              <button class="sm" data-action="statement" data-id="${r.member.id}">Statement</button>
              <button class="sm" data-action="edit-member" data-id="${r.member.id}">Edit</button>
              <button class="sm danger" data-action="delete-member" data-id="${r.member.id}">Delete</button>
            </div></td></tr>`).join('')}</tbody>
          <tfoot><tr><td>${state.members.length} members</td><td class="num">${c.totalHeads}</td><td class="num">${fmt(c.totalHeads * S().perHead)}</td><td colspan="5"></td></tr></tfoot>
        </table></div>` : emptyState('No members yet.', '<button class="primary" data-action="add-member">Add first member</button>')}
        <p class="small muted" style="margin-top:6px">Each head pays ${fmt(S().perHead)} per period and gets one equal share of the interest earnings.</p>
      </section>`;
  },

  contributions() {
    const list = state.contributions.filter(inYear)
      .filter(x => !ui.contribFilter || x.memberId === ui.contribFilter)
      .sort(byDate).reverse();
    const startM = Number(S().startMonth) || 1;
    const months = MONTHS.map((n, i) => i + 1).filter(m => m >= startM);
    const contribsY = state.contributions.filter(inYear);
    const grid = state.members.map(m => {
      const cells = months.map(mo => round2(sum(contribsY.filter(x => x.memberId === m.id && Number(x.date.slice(5, 7)) === mo), x => x.amount)));
      return { m, cells, total: round2(sum(cells, x => x)) };
    });
    const monthlyDue = h => h * S().perHead * (S().frequency === 'monthly' ? 1 : 2);

    return `
      <section class="section">
        <div class="section-head"><h2>Contributions ${Y()}</h2>
          <div class="actions">
            <button data-action="bulk-contribution" ${state.members.length ? '' : 'disabled'}>Record dues for many</button>
            <button class="primary" data-action="add-contribution" ${state.members.length ? '' : 'disabled'}>+ Add contribution</button>
          </div>
        </div>
        ${state.members.length ? `
        <div class="card table-wrap">
          <table>
            <thead><tr><th>Member</th>${months.map(m => `<th class="num">${MONTHS[m - 1]}</th>`).join('')}<th class="num">Total</th></tr></thead>
            <tbody>${grid.map(g => `<tr><td>${esc(g.m.name)} <span class="muted small">×${g.m.heads}</span></td>
              ${g.cells.map(v => {
                const due = monthlyDue(g.m.heads);
                const cls = v <= EPS ? 'muted' : v + EPS < due ? 'warn' : 'good';
                return `<td class="num ${cls}">${v > EPS ? fmt(v) : '—'}</td>`;
              }).join('')}
              <td class="num"><strong>${fmt(g.total)}</strong></td></tr>`).join('')}</tbody>
            <tfoot><tr><td>Total</td>${months.map((m, i) => `<td class="num">${fmt(sum(grid, g => g.cells[i]))}</td>`).join('')}<td class="num">${fmt(sum(grid, g => g.total))}</td></tr></tfoot>
          </table>
        </div>
        <p class="small muted" style="margin-top:6px">Green = full monthly dues paid, orange = partial.</p>` : emptyState('Add members first.')}
      </section>

      <section class="section">
        <div class="section-head"><h3>All entries</h3>
          <select class="filter" data-action="contrib-filter">${memberOptions(ui.contribFilter, 'All members')}</select>
        </div>
        ${list.length ? `<div class="card table-wrap"><table>
          <thead><tr><th>Date</th><th>Member</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead>
          <tbody>${list.map(x => `<tr>
            <td>${fmtDate(x.date)}</td><td>${esc(memberName(x.memberId))}</td><td class="num">${fmt(x.amount)}</td>
            <td class="muted">${esc(x.note || '')}</td>
            <td><div class="row-actions">
              <button class="sm" data-action="edit-contribution" data-id="${x.id}">Edit</button>
              <button class="sm danger" data-action="delete-contribution" data-id="${x.id}">Delete</button>
            </div></td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="2">${list.length} entries</td><td class="num">${fmt(sum(list, x => x.amount))}</td><td colspan="2"></td></tr></tfoot>
        </table></div>` : emptyState('No contributions recorded.')}
      </section>`;
  },

  loans() {
    const c = compute();
    const r = S().rates;
    const list = c.loanInfos
      .filter(li => ui.showPaidLoans ? (inYear(li.loan) || li.balance > EPS) : li.balance > EPS)
      .sort((a, b) => byDate(a.loan, b.loan)).reverse();
    return `
      <section class="section kpis">
        ${kpi('Cash available to lend', fmt(c.cash))}
        ${kpi('Loans receivable', fmt(c.principalOutstanding), `${c.openLoans.length} open`)}
        ${kpi('Interest collected', fmt(c.interestCollected), `${fmt(c.interestReceivable)} still to collect`)}
        ${kpi('Interest rates', `${r[1]}% · ${r[2]}% · ${r[3]}%`, '1 · 2 · 3 months, per month, flat on principal')}
      </section>
      <section class="section">
        <div class="section-head"><h2>Loans</h2>
          <div class="actions">
            <label class="inline"><input type="checkbox" data-action="toggle-paid" ${ui.showPaidLoans ? 'checked' : ''}> Show paid loans</label>
            <button class="primary" data-action="add-loan" ${state.members.length ? '' : 'disabled'}>+ New loan</button>
          </div>
        </div>
        ${list.length ? `<div class="card table-wrap"><table>
          <thead><tr><th>Released</th><th>Borrower</th><th class="num">Principal</th><th class="num">Term</th><th class="num">Interest</th>
            <th class="num">Total due</th><th class="num">Paid</th><th class="num">Balance</th><th>Next due</th><th>Status</th><th></th></tr></thead>
          <tbody>${list.map(li => `<tr>
            <td>${fmtDate(li.loan.date)}</td>
            <td>${esc(memberName(li.loan.memberId))}</td>
            <td class="num">${fmt(li.principal)}</td>
            <td class="num">${li.loan.term} mo @ ${li.loan.rate}%</td>
            <td class="num">${fmt(li.interest)}</td>
            <td class="num">${fmt(li.totalDue)}</td>
            <td class="num">${fmt(li.paid)}</td>
            <td class="num"><strong>${fmt(li.balance)}</strong></td>
            <td>${li.nextDue ? `${fmtDate(li.nextDue.date)}<div class="small muted">${fmt(Math.min(li.nextDue.cum - li.paid, li.balance))}</div>` : '<span class="muted">—</span>'}</td>
            <td>${statusBadge(li.status)}</td>
            <td><div class="row-actions">
              ${li.balance > EPS ? `<button class="sm primary" data-action="pay-loan" data-id="${li.loan.id}">Pay</button>` : ''}
              <button class="sm" data-action="view-loan" data-id="${li.loan.id}">Details</button>
            </div></td></tr>`).join('')}</tbody>
        </table></div>` : emptyState(ui.showPaidLoans ? 'No loans this year.' : 'No open loans.')}
      </section>`;
  },

  ledger() {
    const rows = ledgerRows();
    const c = compute();
    return `
      <section class="section">
        <div class="section-head"><h2>Ledger ${Y()}</h2>
          <div class="actions">
            <button data-action="export-csv">Export CSV</button>
            <button data-action="add-other" data-type="out">+ Expense</button>
            <button data-action="add-other" data-type="in">+ Other income</button>
          </div>
        </div>
        <p class="muted small" style="margin-bottom:10px">Every peso in and out of the fund. Expenses (e.g. bank fees) and other income are shared per head together with interest.</p>
        <div class="card table-wrap"><table>
          <thead><tr><th>Date</th><th>Type</th><th>Member</th><th>Details</th><th class="num">In</th><th class="num">Out</th><th class="num">Cash balance</th></tr></thead>
          <tbody>
            <tr><td>${fmtDate(`${Y()}-01-01`)}</td><td>Opening carry-over</td><td></td><td class="muted">From ${Number(Y()) - 1}</td><td class="num good">${c.opening ? fmt(c.opening) : ''}</td><td></td><td class="num">${fmt(c.opening)}</td></tr>
            ${rows.map(r => `<tr>
              <td>${fmtDate(r.date)}</td><td>${r.kind}</td><td>${esc(r.who)}</td><td class="muted small">${esc(r.desc)}</td>
              <td class="num good">${r.inAmt ? fmt(r.inAmt) : ''}</td><td class="num bad">${r.outAmt ? fmt(r.outAmt) : ''}</td>
              <td class="num">${fmt(r.balance)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="4">Totals</td><td class="num">${fmt(c.opening + sum(rows, r => r.inAmt))}</td><td class="num">${fmt(sum(rows, r => r.outAmt))}</td><td class="num">${fmt(c.cash)}</td></tr></tfoot>
        </table></div>
      </section>
      ${state.others.filter(inYear).length ? `
      <section class="section">
        <h3 style="margin-bottom:10px">Other income & expenses</h3>
        <div class="card table-wrap"><table>
          <thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${state.others.filter(inYear).sort(byDate).map(o => `<tr>
            <td>${fmtDate(o.date)}</td><td>${o.type === 'in' ? '<span class="badge good">Income</span>' : '<span class="badge warn">Expense</span>'}</td>
            <td>${esc(o.description)}</td><td class="num">${fmt(o.amount)}</td>
            <td><div class="row-actions"><button class="sm danger" data-action="delete-other" data-id="${o.id}">Delete</button></div></td></tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}`;
  },

  yearend() {
    const c = compute({ includeRemainingDues: ui.includeRemainingDues });
    const pct = S().retentionPct;
    const next = Number(Y()) + 1;
    const closed = state.history.find(h => String(h.year) === Y());
    return `
      <div class="print-only"><h2>${esc(S().fundName)} — Year-End Distribution ${Y()}</h2><p class="muted">Prepared ${fmtDate(todayISO())}</p><br></div>
      ${closed ? `<div class="notice" style="margin-bottom:16px">Year ${Y()} was closed on ${fmtDate(closed.closedOn)}. Carry-over of ${fmt(closed.retained)} was moved to ${next}.</div>` : ''}
      <section class="section grid-2">
        <div class="card pad">
          <h3 style="margin-bottom:12px">Fund balance for distribution</h3>
          <div class="summary-list">
            <span>Carry-over from ${Number(Y()) - 1}</span><span class="num">${fmt(c.opening)}</span>
            <span>Member contributions${ui.includeRemainingDues ? ' (incl. remaining dues)' : ''}</span><span class="num">${fmt(c.projectedContrib)}</span>
            <span>Loan interest (collected ${fmt(c.interestCollected)} + to collect ${fmt(c.interestReceivable)})</span><span class="num">${fmt(c.interestTotal)}</span>
            ${c.otherNet ? `<span>Other income − expenses</span><span class="num">${fmt(c.otherNet)}</span>` : ''}
            <div class="sep"></div>
            <span class="big">Total fund balance</span><span class="num big">${fmt(c.totalBalance)}</span>
            <span>Retained for ${next} (${pct}%)</span><span class="num warn">− ${fmt(c.retained)}</span>
            <div class="sep"></div>
            <span class="big">To distribute (${100 - pct}%)</span><span class="num big good">${fmt(c.distributable)}</span>
          </div>
        </div>
        <div class="card pad">
          <h3 style="margin-bottom:12px">Shared earnings per head</h3>
          <div class="summary-list">
            <span>Interest + carry-over + other (net)</span><span class="num">${fmt(c.earningsPool)}</span>
            <span>Registered heads</span><span class="num">÷ ${c.totalHeads}</span>
            <div class="sep"></div>
            <span class="big">Per head (before ${pct}% retention)</span><span class="num big">${fmt(c.earningsPerHead)}</span>
          </div>
          <ul class="formula" style="margin:14px 0 0;padding-left:18px">
            <li><strong>Gross share</strong> = own contributions + (per-head earnings × heads)</li>
            <li><strong>Net share</strong> = gross share − ${pct}% retained for ${next}</li>
            <li><strong>Payout</strong> = net share − any unpaid loan balance (deducted)</li>
          </ul>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Distribution per member</h2>
          <div class="actions">
            <label class="inline"><input type="checkbox" data-action="toggle-remaining" ${ui.includeRemainingDues ? 'checked' : ''}> Project full-year dues (assume everyone pays through Dec)</label>
            <button data-action="print">Print</button>
            ${closed ? '' : `<button class="danger solid" data-action="close-year" ${state.members.length ? '' : 'disabled'}>Close year ${Y()}…</button>`}
          </div>
        </div>
        <div class="card table-wrap"><table>
          <thead><tr><th>Member</th><th class="num">Heads</th><th class="num">Contributions</th><th class="num">Earnings share</th>
            <th class="num">Gross share</th><th class="num">Less ${pct}% retained</th><th class="num">Net share</th><th class="num">Less loan balance</th><th class="num">Payout</th></tr></thead>
          <tbody>${c.rows.map(r => `<tr>
            <td>${esc(r.member.name)}</td><td class="num">${r.heads}</td>
            <td class="num">${fmt(r.contribForShare)}</td><td class="num">${fmt(r.earningsShare)}</td>
            <td class="num">${fmt(r.grossShare)}</td><td class="num warn">− ${fmt(r.retainedShare)}</td>
            <td class="num">${fmt(r.netShare)}</td>
            <td class="num ${r.loanBalance > EPS ? 'bad' : 'muted'}">${r.loanBalance > EPS ? '− ' + fmt(r.loanBalance) : '—'}</td>
            <td class="num"><strong>${fmt(r.payout)}</strong></td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td><td class="num">${c.totalHeads}</td><td class="num">${fmt(sum(c.rows, r => r.contribForShare))}</td>
            <td class="num">${fmt(sum(c.rows, r => r.earningsShare))}</td><td class="num">${fmt(sum(c.rows, r => r.grossShare))}</td>
            <td class="num">− ${fmt(sum(c.rows, r => r.retainedShare))}</td><td class="num">${fmt(sum(c.rows, r => r.netShare))}</td>
            <td class="num">− ${fmt(sum(c.rows, r => r.loanBalance))}</td><td class="num">${fmt(sum(c.rows, r => r.payout))}</td></tr></tfoot>
        </table></div>
        <p class="small muted" style="margin-top:6px">
          Cash needed for payouts: <strong>${fmt(sum(c.rows, r => r.payout))}</strong>.
          ${ui.includeRemainingDues ? '' : `Cash on hand now: <strong>${fmt(c.cash)}</strong>.`}
          Open loans are assumed settled by December — unpaid balances are deducted from the borrower's payout.
        </p>
      </section>

      ${state.history.length ? `
      <section class="section">
        <h3 style="margin-bottom:10px">Closed years</h3>
        <div class="card table-wrap"><table>
          <thead><tr><th>Year</th><th>Closed on</th><th class="num">Total balance</th><th class="num">Interest earned</th><th class="num">Distributed</th><th class="num">Carried over</th><th></th></tr></thead>
          <tbody>${state.history.map((h, i) => `<tr><td>${h.year}</td><td>${fmtDate(h.closedOn)}</td><td class="num">${fmt(h.totalBalance)}</td>
            <td class="num">${fmt(h.interestTotal)}</td><td class="num">${fmt(h.distributable)}</td><td class="num">${fmt(h.retained)}</td>
            <td><div class="row-actions"><button class="sm" data-action="view-history" data-index="${i}">Payouts</button></div></td></tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}`;
  },

  settings() {
    const s = S();
    const years = new Set([Y(), String(new Date().getFullYear()), ...state.history.map(h => String(h.year)), ...state.history.map(h => String(h.year + 1))]);
    for (const k of ['contributions', 'loans', 'payments', 'others']) state[k].forEach(r => r.date && years.add(r.date.slice(0, 4)));
    return `
      <section class="section grid-2">
        <form class="card pad" id="settings-form">
          <h2 style="margin-bottom:14px">Fund settings</h2>
          ${canEdit() ? '' : '<p class="notice" style="margin-bottom:14px">View only. Only the fund admin can change settings.</p>'}
          <fieldset class="plain" ${canEdit() ? '' : 'disabled'}>
          <div class="field"><label for="fundName">Fund name</label><input id="fundName" name="fundName" value="${esc(s.fundName)}" required></div>
          <div class="fields">
            <div class="field"><label for="year">Active fund year</label>
              <select id="year" name="year">${[...years].sort().map(y => `<option ${y === Y() ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
            <div class="field"><label for="startMonth">First contribution month</label>
              <select id="startMonth" name="startMonth">${MONTHS.map((m, i) => `<option value="${i + 1}" ${s.startMonth == i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
            <div class="field"><label for="perHead">Contribution per head (₱)</label><input id="perHead" name="perHead" type="number" min="0" step="0.01" value="${s.perHead}"></div>
            <div class="field"><label for="frequency">Schedule</label>
              <select id="frequency" name="frequency">
                <option value="semimonthly" ${s.frequency === 'semimonthly' ? 'selected' : ''}>Twice a month (15th & 30th)</option>
                <option value="monthly" ${s.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
              </select></div>
          </div>
          <h3 style="margin:8px 0 10px">Loan interest (% per month, flat)</h3>
          <div class="fields">
            ${[1, 2, 3].map(t => `<div class="field"><label for="rate${t}">${t}-month term</label><input id="rate${t}" name="rate${t}" type="number" min="0" step="0.01" value="${s.rates[t]}"></div>`).join('')}
          </div>
          <h3 style="margin:8px 0 10px">Year-end</h3>
          <div class="fields">
            <div class="field"><label for="retentionPct">Retained carry-over (%)</label><input id="retentionPct" name="retentionPct" type="number" min="0" max="100" step="0.1" value="${s.retentionPct}"></div>
            <div class="field"><label for="opening">Carry-over brought into ${Y()} (₱)</label><input id="opening" name="opening" type="number" min="0" step="0.01" value="${openingCarryOver()}">
              <div class="help">Filled in automatically when you close the previous year.</div></div>
          </div>
          ${canEdit() ? '<button type="submit" class="primary">Save settings</button>' : ''}
          </fieldset>
        </form>

        <div>
          <div class="card pad">
            <h2 style="margin-bottom:8px">Backup & restore</h2>
            <p class="muted" style="margin-bottom:12px">${cloud.enabled
              ? 'Data is saved online and everyone with the link sees the same numbers. Still export a backup now and then (e.g. monthly) and keep it somewhere safe.'
              : 'Your data is saved only in this browser on this computer. Export a backup after each session and keep it somewhere safe (Google Drive, email to yourself).'}
              Last saved: ${state.updatedAt ? new Date(state.updatedAt).toLocaleString('en-PH') : 'never'}.</p>
            <div class="actions">
              <button class="primary" data-action="export-json">Export backup (.json)</button>
              <button data-action="import-json">Import backup…</button>
              <input type="file" id="import-file" accept="application/json,.json" hidden>
            </div>
          </div>
          <div class="card pad edit-only" style="margin-top:16px">
            <h2 style="margin-bottom:8px">Sample & reset</h2>
            <p class="muted" style="margin-bottom:12px">Load demo data to try things out, or wipe everything to start over. Both replace your current data, so export a backup first.</p>
            <div class="actions">
              <button data-action="load-sample">Load sample data</button>
              <button class="danger" data-action="reset">Erase all data</button>
            </div>
          </div>
        </div>
      </section>`;
  },
};

// ---------- forms ----------
function memberForm(m = {}) {
  return `
    <div class="field"><label for="f-name">Name</label><input id="f-name" name="name" value="${esc(m.name || '')}" required></div>
    <div class="fields">
      <div class="field"><label for="f-heads">Number of heads</label><input id="f-heads" name="heads" type="number" min="1" step="1" value="${m.heads || 1}">
        <div class="help">Dues: ${fmt(S().perHead)} × heads per period</div></div>
      <div class="field"><label for="f-joined">Joined (optional)</label><input id="f-joined" name="joined" type="date" value="${m.joined || ''}">
        <div class="help">Dues are counted from this month</div></div>
    </div>
    <div class="field"><label for="f-notes">Notes</label><input id="f-notes" name="notes" value="${esc(m.notes || '')}"></div>`;
}

function saveMember(existing) {
  return d => {
    const name = d.name.trim();
    const heads = parseInt(d.heads, 10);
    if (!name) return fail('Please enter a name.');
    if (!(heads >= 1)) return fail('Heads must be at least 1.');
    if (state.members.some(m => m.name.toLowerCase() === name.toLowerCase() && m.id !== existing?.id)) return fail('A member with this name already exists.');
    if (existing) Object.assign(existing, { name, heads, joined: d.joined || '', notes: d.notes.trim() });
    else state.members.push({ id: uid(), name, heads, joined: d.joined || '', notes: d.notes.trim(), ts: Date.now() });
    commit(existing ? 'Member updated' : 'Member added');
  };
}

function contributionForm(x = {}) {
  const m = x.memberId ? memberById(x.memberId) : null;
  return `
    <div class="field"><label for="f-member">Member</label><select id="f-member" name="memberId" required>${memberOptions(x.memberId)}</select></div>
    <div class="fields">
      <div class="field"><label for="f-date">Date</label><input id="f-date" name="date" type="date" value="${x.date || defaultDateInYear()}" required></div>
      <div class="field"><label for="f-amount">Amount (₱)</label><input id="f-amount" name="amount" type="number" min="0.01" step="0.01" value="${x.amount ?? (m ? m.heads * S().perHead : '')}" required>
        <div class="help" id="f-due-help"></div></div>
    </div>
    <div class="field"><label for="f-note">Note</label><input id="f-note" name="note" value="${esc(x.note || '')}" placeholder="e.g. Oct 15 dues, GCash"></div>`;
}

function contributionInput(isEdit) {
  let lastMember = null;
  return form => {
    const m = memberById(form.memberId.value);
    form.querySelector('#f-due-help').textContent = m ? `Dues per period: ${fmt(m.heads * S().perHead)}` : '';
    if (!isEdit && m && m.id !== lastMember) form.amount.value = m.heads * S().perHead;
    lastMember = m?.id || null;
  };
}

function saveContribution(existing) {
  return d => {
    const amount = parseAmount(d.amount);
    if (!d.memberId) return fail('Please choose a member.');
    if (!d.date) return fail('Please enter a date.');
    if (!(amount > 0)) return fail('Amount must be more than zero.');
    if (d.date.slice(0, 4) !== Y() && !confirm(`This date is outside the active fund year (${Y()}). It will not count toward ${Y()}. Save anyway?`)) return false;
    const rec = { memberId: d.memberId, date: d.date, amount, note: d.note.trim() };
    if (existing) Object.assign(existing, rec);
    else state.contributions.push({ id: uid(), ts: Date.now(), ...rec });
    commit(existing ? 'Contribution updated' : `Contribution of ${fmt(amount)} recorded`);
  };
}

function loanForm(cash) {
  return `
    <div class="field"><label for="f-member">Borrower</label><select id="f-member" name="memberId" required>${memberOptions('')}</select></div>
    <div class="fields">
      <div class="field"><label for="f-date">Release date</label><input id="f-date" name="date" type="date" value="${defaultDateInYear()}" required></div>
      <div class="field"><label for="f-principal">Amount borrowed (₱)</label><input id="f-principal" name="principal" type="number" min="1" step="0.01" required>
        <div class="help">Cash available: ${fmt(cash)}</div></div>
      <div class="field"><label for="f-term">Term</label>
        <select id="f-term" name="term">${[1, 2, 3].map(t => `<option value="${t}">${t} month${t > 1 ? 's' : ''} — ${rateFor(t)}% per month</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="f-note">Note</label><input id="f-note" name="note" placeholder="optional"></div>
    <div class="preview" id="loan-preview"></div>`;
}

function loanPreview(form) {
  const principal = parseAmount(form.principal.value) || 0;
  const term = Number(form.term.value);
  const date = form.date.value || todayISO();
  const li = loanInfo({ id: '__preview__', principal, term, rate: rateFor(term), date });
  form.querySelector('#loan-preview').innerHTML = `
    <span>Interest (${rateFor(term)}% × ${term} mo)</span><span class="num">${fmt(li.interest)}</span>
    <span class="total">Total to repay</span><span class="num total">${fmt(li.totalDue)}</span>
    ${li.schedule.map(s => `<span class="muted">Installment ${s.no} — due ${fmtDate(s.date)}</span><span class="num muted">${fmt(s.amount)}</span>`).join('')}`;
}

function paymentForm(li) {
  const suggested = li.dueNow > EPS ? li.dueNow : (li.nextDue ? Math.min(round2(li.nextDue.cum - li.paid), li.balance) : li.balance);
  return `
    <div class="preview" style="margin-bottom:14px">
      <span>Borrower</span><span>${esc(memberName(li.loan.memberId))}</span>
      <span>Total due</span><span class="num">${fmt(li.totalDue)}</span>
      <span>Paid so far</span><span class="num">${fmt(li.paid)}</span>
      <span class="total">Remaining balance</span><span class="num total">${fmt(li.balance)}</span>
      ${li.dueNow > EPS ? `<span class="bad">Past due now</span><span class="num bad">${fmt(li.dueNow)}</span>` : ''}
    </div>
    <div class="fields">
      <div class="field"><label for="f-date">Payment date</label><input id="f-date" name="date" type="date" value="${defaultDateInYear()}" required></div>
      <div class="field"><label for="f-amount">Amount (₱)</label><input id="f-amount" name="amount" type="number" min="0.01" step="0.01" max="${li.balance}" value="${round2(suggested)}" required>
        <div class="help"><a href="#" data-modal-action="pay-full" data-amount="${li.balance}">Pay full balance</a></div></div>
    </div>
    <div class="field"><label for="f-note">Note</label><input id="f-note" name="note" placeholder="optional"></div>`;
}

function loanDetails(li) {
  let cum = 0;
  return `
    <div class="fields" style="margin-bottom:14px">
      <div><div class="small muted">Borrower</div><strong>${esc(memberName(li.loan.memberId))}</strong></div>
      <div><div class="small muted">Released</div>${fmtDate(li.loan.date)}</div>
      <div><div class="small muted">Terms</div>${fmt(li.principal)} · ${li.loan.term} mo @ ${li.loan.rate}%/mo</div>
      <div><div class="small muted">Status</div>${statusBadge(li.status)}</div>
    </div>
    <div class="preview" style="margin-bottom:16px">
      <span>Principal</span><span class="num">${fmt(li.principal)}</span>
      <span>Interest</span><span class="num">${fmt(li.interest)}</span>
      <span class="total">Total due</span><span class="num total">${fmt(li.totalDue)}</span>
      <span>Paid (principal ${fmt(li.principalPaid)} + interest ${fmt(li.interestPaid)})</span><span class="num">${fmt(li.paid)}</span>
      <span class="total">Balance</span><span class="num total">${fmt(li.balance)}</span>
    </div>
    <h3 style="margin-bottom:8px">Schedule</h3>
    <div class="table-wrap" style="margin-bottom:16px"><table>
      <thead><tr><th>#</th><th>Due date</th><th class="num">Amount</th><th>Status</th></tr></thead>
      <tbody>${li.schedule.map(s => {
        const covered = li.paid >= s.cum - EPS;
        const st = covered ? '<span class="badge good">Paid</span>' : s.date < todayISO() ? '<span class="badge bad">Overdue</span>' : '<span class="badge">Upcoming</span>';
        return `<tr><td>${s.no}</td><td>${fmtDate(s.date)}</td><td class="num">${fmt(s.amount)}</td><td>${st}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <h3 style="margin-bottom:8px">Payments</h3>
    ${li.pays.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th class="num">Amount</th><th class="num">Interest part</th><th>Note</th><th></th></tr></thead>
      <tbody>${li.pays.map(p => `<tr><td>${fmtDate(p.date)}</td><td class="num">${fmt(p.amount)}</td><td class="num muted">${fmt(p.amount * li.interestShare)}</td>
        <td class="muted">${esc(p.note || '')}</td><td><div class="row-actions"><button type="button" class="sm danger" data-modal-action="delete-payment" data-id="${p.id}" data-loan="${li.loan.id}">Delete</button></div></td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">No payments yet.</p>'}`;
}

function statement(m) {
  const c = compute();
  const r = c.rows.find(x => x.member.id === m.id);
  const contribs = state.contributions.filter(x => inYear(x) && x.memberId === m.id).sort(byDate);
  const loans = c.loanInfos.filter(li => li.loan.memberId === m.id && (inYear(li.loan) || li.balance > EPS)).sort((a, b) => byDate(a.loan, b.loan));
  return `
    <p class="muted" style="margin-bottom:12px">${esc(S().fundName)} · Fund year ${Y()} · as of ${fmtDate(todayISO())}</p>
    <div class="preview" style="margin-bottom:16px">
      <span>Heads</span><span class="num">${r.heads}</span>
      <span>Contributed</span><span class="num">${fmt(r.contrib)}</span>
      <span>Expected to date</span><span class="num">${fmt(r.expected)}</span>
      ${r.arrears > EPS ? `<span class="warn">Arrears</span><span class="num warn">${fmt(r.arrears)}</span>` : ''}
      <span>Unpaid loan balance</span><span class="num">${fmt(r.loanBalance)}</span>
      <span class="total">Net contribution</span><span class="num total">${fmt(r.netContribution)}</span>
      <span>Earnings share (${r.heads} × ${fmt(c.earningsPerHead)})</span><span class="num">${fmt(r.earningsShare)}</span>
      <span>Less ${S().retentionPct}% carry-over</span><span class="num">− ${fmt(r.retainedShare)}</span>
      <span class="total">Projected December payout</span><span class="num total">${fmt(r.payout)}</span>
    </div>
    <h3 style="margin-bottom:8px">Contributions</h3>
    ${contribs.length ? `<div class="table-wrap" style="margin-bottom:16px"><table>
      <thead><tr><th>Date</th><th class="num">Amount</th><th>Note</th></tr></thead>
      <tbody>${contribs.map(x => `<tr><td>${fmtDate(x.date)}</td><td class="num">${fmt(x.amount)}</td><td class="muted">${esc(x.note || '')}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${fmt(r.contrib)}</td><td></td></tr></tfoot>
    </table></div>` : '<p class="muted" style="margin-bottom:16px">None yet.</p>'}
    <h3 style="margin-bottom:8px">Loans</h3>
    ${loans.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Released</th><th class="num">Principal</th><th class="num">Term</th><th class="num">Total due</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th></tr></thead>
      <tbody>${loans.map(li => `<tr><td>${fmtDate(li.loan.date)}</td><td class="num">${fmt(li.principal)}</td><td class="num">${li.loan.term} mo @ ${li.loan.rate}%</td>
        <td class="num">${fmt(li.totalDue)}</td><td class="num">${fmt(li.paid)}</td><td class="num">${fmt(li.balance)}</td><td>${statusBadge(li.status)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">No loans.</p>'}`;
}

function bulkForm() {
  return `
    <div class="fields">
      <div class="field"><label for="f-date">Date</label><input id="f-date" name="date" type="date" value="${defaultDateInYear()}" required></div>
      <div class="field"><label for="f-note">Note</label><input id="f-note" name="note" placeholder="e.g. Oct 15 dues"></div>
    </div>
    <p class="small muted" style="margin-bottom:8px">Each checked member is recorded for their full dues (heads × ${fmt(S().perHead)}).</p>
    <div class="checklist">
      ${[...state.members].sort((a, b) => a.name.localeCompare(b.name)).map(m => `
        <label><input type="checkbox" name="ids" value="${m.id}" checked> ${esc(m.name)} <span class="amt num muted">${fmt(m.heads * S().perHead)}</span></label>`).join('')}
    </div>`;
}

// ---------- actions ----------
const actions = {
  'add-member': () => openModal({ title: 'Add member', body: memberForm(), onSubmit: saveMember(null) }),
  'edit-member': ({ id }) => { const m = memberById(id); openModal({ title: 'Edit member', body: memberForm(m), onSubmit: saveMember(m) }); },
  'delete-member': ({ id }) => {
    const m = memberById(id);
    const has = state.contributions.some(x => x.memberId === id) || state.loans.some(x => x.memberId === id);
    if (has) return alert(`${m.name} has contributions or loans recorded, so they can't be deleted. Remove those records first.`);
    if (!confirm(`Delete ${m.name}?`)) return;
    state.members = state.members.filter(x => x.id !== id);
    commit('Member deleted');
  },
  statement: ({ id }) => {
    const m = memberById(id);
    openModal({
      title: `Statement — ${m.name}`, body: statement(m), wide: true,
      footer: '<button type="button" data-modal-action="print-modal">Print</button><button type="button" class="primary" data-close>Close</button>',
    });
  },

  'add-contribution': () => openModal({ title: 'Add contribution', body: contributionForm(), onSubmit: saveContribution(null), onInput: contributionInput(false) }),
  'edit-contribution': ({ id }) => {
    const x = state.contributions.find(c => c.id === id);
    openModal({ title: 'Edit contribution', body: contributionForm(x), onSubmit: saveContribution(x), onInput: contributionInput(true) });
  },
  'delete-contribution': ({ id }) => {
    const x = state.contributions.find(c => c.id === id);
    if (!confirm(`Delete ${fmt(x.amount)} from ${memberName(x.memberId)} on ${fmtDate(x.date)}?`)) return;
    state.contributions = state.contributions.filter(c => c.id !== id);
    commit('Contribution deleted');
  },
  'bulk-contribution': () => openModal({
    title: 'Record dues for many members', body: bulkForm(), submitLabel: 'Record',
    onSubmit: (d, fd) => {
      const ids = fd.getAll('ids');
      if (!d.date) return fail('Please enter a date.');
      if (!ids.length) return fail('Select at least one member.');
      const ts = Date.now();
      ids.forEach((id, i) => {
        const m = memberById(id);
        state.contributions.push({ id: uid(), ts: ts + i, memberId: id, date: d.date, amount: round2(m.heads * S().perHead), note: d.note.trim() });
      });
      commit(`Recorded dues for ${ids.length} member${ids.length > 1 ? 's' : ''}`);
    },
  }),

  'add-loan': () => {
    const c = compute();
    openModal({
      title: 'New loan', body: loanForm(c.cash), submitLabel: 'Release loan', onInput: loanPreview,
      onSubmit: d => {
        const principal = parseAmount(d.principal);
        const term = Number(d.term);
        if (!d.memberId) return fail('Please choose the borrower.');
        if (!d.date) return fail('Please enter the release date.');
        if (!(principal > 0)) return fail('Amount must be more than zero.');
        if (principal > c.cash + EPS && !confirm(`This is more than the cash available (${fmt(c.cash)}). Release anyway?`)) return false;
        state.loans.push({ id: uid(), ts: Date.now(), memberId: d.memberId, date: d.date, principal, term, rate: rateFor(term), note: d.note.trim() });
        commit(`Loan of ${fmt(principal)} released`);
      },
    });
  },
  'pay-loan': ({ id }) => {
    const li = loanInfo(state.loans.find(l => l.id === id));
    openModal({
      title: 'Record loan payment', body: paymentForm(li), submitLabel: 'Record payment',
      onSubmit: d => {
        const amount = parseAmount(d.amount);
        if (!d.date) return fail('Please enter the payment date.');
        if (!(amount > 0)) return fail('Amount must be more than zero.');
        if (amount > li.balance + EPS) return fail(`Amount is more than the remaining balance (${fmt(li.balance)}).`);
        state.payments.push({ id: uid(), ts: Date.now(), loanId: id, date: d.date, amount, note: d.note.trim() });
        commit(`Payment of ${fmt(amount)} recorded`);
      },
    });
  },
  'view-loan': ({ id }) => {
    const loan = state.loans.find(l => l.id === id);
    const li = loanInfo(loan);
    openModal({
      title: 'Loan details', body: loanDetails(li), wide: true,
      footer: `<button type="button" class="danger" data-modal-action="delete-loan" data-id="${id}">Delete loan</button>
        <span style="flex:1"></span>
        ${li.balance > EPS ? `<button type="button" data-modal-action="pay-from-details" data-id="${id}">Record payment</button>` : ''}
        <button type="button" class="primary" data-close>Close</button>`,
    });
  },

  'add-other': ({ type }) => openModal({
    title: type === 'in' ? 'Add other income' : 'Add expense',
    body: `
      <div class="fields">
        <div class="field"><label for="f-date">Date</label><input id="f-date" name="date" type="date" value="${defaultDateInYear()}" required></div>
        <div class="field"><label for="f-amount">Amount (₱)</label><input id="f-amount" name="amount" type="number" min="0.01" step="0.01" required></div>
      </div>
      <div class="field"><label for="f-desc">Description</label><input id="f-desc" name="description" placeholder="${type === 'in' ? 'e.g. bank interest, penalty fee' : 'e.g. bank fee, GCash transfer fee'}" required></div>`,
    onSubmit: d => {
      const amount = parseAmount(d.amount);
      if (!d.date) return fail('Please enter a date.');
      if (!(amount > 0)) return fail('Amount must be more than zero.');
      if (!d.description.trim()) return fail('Please add a description.');
      state.others.push({ id: uid(), ts: Date.now(), type, date: d.date, amount, description: d.description.trim() });
      commit(type === 'in' ? 'Income recorded' : 'Expense recorded');
    },
  }),
  'delete-other': ({ id }) => {
    if (!confirm('Delete this entry?')) return;
    state.others = state.others.filter(o => o.id !== id);
    commit('Entry deleted');
  },

  'toggle-paid': () => { ui.showPaidLoans = !ui.showPaidLoans; render(); },
  'toggle-remaining': () => { ui.includeRemainingDues = !ui.includeRemainingDues; render(); },
  print: () => window.print(),

  'close-year': () => {
    const year = Number(Y());
    const c = compute();
    const open = c.openLoans;
    const unpaidDues = c.rows.filter(r => r.remainingDues > EPS);
    const msg = [
      `Close fund year ${year}?`,
      '',
      `• Total fund balance: ${fmt(c.totalBalance)}`,
      `• Payouts to members: ${fmt(sum(c.rows, r => r.payout))}`,
      `• Carry-over to ${year + 1}: ${fmt(c.retained)}`,
      open.length ? `• ${open.length} open loan(s) totalling ${fmt(sum(open, li => li.balance))} will be marked paid via payout deduction (dated Dec 31).` : '',
      unpaidDues.length ? `• Note: ${unpaidDues.length} member(s) have not completed their dues — payouts use actual contributions.` : '',
      '',
      'A backup file will be downloaded first. The active year will then switch to ' + (year + 1) + '.',
    ].filter(x => x !== '').join('\n');
    if (!confirm(msg)) return;

    exportJSON(`sinking-fund-backup-before-closing-${year}`);
    const closeDate = `${year}-12-31`;
    open.forEach((li, i) => state.payments.push({
      id: uid(), ts: Date.now() + i, loanId: li.loan.id, date: closeDate, amount: li.balance, note: 'Deducted from year-end payout',
    }));
    const f = compute(); // recompute with loans settled
    state.history.push({
      year, closedOn: todayISO(),
      totalBalance: f.totalBalance, interestTotal: f.interestTotal, retained: f.retained, distributable: f.distributable,
      earningsPerHead: f.earningsPerHead, totalHeads: f.totalHeads,
      payouts: c.rows.map(r => ({ memberId: r.member.id, name: r.member.name, heads: r.heads, contrib: r.contrib, earningsShare: r.earningsShare, netShare: r.netShare, loanDeducted: r.loanBalance, payout: r.payout })),
    });
    S().openingByYear[String(year + 1)] = f.retained;
    S().year = year + 1;
    commit(`Year ${year} closed. ${fmt(f.retained)} carried over to ${year + 1}.`);
  },
  'view-history': ({ index }) => {
    const h = state.history[Number(index)];
    openModal({
      title: `Payouts — ${h.year}`, wide: true,
      body: `
        <p class="muted" style="margin-bottom:12px">Closed ${fmtDate(h.closedOn)} · Total balance ${fmt(h.totalBalance)} · Earnings per head ${fmt(h.earningsPerHead)} · Carry-over ${fmt(h.retained)}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Member</th><th class="num">Heads</th><th class="num">Contributions</th><th class="num">Earnings</th><th class="num">Net share</th><th class="num">Loan deducted</th><th class="num">Payout</th></tr></thead>
          <tbody>${h.payouts.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.heads}</td><td class="num">${fmt(p.contrib)}</td><td class="num">${fmt(p.earningsShare)}</td>
            <td class="num">${fmt(p.netShare)}</td><td class="num">${p.loanDeducted ? fmt(p.loanDeducted) : '—'}</td><td class="num"><strong>${fmt(p.payout)}</strong></td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td><td class="num">${sum(h.payouts, p => p.heads)}</td><td class="num">${fmt(sum(h.payouts, p => p.contrib))}</td><td class="num">${fmt(sum(h.payouts, p => p.earningsShare))}</td>
            <td class="num">${fmt(sum(h.payouts, p => p.netShare))}</td><td class="num">${fmt(sum(h.payouts, p => p.loanDeducted))}</td><td class="num">${fmt(sum(h.payouts, p => p.payout))}</td></tr></tfoot>
        </table></div>`,
      footer: '<button type="button" data-modal-action="print-modal">Print</button><button type="button" class="primary" data-close>Close</button>',
    });
  },

  'export-csv': () => {
    const rows = ledgerRows();
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Date', 'Type', 'Member', 'Details', 'In', 'Out', 'Cash balance'].map(q).join(',')];
    lines.push([`${Y()}-01-01`, 'Opening carry-over', '', '', openingCarryOver(), '', openingCarryOver()].map(q).join(','));
    rows.forEach(r => lines.push([r.date, r.kind, r.who, r.desc, r.inAmt || '', r.outAmt || '', r.balance].map(q).join(',')));
    download(`sinking-fund-ledger-${Y()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
  },
  'export-json': () => exportJSON(),
  'import-json': () => document.getElementById('import-file').click(),
  'load-sample': () => {
    if (!confirm('Replace ALL current data with sample data?')) return;
    state = sampleData();
    commit('Sample data loaded');
  },
  reset: () => {
    if (!confirm('Erase ALL data? This cannot be undone unless you have a backup.')) return;
    if (prompt('Type ERASE to confirm') !== 'ERASE') return;
    state = defaultState();
    commit('All data erased');
  },
};

const modalActions = {
  'pay-full': ({ amount }) => { modalForm.amount.value = amount; },
  'print-modal': () => {
    document.body.classList.add('print-modal');
    window.print();
    document.body.classList.remove('print-modal');
  },
  'delete-payment': ({ id, loan }) => {
    if (!confirm('Delete this payment?')) return;
    state.payments = state.payments.filter(p => p.id !== id);
    save(); render();
    actions['view-loan']({ id: loan });
    toast('Payment deleted');
  },
  'delete-loan': ({ id }) => {
    const pays = state.payments.filter(p => p.loanId === id).length;
    if (!confirm(`Delete this loan${pays ? ` and its ${pays} payment(s)` : ''}?`)) return;
    state.loans = state.loans.filter(l => l.id !== id);
    state.payments = state.payments.filter(p => p.loanId !== id);
    closeModal();
    commit('Loan deleted');
  },
  'pay-from-details': ({ id }) => { closeModal(); actions['pay-loan']({ id }); },
};

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function exportJSON(base) {
  save();
  download(`${base || `sinking-fund-backup-${todayISO()}`}.json`, JSON.stringify(state, null, 2), 'application/json');
}

// ---------- event wiring ----------
view.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || el.type === 'checkbox') return;
  e.preventDefault();
  if (EDIT_ACTIONS.has(el.dataset.action) && !canEdit()) return toast('View only');
  actions[el.dataset.action]?.(el.dataset);
});
document.getElementById('auth-box').addEventListener('click', e => {
  const btn = e.target.closest('[data-auth]');
  if (!btn) return;
  const fn = btn.dataset.auth === 'in' ? window.cloudSignIn : window.cloudSignOut;
  fn?.().catch(err => { if (err?.code !== 'auth/popup-closed-by-user') alert('Sign-in failed: ' + err.message); });
});
view.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.action === 'contrib-filter') { ui.contribFilter = el.value; render(); }
  else if (el.type === 'checkbox' && el.dataset.action) actions[el.dataset.action]?.(el.dataset);
  else if (el.id === 'import-file' && el.files[0]) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.settings || !Array.isArray(data.members)) throw new Error('Not a sinking fund backup');
        if (!confirm(`Import backup with ${data.members.length} members? This replaces your current data.`)) return;
        state = normalize(data);
        commit('Backup imported');
      } catch (err) { alert('Could not import: ' + err.message); }
    };
    reader.readAsText(el.files[0]);
    el.value = '';
  }
});
view.addEventListener('submit', e => {
  if (e.target.id !== 'settings-form') return;
  e.preventDefault();
  if (!canEdit()) return;
  const f = Object.fromEntries(new FormData(e.target));
  const s = S();
  const perHead = parseAmount(f.perHead);
  const retention = parseFloat(f.retentionPct);
  const rates = [1, 2, 3].map(t => parseFloat(f['rate' + t]));
  if (!f.fundName.trim()) return alert('Please enter a fund name.');
  if (!(perHead >= 0)) return alert('Contribution per head must be a number.');
  if (!(retention >= 0 && retention <= 100)) return alert('Retention must be between 0 and 100%.');
  if (rates.some(r => !(r >= 0))) return alert('Interest rates must be numbers.');
  s.fundName = f.fundName.trim();
  s.perHead = perHead;
  s.frequency = f.frequency;
  s.startMonth = Number(f.startMonth);
  s.retentionPct = retention;
  rates.forEach((r, i) => { s.rates[i + 1] = r; });
  const yearChanged = String(f.year) !== Y();
  // Opening carry-over belongs to the year shown in the form before any year switch.
  s.openingByYear[Y()] = parseAmount(f.opening) || 0;
  s.year = Number(f.year);
  commit(yearChanged ? `Switched to fund year ${s.year}` : 'Settings saved');
});

function route() {
  const tab = location.hash.slice(1);
  ui.tab = views[tab] ? tab : 'dashboard';
  render();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
window.addEventListener('storage', e => { if (e.key === STORAGE_KEY) { state = load(); render(); } });

// ---------- sample data ----------
function sampleData() {
  const s = defaultState();
  const year = Number(s.settings.year);
  const names = [['Faith', 2], ['Ana', 1], ['Ben', 3], ['Carla', 1], ['Dan', 2]];
  s.members = names.map(([name, heads], i) => ({ id: uid(), name, heads, joined: '', notes: '', ts: i }));
  const today = todayISO();
  let ts = 1;
  for (let m = 1; m <= 12; m++) {
    for (const day of [15, new Date(year, m, 0).getDate()]) {
      const date = `${year}-${pad(m)}-${pad(day)}`;
      if (date > today) continue;
      s.members.forEach((mem, i) => {
        if (mem.name === 'Carla' && m >= 8 && day !== 15) return; // someone falling behind
        s.contributions.push({ id: uid(), ts: ts++, memberId: mem.id, date, amount: mem.heads * s.settings.perHead, note: '' });
      });
    }
  }
  const mk = (who, date, principal, term) => {
    if (date > today) return null;
    const loan = { id: uid(), ts: ts++, memberId: s.members[who].id, date, principal, term, rate: s.settings.rates[term], note: '' };
    s.loans.push(loan);
    return loan;
  };
  const pay = (loan, date, amount) => { if (loan && date <= today) s.payments.push({ id: uid(), ts: ts++, loanId: loan.id, date, amount, note: '' }); };
  const l1 = mk(1, `${year}-02-20`, 5000, 2);
  pay(l1, `${year}-03-20`, 2700); pay(l1, `${year}-04-20`, 2700);
  const l2 = mk(2, `${year}-04-05`, 10000, 3);
  pay(l2, `${year}-05-05`, 3633.33); pay(l2, `${year}-06-05`, 3633.33); pay(l2, `${year}-07-05`, 3633.34);
  const l3 = mk(4, `${year}-06-10`, 3000, 1);
  pay(l3, `${year}-07-10`, 3150);
  const l4 = mk(0, `${year}-08-01`, 8000, 3);
  pay(l4, `${year}-09-01`, 2906.67);
  mk(3, `${year}-08-25`, 4000, 2);
  s.others.push({ id: uid(), ts: ts++, type: 'out', date: `${year}-03-01`, amount: 50, description: 'Bank transfer fee' });
  return s;
}

route();
