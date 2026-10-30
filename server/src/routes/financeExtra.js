import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { requirePermission, audit } from '../access.js';
import { parseDate, todayUtc } from '../validate.js';
import { CURRENCY_RE, parseMinor, addMonths } from '../finance/money.js';
import { monthBudget } from '../finance/budget.js';

const router = Router();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------- monthly category budgets ----------
router.get('/budget', (req, res) => {
  const month = MONTH_RE.test(String(req.query.month)) ? String(req.query.month) : todayUtc().slice(0, 7);
  res.json(monthBudget(req.ws.id, month));
});

router.put('/budget', requirePermission('budget:approve'), (req, res) => {
  const { month, categoryId } = req.body;
  const currency = String(req.body.currency || '').toUpperCase();
  const amount = Number(req.body.amount_minor);
  if (!MONTH_RE.test(String(month))) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (!CURRENCY_RE.test(currency)) return res.status(400).json({ error: 'currency must be a 3-letter code' });
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e12) return res.status(400).json({ error: 'amount_minor must be a non-negative integer' });
  if (!db.prepare('SELECT 1 FROM transaction_categories WHERE id = ? AND workspace_id = ?').get(String(categoryId), req.ws.id)) return res.status(400).json({ error: 'invalid category' });
  db.prepare(`INSERT INTO monthly_budgets (workspace_id, month, category_id, currency, amount_minor) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, month, category_id, currency) DO UPDATE SET amount_minor = excluded.amount_minor`).run(req.ws.id, month, categoryId, currency, amount);
  audit(req, 'budget.monthly_set', 'category', categoryId, { month, currency, amount_minor: amount });
  res.json(monthBudget(req.ws.id, month));
});

router.delete('/budget', requirePermission('budget:approve'), (req, res) => {
  const { month, categoryId, currency } = req.query;
  if (!MONTH_RE.test(String(month))) return res.status(400).json({ error: 'month must be YYYY-MM' });
  db.prepare('DELETE FROM monthly_budgets WHERE workspace_id = ? AND month = ? AND category_id = ? AND currency = ?').run(req.ws.id, String(month), String(categoryId), String(currency || '').toUpperCase());
  audit(req, 'budget.monthly_remove', 'category', String(categoryId), { month });
  res.json(monthBudget(req.ws.id, String(month)));
});

// Replace the whole month's budget for one currency in one step (the budget builder). Lines with 0/blank are removed.
router.put('/budget/bulk', requirePermission('budget:approve'), (req, res) => {
  const { month } = req.body;
  const currency = String(req.body.currency || '').toUpperCase();
  const lines = Array.isArray(req.body.lines) ? req.body.lines.slice(0, 100) : null;
  if (!MONTH_RE.test(String(month))) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (!CURRENCY_RE.test(currency)) return res.status(400).json({ error: 'currency must be a 3-letter code' });
  if (!lines) return res.status(400).json({ error: 'lines must be an array' });
  const clean = [];
  for (const l of lines) {
    const amount = Number(l.amount_minor);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e12) return res.status(400).json({ error: 'amount_minor must be a non-negative integer' });
    if (!db.prepare('SELECT 1 FROM transaction_categories WHERE id = ? AND workspace_id = ?').get(String(l.categoryId), req.ws.id)) return res.status(400).json({ error: 'invalid category' });
    clean.push({ categoryId: String(l.categoryId), amount });
  }
  tx(() => {
    db.prepare('DELETE FROM monthly_budgets WHERE workspace_id = ? AND month = ? AND currency = ?').run(req.ws.id, month, currency);
    for (const l of clean.filter((c) => c.amount > 0)) {
      db.prepare('INSERT OR REPLACE INTO monthly_budgets (workspace_id, month, category_id, currency, amount_minor) VALUES (?, ?, ?, ?, ?)').run(req.ws.id, month, l.categoryId, currency, l.amount);
    }
  });
  audit(req, 'budget.monthly_bulk', 'month', month, { currency, lines: clean.filter((c) => c.amount > 0).length });
  res.json(monthBudget(req.ws.id, month));
});

// Income vs expenses for the last N months (default 6), per currency. For the trend chart.
router.get('/trend', (req, res) => {
  const n = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  const first = `${todayUtc().slice(0, 7)}-01`;
  const months = Array.from({ length: n }, (_, i) => addMonths(first, -(n - 1 - i)).slice(0, 7));
  const rows = db.prepare(`SELECT substr(date, 1, 7) AS month, currency, type, SUM(amount_minor) AS total FROM transactions
    WHERE workspace_id = ? AND voided_at IS NULL AND status = 'posted' AND type <> 'transfer' AND substr(date, 1, 7) BETWEEN ? AND ? GROUP BY month, currency, type`).all(req.ws.id, months[0], months[n - 1]);
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  res.json({ months, series: currencies.map((currency) => ({ currency, points: months.map((m) => {
    const of = (t) => rows.filter((r) => r.month === m && r.currency === currency && r.type === t).reduce((a, r) => a + r.total, 0);
    return { month: m, income_minor: of('income'), expenses_minor: of('expense') - of('refund') };
  }) })) });
});

