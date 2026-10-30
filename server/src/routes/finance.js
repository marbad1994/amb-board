import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { projectInWs, requirePermission, audit } from '../access.js';
import { parseDate, todayUtc, escapeLike } from '../validate.js';
import { CURRENCY_RE, parseMinor, nextOccurrence } from '../finance/money.js';
import { projectBudgetMetrics } from '../finance/calc.js';

const router = Router();
export const projectFinanceRouter = Router(); // mounted under /api/projects

const TYPES = ['income', 'expense', 'refund', 'transfer'];
const STATUSES = ['posted', 'planned'];
const ACCOUNT_KINDS = ['checking', 'savings', 'cash', 'credit', 'investment'];

const catInWs = (id, ws) => db.prepare('SELECT * FROM transaction_categories WHERE id = ? AND workspace_id = ?').get(String(id), ws);
const accInWs = (id, ws) => db.prepare('SELECT * FROM financial_accounts WHERE id = ? AND workspace_id = ?').get(String(id), ws);
const txInWs = (id, ws) => db.prepare('SELECT * FROM transactions WHERE id = ? AND workspace_id = ?').get(String(id), ws);

// ---------- recurring expenses -> planned transactions (idempotent, run lazily) ----------
export function materializeRecurring(workspaceId, today = todayUtc()) {
  const due = db.prepare('SELECT * FROM recurring_expenses WHERE workspace_id = ? AND active = 1 AND next_date <= ?').all(workspaceId, today);
  let created = 0;
  for (const r of due) {
    tx(() => {
      let next = r.next_date;
      let guard = 0;
      while (next <= today && guard++ < 60) {
        const ts = nowIso();
        // external_ref makes re-running (or a concurrent run) a no-op for an occurrence that already exists
        const res = db.prepare(`INSERT OR IGNORE INTO transactions (id, workspace_id, type, status, amount_minor, currency, date, description,
            category_id, project_id, external_ref, source, created_at, updated_at)
          VALUES (?, ?, 'expense', 'planned', ?, ?, ?, ?, ?, ?, ?, 'recurring', ?, ?)`)
          .run(nanoid(), workspaceId, r.amount_minor, r.currency, next, r.description, r.category_id, r.project_id, `recurring:${r.id}:${next}`, ts, ts);
        created += Number(res.changes);
        next = nextOccurrence(next, r.frequency, r.anchor_date);
      }
      db.prepare('UPDATE recurring_expenses SET next_date = ? WHERE id = ?').run(next, r.id);
    });
  }
  return created;
}

// ---------- accounts ----------
router.get('/accounts', (req, res) => {
  res.json(db.prepare('SELECT id, name, currency, kind FROM financial_accounts WHERE workspace_id = ? AND archived_at IS NULL ORDER BY created_at').all(req.ws.id));
});
router.post('/accounts', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const currency = String(req.body.currency || '').toUpperCase();
  const kind = req.body.kind || 'checking';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!CURRENCY_RE.test(currency)) return res.status(400).json({ error: 'currency must be a 3-letter code' });
  if (!ACCOUNT_KINDS.includes(kind)) return res.status(400).json({ error: 'invalid account kind' });
  const id = nanoid();
  db.prepare('INSERT INTO financial_accounts (id, workspace_id, name, currency, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.ws.id, name, currency, kind, nowIso());
  res.status(201).json({ id, name, currency, kind });
});

// ---------- categories ----------
router.get('/categories', (req, res) => {
  res.json(db.prepare('SELECT id, name, parent_id FROM transaction_categories WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name').all(req.ws.id));
});
router.post('/categories', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name is required' });
  let parent = null;
  if (req.body.parentId) {
    parent = catInWs(req.body.parentId, req.ws.id);
    if (!parent || parent.parent_id) return res.status(400).json({ error: 'invalid parent category (one level of nesting)' });
  }
  const id = nanoid();
  db.prepare('INSERT INTO transaction_categories (id, workspace_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.ws.id, name, parent?.id ?? null, nowIso());
  res.status(201).json({ id, name, parent_id: parent?.id ?? null });
});

// ---------- transactions ----------
const TX_SELECT = `SELECT t.*, c.name AS category_name, p.name AS project_name FROM transactions t
  LEFT JOIN transaction_categories c ON c.id = t.category_id LEFT JOIN projects p ON p.id = t.project_id`;

