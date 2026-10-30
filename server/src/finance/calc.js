import { db } from '../db.js';

// Deterministic project budget maths. Nothing here involves AI.
//   actual    = posted expenses - posted refunds          (budget currency only)
//   planned   = planned expenses - planned refunds        (committed, not yet spent)
//   remaining = approved - actual
//   forecast  = actual + planned ; overrun = max(0, forecast - approved)
// Transfers and income never count. Voided rows never count. Other currencies are reported
// separately and are NEVER added to the budget currency (no silent conversion).
export function projectBudgetMetrics(projectId, workspaceId) {
  const budget = db.prepare('SELECT * FROM project_budgets WHERE project_id = ?').get(projectId);
  const rows = db.prepare(`SELECT currency, status, type, SUM(amount_minor) AS total FROM transactions
    WHERE workspace_id = ? AND project_id = ? AND voided_at IS NULL AND type IN ('expense','refund')
    GROUP BY currency, status, type`).all(workspaceId, projectId);

  const per = {};
  for (const r of rows) {
    const c = (per[r.currency] ||= { actual: 0, planned: 0 });
    const signed = r.type === 'expense' ? r.total : -r.total;
    c[r.status === 'posted' ? 'actual' : 'planned'] += signed;
  }
  if (!budget) {
    return { has_budget: false, by_currency: Object.entries(per).map(([currency, v]) => ({ currency, actual_minor: v.actual, planned_minor: v.planned })) };
  }
  const own = per[budget.currency] || { actual: 0, planned: 0 };
  const forecast = own.actual + own.planned;
  const usedPct = budget.approved_minor ? Math.round((own.actual / budget.approved_minor) * 1000) / 10 : null;
  const status = own.actual > budget.approved_minor ? 'over'
    : forecast > budget.approved_minor ? 'forecast_over'
    : usedPct !== null && usedPct >= budget.alert_pct ? 'warning' : 'ok';
  return {
    has_budget: true,
    currency: budget.currency,
    approved_minor: budget.approved_minor,
    alert_pct: budget.alert_pct,
    actual_minor: own.actual,
    planned_minor: own.planned,
    remaining_minor: budget.approved_minor - own.actual,
    forecast_minor: forecast,
    forecast_overrun_minor: Math.max(0, forecast - budget.approved_minor),
    used_pct: usedPct,
    status,
    other_currencies: Object.entries(per).filter(([c]) => c !== budget.currency)
      .map(([currency, v]) => ({ currency, actual_minor: v.actual, planned_minor: v.planned })),
  };
}

// Projects (active) whose budget status needs attention, for dashboard alerts.
export function budgetAlerts(workspaceId) {
  const projects = db.prepare(`SELECT p.id, p.name FROM projects p JOIN project_budgets b ON b.project_id = p.id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL AND p.status <> 'done'`).all(workspaceId);
  return projects.map((p) => ({ project_id: p.id, project_name: p.name, ...projectBudgetMetrics(p.id, workspaceId) }))
    .filter((m) => m.status !== 'ok');
}
