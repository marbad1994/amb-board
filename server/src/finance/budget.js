import { db } from '../db.js';

// Monthly category budgets vs actual spending. Deterministic; amounts in minor units; one currency per row.
// A parent category's budget covers its sub-categories. Refunds reduce spending. Planned/voided/transfers never count.
export function monthBudget(workspaceId, month) {
  const budgets = db.prepare(`SELECT b.category_id, b.currency, b.amount_minor, c.name FROM monthly_budgets b
    JOIN transaction_categories c ON c.id = b.category_id WHERE b.workspace_id = ? AND b.month = ? ORDER BY c.name, b.currency`).all(workspaceId, month);
  const spend = db.prepare(`SELECT t.currency, t.category_id, SUM(CASE t.type WHEN 'expense' THEN t.amount_minor ELSE -t.amount_minor END) AS total
    FROM transactions t WHERE t.workspace_id = ? AND t.voided_at IS NULL AND t.status = 'posted' AND t.type IN ('expense','refund')
      AND substr(t.date, 1, 7) = ? GROUP BY t.currency, t.category_id`).all(workspaceId, month);
  const parents = Object.fromEntries(db.prepare('SELECT id, parent_id FROM transaction_categories WHERE workspace_id = ?').all(workspaceId).map((c) => [c.id, c.parent_id]));
  const names = Object.fromEntries(db.prepare('SELECT id, name FROM transaction_categories WHERE workspace_id = ?').all(workspaceId).map((c) => [c.id, c.name]));

  // budgets are per (currency, category). Which budgeted category (itself or its parent) a spending row belongs to;
  // null = unbudgeted, which includes spending in a currency that category has no budget for.
  const budgeted = new Set(budgets.map((b) => `${b.currency}|${b.category_id}`));
  const owner = (currency, catId) => (catId && budgeted.has(`${currency}|${catId}`) ? catId
    : (catId && parents[catId] && budgeted.has(`${currency}|${parents[catId]}`) ? parents[catId] : null));

  const rows = budgets.map((b) => {
    const actual = spend.filter((s) => s.currency === b.currency && owner(s.currency, s.category_id) === b.category_id).reduce((a, s) => a + s.total, 0);
    const pct = b.amount_minor ? Math.round((actual / b.amount_minor) * 1000) / 10 : null;
    return { category_id: b.category_id, category: b.name, currency: b.currency, budget_minor: b.amount_minor, actual_minor: actual,
      remaining_minor: b.amount_minor - actual, used_pct: pct, status: actual > b.amount_minor ? 'over' : pct !== null && pct >= 80 ? 'warning' : 'ok' };
  });
  const unbudgeted = {};
  for (const s of spend) {
    if (owner(s.currency, s.category_id)) continue;
    const key = s.currency;
    const e = (unbudgeted[key] ||= { currency: key, total_minor: 0, categories: {} });
    e.total_minor += s.total;
    const n = s.category_id ? names[s.category_id] || 'Uncategorised' : 'Uncategorised';
    e.categories[n] = (e.categories[n] || 0) + s.total;
  }
  const totals = {};
  for (const r of rows) {
    const t = (totals[r.currency] ||= { currency: r.currency, budget_minor: 0, actual_minor: 0 });
    t.budget_minor += r.budget_minor; t.actual_minor += r.actual_minor;
  }
  return { month, rows, totals: Object.values(totals), unbudgeted: Object.values(unbudgeted).map((u) => ({ currency: u.currency, total_minor: u.total_minor,
    categories: Object.entries(u.categories).map(([name, total_minor]) => ({ name, total_minor })).sort((a, b) => b.total_minor - a.total_minor) })) };
}