// Validates a body against current values; returns { error } or { v }.
export function readTransaction(body, ws, cur = {}) {
  const v = {
    type: cur.type ?? body.type, status: cur.status ?? 'posted', amount_minor: cur.amount_minor, currency: cur.currency,
    date: cur.date, description: cur.description ?? '', notes: cur.notes ?? '', category_id: cur.category_id ?? null,
    project_id: cur.project_id ?? null, account_id: cur.account_id ?? null, to_account_id: cur.to_account_id ?? null,
  };
  if (body.type !== undefined) v.type = body.type;
  if (!TYPES.includes(v.type)) return { error: `type must be one of ${TYPES.join(', ')}` };
  if (body.status !== undefined) v.status = body.status;
  if (!STATUSES.includes(v.status)) return { error: `status must be one of ${STATUSES.join(', ')}` };
  if (body.amount_minor !== undefined) {
    v.amount_minor = parseMinor(body.amount_minor);
    if (v.amount_minor === undefined) return { error: 'amount_minor must be a positive integer (minor units)' };
  }
  if (!v.amount_minor) return { error: 'amount_minor is required' };
  if (body.currency !== undefined) v.currency = String(body.currency).toUpperCase();
  if (!CURRENCY_RE.test(v.currency || '')) return { error: 'currency must be a 3-letter code' };
  if (body.date !== undefined) v.date = parseDate(body.date) ?? undefined;
  if (!v.date) return { error: 'date must be a valid YYYY-MM-DD date' };
  for (const k of ['description', 'notes']) if (body[k] !== undefined) v[k] = String(body[k]).slice(0, k === 'notes' ? 2000 : 200);
  if (body.categoryId !== undefined) {
    if (body.categoryId && !catInWs(body.categoryId, ws)) return { error: 'invalid category' };
    v.category_id = body.categoryId || null;
  }
  if (body.projectId !== undefined) {
    if (body.projectId && !projectInWs(body.projectId, ws)) return { error: 'invalid project' };
    v.project_id = body.projectId || null;
  }
  for (const [key, col] of [['accountId', 'account_id'], ['toAccountId', 'to_account_id']]) {
    if (body[key] !== undefined) {
      if (body[key] && !accInWs(body[key], ws)) return { error: `invalid ${key}` };
      v[col] = body[key] || null;
    }
  }
  if (v.type === 'transfer') {
    if (v.project_id) return { error: 'transfers cannot be assigned to a project (they are not expenses)' };
    if (!v.account_id || !v.to_account_id || v.account_id === v.to_account_id) return { error: 'a transfer needs two different accounts' };
  } else v.to_account_id = null;
  return { v };
}

router.get('/transactions', (req, res) => {
  const where = ['t.workspace_id = ?', 't.voided_at IS NULL'];
  const params = [req.ws.id];
  const q = req.query;
  if (q.month && /^\d{4}-\d{2}$/.test(q.month)) { where.push('substr(t.date, 1, 7) = ?'); params.push(q.month); }
  if (q.project) { where.push('t.project_id = ?'); params.push(String(q.project)); }
  if (q.category) { where.push('t.category_id = ?'); params.push(String(q.category)); }
  if (q.status && STATUSES.includes(q.status)) { where.push('t.status = ?'); params.push(q.status); }
  if (q.type && TYPES.includes(q.type)) { where.push('t.type = ?'); params.push(q.type); }
  if (q.q) { where.push("(t.description LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')"); const l = `%${escapeLike(String(q.q).slice(0, 80))}%`; params.push(l, l); }
  const limit = Math.min(Number(q.limit) || 100, 500);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${where.join(' AND ')}`).get(...params).n;
  const rows = db.prepare(`${TX_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ total, items: rows });
});