// ---------- savings goals / emergency fund ----------
const goalInWs = (id, ws) => db.prepare('SELECT * FROM savings_goals WHERE id = ? AND workspace_id = ?').get(String(id), ws);

function avgMonthlyExpenses(ws, currency, today = todayUtc()) {
  // the three COMPLETE months before the current one; deterministic, same-currency only
  const first = `${today.slice(0, 7)}-01`;
  const from = addMonths(first, -3).slice(0, 7);
  const to = addMonths(first, -1).slice(0, 7);
  const row = db.prepare(`SELECT SUM(CASE type WHEN 'expense' THEN amount_minor ELSE -amount_minor END) AS total FROM transactions
    WHERE workspace_id = ? AND voided_at IS NULL AND status = 'posted' AND type IN ('expense','refund') AND currency = ? AND substr(date, 1, 7) BETWEEN ? AND ?`).get(ws, currency, from, to);
  return Math.round((row.total || 0) / 3);
}

function presentGoal(g) {
  const e = db.prepare("SELECT SUM(CASE kind WHEN 'deposit' THEN amount_minor ELSE -amount_minor END) AS bal FROM savings_entries WHERE goal_id = ?").get(g.id);
  const balance = e.bal || 0;
  const entries = db.prepare('SELECT id, kind, amount_minor, date, note FROM savings_entries WHERE goal_id = ? ORDER BY date DESC, created_at DESC LIMIT 20').all(g.id);
  const out = { id: g.id, name: g.name, currency: g.currency, target_minor: g.target_minor, target_date: g.target_date, is_emergency_fund: !!g.is_emergency_fund,
    balance_minor: balance, progress: Math.min(100, Math.round((balance / g.target_minor) * 100)), remaining_minor: Math.max(0, g.target_minor - balance), entries };
  if (g.is_emergency_fund) {
    const avg = avgMonthlyExpenses(g.workspace_id, g.currency);
    out.avg_monthly_expenses_minor = avg;
    out.months_covered = avg > 0 ? Math.round((balance / avg) * 10) / 10 : null; // balance / average spending of the last 3 full months
  }
  return out;
}

router.get('/savings', (req, res) => {
  res.json(db.prepare('SELECT * FROM savings_goals WHERE workspace_id = ? AND archived_at IS NULL ORDER BY is_emergency_fund DESC, created_at').all(req.ws.id).map(presentGoal));
});

router.post('/savings', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const currency = String(req.body.currency || '').toUpperCase();
  const target = parseMinor(req.body.target_minor);
  const date = req.body.target_date ? parseDate(req.body.target_date) : null;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!CURRENCY_RE.test(currency)) return res.status(400).json({ error: 'currency must be a 3-letter code' });
  if (target === undefined) return res.status(400).json({ error: 'target_minor must be a positive integer' });
  if (date === undefined) return res.status(400).json({ error: 'target_date must be a valid YYYY-MM-DD date' });
  const id = nanoid();
  db.prepare('INSERT INTO savings_goals (id, workspace_id, name, currency, target_minor, target_date, is_emergency_fund, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.ws.id, name, currency, target, date, req.body.is_emergency_fund ? 1 : 0, nowIso());
  audit(req, 'savings.create', 'savings_goal', id);
  res.status(201).json(presentGoal(goalInWs(id, req.ws.id)));
});

router.patch('/savings/:id', (req, res) => {
  const g = goalInWs(req.params.id, req.ws.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 100) : g.name;
  let target = g.target_minor;
  if (req.body.target_minor !== undefined) { target = parseMinor(req.body.target_minor); if (target === undefined) return res.status(400).json({ error: 'target_minor must be a positive integer' }); }
  if (!name) return res.status(400).json({ error: 'name cannot be empty' });
  const archived = 'archived' in req.body ? (req.body.archived ? (g.archived_at || nowIso()) : null) : g.archived_at;
  db.prepare('UPDATE savings_goals SET name = ?, target_minor = ?, archived_at = ? WHERE id = ?').run(name, target, archived, g.id);
  res.json(presentGoal(goalInWs(g.id, req.ws.id)));
});