// CSV export. Cells that spreadsheets would execute as formulas are prefixed with an apostrophe.
router.get('/transactions/export.csv', (req, res) => {
  const rows = db.prepare(`${TX_SELECT} WHERE t.workspace_id = ? AND t.voided_at IS NULL ORDER BY t.date, t.created_at LIMIT 50000`).all(req.ws.id);
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['date', 'type', 'status', 'amount', 'currency', 'description', 'category', 'project', 'notes'];
  const lines = [head.join(',')].concat(rows.map((r) => [r.date, r.type, r.status, (r.amount_minor / 100).toFixed(2), r.currency,
    r.description, r.category_name, r.project_name, r.notes].map(cell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.send(lines.join('\n'));
});

router.post('/transactions', (req, res) => {
  const r = readTransaction(req.body, req.ws.id);
  if (r.error) return res.status(400).json({ error: r.error });
  const v = r.v;
  const ref = req.body.externalRef ? String(req.body.externalRef).slice(0, 200) : null;
  if (ref) {
    // idempotency: the same external reference never creates a second transaction
    const dup = db.prepare('SELECT id FROM transactions WHERE workspace_id = ? AND external_ref = ?').get(req.ws.id, ref);
    if (dup) return res.status(200).json({ ...db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(dup.id), duplicate: true });
  }
  const id = nanoid();
  const ts = nowIso();
  db.prepare(`INSERT INTO transactions (id, workspace_id, type, status, amount_minor, currency, date, description, notes, category_id, project_id,
      account_id, to_account_id, external_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.ws.id, v.type, v.status, v.amount_minor, v.currency, v.date, v.description, v.notes, v.category_id, v.project_id,
      v.account_id, v.to_account_id, ref, req.user.id, ts, ts);
  audit(req, 'transaction.create', 'transaction', id, { type: v.type, amount_minor: v.amount_minor, currency: v.currency, project_id: v.project_id });
  res.status(201).json(db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id));
});

router.patch('/transactions/:id', (req, res) => {
  const cur = txInWs(req.params.id, req.ws.id);
  if (!cur || cur.voided_at) return res.status(404).json({ error: 'not found' });
  const r = readTransaction(req.body, req.ws.id, cur);
  if (r.error) return res.status(400).json({ error: r.error });
  const v = r.v;
  db.prepare(`UPDATE transactions SET type = ?, status = ?, amount_minor = ?, currency = ?, date = ?, description = ?, notes = ?, category_id = ?,
      project_id = ?, account_id = ?, to_account_id = ?, updated_at = ? WHERE id = ?`)
    .run(v.type, v.status, v.amount_minor, v.currency, v.date, v.description, v.notes, v.category_id, v.project_id, v.account_id, v.to_account_id, nowIso(), cur.id);
  audit(req, 'transaction.update', 'transaction', cur.id);
  res.json(db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(cur.id));
});

// Voiding keeps the record (audit trail) but removes it from every total.
router.delete('/transactions/:id', (req, res) => {
  const cur = txInWs(req.params.id, req.ws.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE transactions SET voided_at = ?, updated_at = ? WHERE id = ? AND voided_at IS NULL').run(nowIso(), nowIso(), cur.id);
  audit(req, 'transaction.void', 'transaction', cur.id);
  res.status(204).end();
});

// ---------- monthly summary (never mixes currencies) ----------
router.get('/summary', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : todayUtc().slice(0, 7);
  materializeRecurring(req.ws.id);
  const rows = db.prepare(`SELECT currency, type, status, category_id, SUM(amount_minor) AS total FROM transactions
    WHERE workspace_id = ? AND voided_at IS NULL AND substr(date, 1, 7) = ? AND type <> 'transfer' GROUP BY currency, type, status, category_id`).all(req.ws.id, month);
  const names = Object.fromEntries(db.prepare('SELECT id, name FROM transaction_categories WHERE workspace_id = ?').all(req.ws.id).map((c) => [c.id, c.name]));
  const by = {};
  for (const r of rows) {
    const c = (by[r.currency] ||= { currency: r.currency, income_minor: 0, expenses_minor: 0, planned_expenses_minor: 0, categories: {} });
    if (r.status === 'planned') { if (r.type === 'expense') c.planned_expenses_minor += r.total; continue; }
    if (r.type === 'income') c.income_minor += r.total;
    else {
      const signed = r.type === 'expense' ? r.total : -r.total; // refunds reduce spending
      c.expenses_minor += signed;
      const key = r.category_id ? names[r.category_id] || 'Uncategorised' : 'Uncategorised';
      c.categories[key] = (c.categories[key] || 0) + signed;
    }
  }
  const currencies = Object.values(by).map((c) => ({
    currency: c.currency, income_minor: c.income_minor, expenses_minor: c.expenses_minor, net_cashflow_minor: c.income_minor - c.expenses_minor,
    planned_expenses_minor: c.planned_expenses_minor,
    categories: Object.entries(c.categories).map(([name, total_minor]) => ({ name, total_minor })).sort((a, b) => b.total_minor - a.total_minor),
  }));
  const upcoming = db.prepare(`SELECT id, description, amount_minor, currency, frequency, next_date, is_subscription FROM recurring_expenses
    WHERE workspace_id = ? AND active = 1 ORDER BY next_date LIMIT 20`).all(req.ws.id);
  res.json({ month, currencies, upcoming_recurring: upcoming });
});

// ---------- recurring expenses / subscriptions ----------
router.get('/recurring', (req, res) => {
  res.json(db.prepare(`SELECT r.*, c.name AS category_name FROM recurring_expenses r LEFT JOIN transaction_categories c ON c.id = r.category_id
    WHERE r.workspace_id = ? AND r.active = 1 ORDER BY r.next_date`).all(req.ws.id));
});
router.post('/recurring', (req, res) => {
  const amount = parseMinor(req.body.amount_minor);
  const currency = String(req.body.currency || '').toUpperCase();
  const start = parseDate(req.body.start_date);
  const description = String(req.body.description || '').trim().slice(0, 200);
  if (!description) return res.status(400).json({ error: 'description is required' });
  if (amount === undefined) return res.status(400).json({ error: 'amount_minor must be a positive integer' });
  if (!CURRENCY_RE.test(currency)) return res.status(400).json({ error: 'currency must be a 3-letter code' });
  if (!start) return res.status(400).json({ error: 'start_date must be a valid YYYY-MM-DD date' });
  if (!['weekly', 'monthly', 'yearly'].includes(req.body.frequency)) return res.status(400).json({ error: 'frequency must be weekly, monthly or yearly' });
  if (req.body.categoryId && !catInWs(req.body.categoryId, req.ws.id)) return res.status(400).json({ error: 'invalid category' });
  if (req.body.projectId && !projectInWs(req.body.projectId, req.ws.id)) return res.status(400).json({ error: 'invalid project' });
  const id = nanoid();
  db.prepare(`INSERT INTO recurring_expenses (id, workspace_id, description, amount_minor, currency, category_id, project_id, frequency, anchor_date, next_date, is_subscription, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.ws.id, description, amount, currency, req.body.categoryId || null, req.body.projectId || null, req.body.frequency, start, start, req.body.is_subscription ? 1 : 0, nowIso());
  audit(req, 'recurring.create', 'recurring_expense', id);
  res.status(201).json(db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(id));
});
router.delete('/recurring/:id', (req, res) => {
  db.prepare('UPDATE recurring_expenses SET active = 0 WHERE id = ? AND workspace_id = ?').run(req.params.id, req.ws.id);
  res.status(204).end();
});
router.post('/recurring/run', (req, res) => res.json({ created: materializeRecurring(req.ws.id) }));

// ---------- project budget (under /api/projects) ----------
projectFinanceRouter.param('id', (req, res, next, id) => {
  if (!projectInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

projectFinanceRouter.get('/:id/finance', (req, res) => {
  const transactions = db.prepare(`${TX_SELECT} WHERE t.workspace_id = ? AND t.project_id = ? AND t.voided_at IS NULL ORDER BY t.date DESC, t.created_at DESC LIMIT 200`).all(req.ws.id, req.params.id);
  res.json({ budget: projectBudgetMetrics(req.params.id, req.ws.id), transactions });
});

// Approving or changing a budget is restricted to owners/admins.
projectFinanceRouter.put('/:id/budget', requirePermission('budget:approve'), (req, res) => {
  const currency = String(req.body.currency || '').toUpperCase();
  const approved = Number(req.body.approved_minor);
  const alert = req.body.alert_pct === undefined ? 80 : Number(req.body.alert_pct);
  if (!CURRENCY_RE.test(currency)) return res.status(400).json({ error: 'currency must be a 3-letter code' });
  if (!Number.isSafeInteger(approved) || approved < 0 || approved > 1e12) return res.status(400).json({ error: 'approved_minor must be a non-negative integer' });
  if (!Number.isInteger(alert) || alert < 1 || alert > 100) return res.status(400).json({ error: 'alert_pct must be 1-100' });
  const before = db.prepare('SELECT * FROM project_budgets WHERE project_id = ?').get(req.params.id);
  db.prepare(`INSERT INTO project_budgets (project_id, currency, approved_minor, alert_pct, approved_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id) DO UPDATE SET currency = excluded.currency, approved_minor = excluded.approved_minor, alert_pct = excluded.alert_pct,
      approved_by = excluded.approved_by, updated_at = excluded.updated_at`).run(req.params.id, currency, approved, alert, req.user.id, nowIso());
  audit(req, 'budget.set', 'project', req.params.id, { from: before?.approved_minor ?? null, to: approved, currency });
  res.json(projectBudgetMetrics(req.params.id, req.ws.id));
});

export default router;