router.post('/savings/:id/entries', (req, res) => {
  const g = goalInWs(req.params.id, req.ws.id);
  if (!g || g.archived_at) return res.status(404).json({ error: 'not found' });
  const kind = req.body.kind;
  const amount = parseMinor(req.body.amount_minor);
  const date = req.body.date ? parseDate(req.body.date) : todayUtc();
  if (!['deposit', 'withdrawal'].includes(kind)) return res.status(400).json({ error: 'kind must be deposit or withdrawal' });
  if (amount === undefined) return res.status(400).json({ error: 'amount_minor must be a positive integer' });
  if (!date) return res.status(400).json({ error: 'date must be a valid YYYY-MM-DD date' });
  if (kind === 'withdrawal' && amount > presentGoal(g).balance_minor) return res.status(400).json({ error: 'withdrawal exceeds the current balance' });
  db.prepare('INSERT INTO savings_entries (id, goal_id, kind, amount_minor, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nanoid(), g.id, kind, amount, date, String(req.body.note || '').slice(0, 200), nowIso());
  audit(req, `savings.${kind}`, 'savings_goal', g.id, { amount_minor: amount });
  res.status(201).json(presentGoal(goalInWs(g.id, req.ws.id)));
});

router.delete('/savings/:id/entries/:eid', (req, res) => {
  const g = goalInWs(req.params.id, req.ws.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  const entry = db.prepare('SELECT * FROM savings_entries WHERE id = ? AND goal_id = ?').get(req.params.eid, g.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  // removing a deposit must not leave a negative balance
  if (entry.kind === 'deposit' && presentGoal(g).balance_minor - entry.amount_minor < 0) return res.status(400).json({ error: 'removing this deposit would make the balance negative' });
  db.prepare('DELETE FROM savings_entries WHERE id = ?').run(entry.id);
  res.json(presentGoal(goalInWs(g.id, req.ws.id)));
});

// ---------- debts (tracking only: no interest is calculated) ----------
const debtInWs = (id, ws) => db.prepare('SELECT * FROM debts WHERE id = ? AND workspace_id = ?').get(String(id), ws);
function presentDebt(d) {
  const paid = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM debt_payments WHERE debt_id = ?').get(d.id).n;
  return { id: d.id, name: d.name, currency: d.currency, original_minor: d.original_minor, interest_rate_pct: d.interest_rate_bps === null ? null : d.interest_rate_bps / 100,
    min_payment_minor: d.min_payment_minor, paid_minor: paid, remaining_minor: Math.max(0, d.original_minor - paid), paid_pct: Math.min(100, Math.round((paid / d.original_minor) * 100)),
    payments: db.prepare('SELECT id, amount_minor, date, note FROM debt_payments WHERE debt_id = ? ORDER BY date DESC, created_at DESC LIMIT 20').all(d.id) };
}

router.get('/debts', (req, res) => {
  res.json(db.prepare('SELECT * FROM debts WHERE workspace_id = ? AND archived_at IS NULL ORDER BY created_at').all(req.ws.id).map(presentDebt));
});

router.post('/debts', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const currency = String(req.body.currency || '').toUpperCase();
  const original = parseMinor(req.body.original_minor);
  const minPay = req.body.min_payment_minor == null ? null : parseMinor(req.body.min_payment_minor);
  const rate = req.body.interest_rate_pct == null ? null : Math.round(Number(req.body.interest_rate_pct) * 100);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!CURRENCY_RE.test(currency)) return res.status(400).json({ error: 'currency must be a 3-letter code' });
  if (original === undefined) return res.status(400).json({ error: 'original_minor must be a positive integer' });
  if (minPay === undefined) return res.status(400).json({ error: 'min_payment_minor must be a positive integer' });
  if (rate !== null && (!Number.isInteger(rate) || rate < 0 || rate > 100000)) return res.status(400).json({ error: 'interest_rate_pct must be between 0 and 1000' });
  const id = nanoid();
  db.prepare('INSERT INTO debts (id, workspace_id, name, currency, original_minor, interest_rate_bps, min_payment_minor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, req.ws.id, name, currency, original, rate, minPay, nowIso());
  audit(req, 'debt.create', 'debt', id);
  res.status(201).json(presentDebt(debtInWs(id, req.ws.id)));
});

router.patch('/debts/:id', (req, res) => {
  const d = debtInWs(req.params.id, req.ws.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const archived = 'archived' in req.body ? (req.body.archived ? (d.archived_at || nowIso()) : null) : d.archived_at;
  db.prepare('UPDATE debts SET archived_at = ? WHERE id = ?').run(archived, d.id);
  res.json(presentDebt(debtInWs(d.id, req.ws.id)));
});

router.post('/debts/:id/payments', (req, res) => {
  const d = debtInWs(req.params.id, req.ws.id);
  if (!d || d.archived_at) return res.status(404).json({ error: 'not found' });
  const amount = parseMinor(req.body.amount_minor);
  const date = req.body.date ? parseDate(req.body.date) : todayUtc();
  if (amount === undefined) return res.status(400).json({ error: 'amount_minor must be a positive integer' });
  if (!date) return res.status(400).json({ error: 'date must be a valid YYYY-MM-DD date' });
  if (amount > presentDebt(d).remaining_minor) return res.status(400).json({ error: 'payment exceeds the remaining balance' });
  db.prepare('INSERT INTO debt_payments (id, debt_id, amount_minor, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(nanoid(), d.id, amount, date, String(req.body.note || '').slice(0, 200), nowIso());
  audit(req, 'debt.payment', 'debt', d.id, { amount_minor: amount });
  res.status(201).json(presentDebt(debtInWs(d.id, req.ws.id)));
});

router.delete('/debts/:id/payments/:pid', (req, res) => {
  const d = debtInWs(req.params.id, req.ws.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM debt_payments WHERE id = ? AND debt_id = ?').run(req.params.pid, d.id);
  res.json(presentDebt(debtInWs(d.id, req.ws.id)));
});

export default router;
