import { db } from '../db.js';
import { todayUtc } from '../validate.js';
import { addDays, addMonths } from '../finance/money.js';
import { occurrences } from '../calendar/recurrence.js';
import { projectFacts } from './facts.js';
import { projectBudgetMetrics } from '../finance/calc.js';
import { projectInWs, cardInWs } from '../access.js';

// Deterministic analysis. The assistant calls these as skills and narrates the result; it never does the arithmetic.
const cap = (rows, n = 25) => rows.slice(0, n);

export function crossReference(ws, args, userId) {
  const type = String(args.entity || '');
  const id = String(args.id || '');
  const noteVisible = "(n.author_id = ? OR (n.kind = 'note' AND n.privacy = 'workspace'))";
  if (type === 'project') {
    const p = projectInWs(id, ws);
    if (!p) return { error: 'project not found' };
    return {
      entity: { type: 'project', id: p.id, name: p.name, status: p.status },
      tasks: cap(db.prepare(`SELECT c.id, c.title, c.status, c.due_date FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = ? ORDER BY c.position LIMIT 30`).all(p.id)),
      budget: projectBudgetMetrics(p.id, ws),
      transactions: cap(db.prepare(`SELECT id, type, status, amount_minor, currency, date, description FROM transactions WHERE workspace_id = ? AND project_id = ? AND voided_at IS NULL ORDER BY date DESC LIMIT 15`).all(ws, p.id), 15),
      events: cap(db.prepare('SELECT id, title, start_local, timezone FROM calendar_events WHERE workspace_id = ? AND project_id = ? ORDER BY start_local LIMIT 15').all(ws, p.id), 15),
      goals: db.prepare('SELECT g.id, g.title FROM goal_projects gp JOIN goals g ON g.id = gp.goal_id WHERE gp.project_id = ? AND g.workspace_id = ?').all(p.id, ws),
      notes: cap(db.prepare(`SELECT n.id, n.title FROM notes n WHERE n.workspace_id = ? AND n.project_id = ? AND ${noteVisible} AND n.kind = 'note' LIMIT 10`).all(ws, p.id, userId), 10),
      documents: cap(db.prepare("SELECT id, name FROM documents d WHERE d.workspace_id = ? AND d.project_id = ? AND (d.privacy = 'workspace' OR d.uploaded_by = ?) LIMIT 10").all(ws, p.id, userId), 10),
    };
  }
  if (type === 'goal') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ? AND workspace_id = ?').get(id, ws);
    if (!g) return { error: 'goal not found' };
    return {
      entity: { type: 'goal', id: g.id, title: g.title, status: g.status, target_date: g.target_date },
      milestones: db.prepare('SELECT id, title, due_date, done FROM goal_milestones WHERE goal_id = ? ORDER BY position').all(g.id).map((m) => ({ ...m, done: !!m.done })),
      projects: db.prepare('SELECT p.id, p.name, p.status FROM goal_projects gp JOIN projects p ON p.id = gp.project_id WHERE gp.goal_id = ? AND p.workspace_id = ?').all(g.id, ws),
      habits_linked_count: db.prepare('SELECT COUNT(*) AS n FROM habits WHERE goal_id = ? AND user_id = ? AND archived_at IS NULL').get(g.id, userId).n,
      notes: cap(db.prepare(`SELECT n.id, n.title FROM notes n WHERE n.workspace_id = ? AND n.goal_id = ? AND ${noteVisible} AND n.kind = 'note' LIMIT 10`).all(ws, g.id, userId), 10),
    };
  }
  if (type === 'task') {
    const c = cardInWs(id, ws);
    if (!c) return { error: 'task not found' };
    const project = db.prepare('SELECT p.id, p.name FROM projects p JOIN columns col ON col.project_id = p.id WHERE col.id = ?').get(c.column_id);
    return {
      entity: { type: 'task', id: c.id, title: c.title, status: c.status, due_date: c.due_date },
      project,
      subtasks: db.prepare('SELECT id, title, done FROM subtasks WHERE card_id = ? ORDER BY position').all(c.id).map((s) => ({ ...s, done: !!s.done })),
      events: db.prepare('SELECT id, title, start_local FROM calendar_events WHERE workspace_id = ? AND card_id = ?').all(ws, c.id),
      comments_count: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE card_id = ?').get(c.id).n,
    };
  }
  return { error: 'entity must be project, goal or task' };
}

// Spending this month vs the average of the previous N complete months, per currency and category.
export function analyzeSpending(ws, args = {}, today = todayUtc()) {
  const months = Math.min(Math.max(Number(args.months) || 3, 1), 12);
  const cur = `${today.slice(0, 7)}`;
  const first = `${cur}-01`;
  const from = addMonths(first, -months).slice(0, 7);
  const rows = db.prepare(`SELECT substr(t.date, 1, 7) AS month, t.currency, COALESCE(c.name, 'Uncategorised') AS category,
      SUM(CASE t.type WHEN 'expense' THEN t.amount_minor ELSE -t.amount_minor END) AS total
    FROM transactions t LEFT JOIN transaction_categories c ON c.id = t.category_id
    WHERE t.workspace_id = ? AND t.voided_at IS NULL AND t.status = 'posted' AND t.type IN ('expense','refund') AND substr(t.date, 1, 7) BETWEEN ? AND ?
    GROUP BY month, t.currency, category`).all(ws, from, cur);
  const out = {};
  for (const r of rows) {
    const cc = (out[r.currency] ||= {});
    const e = (cc[r.category] ||= { category: r.category, current_minor: 0, previous_total_minor: 0 });
    if (r.month === cur) e.current_minor += r.total; else e.previous_total_minor += r.total;
  }
  const result = Object.entries(out).map(([currency, cats]) => {
    const list = Object.values(cats).map((e) => {
      const avg = Math.round(e.previous_total_minor / months);
      const change = avg > 0 ? Math.round(((e.current_minor - avg) / avg) * 100) : null;
      return { category: e.category, current_minor: e.current_minor, prior_monthly_average_minor: avg, change_pct: change,
        unusual: avg > 0 && e.current_minor >= avg * 1.5 && e.current_minor - avg >= 2000 };
    }).sort((a, b) => b.current_minor - a.current_minor);
    return { currency, categories: cap(list, 15), unusual: list.filter((x) => x.unusual).map((x) => x.category) };
  });
  const uncategorised = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE workspace_id = ? AND voided_at IS NULL AND type IN ('expense','refund') AND category_id IS NULL AND date >= ?").get(ws, addDays(today, -30)).n;
  const top = db.prepare(`SELECT id, description, amount_minor, currency, date FROM transactions WHERE workspace_id = ? AND voided_at IS NULL AND status = 'posted' AND type = 'expense' AND substr(date, 1, 7) = ? ORDER BY amount_minor DESC LIMIT 5`).all(ws, cur);
  return { month: cur, compared_with_previous_months: months, currencies: result, top_expenses_this_month: top, uncategorised_expenses_last_30_days: uncategorised,
    note: 'Amounts are minor units. Currencies are never combined. "unusual" = at least 150% of the prior average and at least 20.00 higher.' };
}

// Tasks and appointments per day for the next N days: where the load is.
export function analyzeWorkload(ws, args = {}, today = todayUtc()) {
  const days = Math.min(Math.max(Number(args.days) || 14, 1), 31);
  const end = addDays(today, days - 1);
  const per = {};
  const slot = (d) => (per[d] ||= { date: d, tasks_due: 0, appointments: 0, deadlines: 0, milestones: 0 });
  for (const t of db.prepare(`SELECT c.due_date AS d FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done' AND c.due_date BETWEEN ? AND ?`).all(ws, today, end)) slot(t.d).tasks_due += 1;
  for (const p of db.prepare("SELECT target_date AS d FROM projects WHERE workspace_id = ? AND archived_at IS NULL AND status <> 'done' AND target_date BETWEEN ? AND ?").all(ws, today, end)) slot(p.d).deadlines += 1;
  for (const m of db.prepare("SELECT m.due_date AS d FROM goal_milestones m JOIN goals g ON g.id = m.goal_id WHERE g.workspace_id = ? AND g.status = 'active' AND m.done = 0 AND m.due_date BETWEEN ? AND ?").all(ws, today, end)) slot(m.d).milestones += 1;
  for (const e of db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ?').all(ws)) for (const o of occurrences(e, today, end)) slot(o.date).appointments += 1;
  const list = Array.from({ length: days }, (_, i) => { const d = addDays(today, i); const s = slot(d); return { ...s, load: s.tasks_due + s.appointments * 2 + s.deadlines * 3 + s.milestones }; });
  const overdue = db.prepare(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done' AND c.due_date < ?`).get(ws, today).n;
  const busiest = [...list].sort((a, b) => b.load - a.load).slice(0, 3).filter((d) => d.load > 0).map((d) => d.date);
  return { from: today, to: end, overdue_now: overdue, days: list, busiest_days: busiest, heavy_days: list.filter((d) => d.deadlines + d.tasks_due >= 1 && d.appointments >= 3).map((d) => d.date),
    note: 'load = tasks due + 2 x appointments + 3 x project deadlines + milestones (a rough indicator, not a time estimate)' };
}

export function projectHealth(ws, _args, today = todayUtc()) {
  const projects = db.prepare("SELECT * FROM projects WHERE workspace_id = ? AND archived_at IS NULL AND status <> 'done' ORDER BY created_at LIMIT 30").all(ws);
  return projects.map((p) => {
    const f = projectFacts(p, ws);
    const b = f.budget;
    const stale = p.updated_at && p.updated_at < `${addDays(today, -14)}T00:00:00.000Z`;
    const reasons = [];
    if (f.progress.overdue > 0) reasons.push(`${f.progress.overdue} overdue task(s)`);
    if (f.progress.blocked > 0) reasons.push(`${f.progress.blocked} blocked task(s)`);
    if (['overdue', 'behind'].includes(f.schedule.assessment)) reasons.push(`schedule: ${f.schedule.assessment}`);
    if (b && ['over', 'forecast_over'].includes(b.status)) reasons.push(`budget: ${b.status}`);
    if (f.progress.tasks_total === 0) reasons.push('no tasks yet');
    if (stale) reasons.push('no changes in 14+ days');
    const score = f.progress.overdue * 2 + f.progress.blocked + (['overdue'].includes(f.schedule.assessment) ? 4 : f.schedule.assessment === 'behind' ? 2 : 0)
      + (b?.status === 'over' ? 4 : b?.status === 'forecast_over' ? 2 : 0) + (f.progress.tasks_total === 0 ? 1 : 0) + (stale ? 1 : 0);
    return { id: p.id, name: p.name, progress_pct: f.progress.percent, schedule: f.schedule.assessment, days_to_target: f.schedule.days_to_target ?? null,
      budget_status: b?.status ?? null, risk: score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low', risk_score: score, reasons };
  }).sort((a, b) => b.risk_score - a.risk_score);
}

export function findGaps(ws, _args, today = todayUtc()) {
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  return {
    tasks_without_due_date: n(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
      WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done' AND c.due_date IS NULL`, ws),
    active_projects_without_tasks: n(`SELECT COUNT(*) AS n FROM projects p WHERE p.workspace_id = ? AND p.archived_at IS NULL AND p.status <> 'done'
      AND NOT EXISTS (SELECT 1 FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id)`, ws),
    projects_without_target_date: n("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL AND status <> 'done' AND target_date IS NULL", ws),
    projects_without_budget_but_with_spending: n(`SELECT COUNT(DISTINCT t.project_id) AS n FROM transactions t WHERE t.workspace_id = ? AND t.voided_at IS NULL AND t.project_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM project_budgets b WHERE b.project_id = t.project_id)`, ws),
    uncategorised_expenses_last_90_days: n("SELECT COUNT(*) AS n FROM transactions WHERE workspace_id = ? AND voided_at IS NULL AND type IN ('expense','refund') AND category_id IS NULL AND date >= ?", ws, addDays(today, -90)),
    active_goals_without_milestones: n(`SELECT COUNT(*) AS n FROM goals g WHERE g.workspace_id = ? AND g.status = 'active' AND NOT EXISTS (SELECT 1 FROM goal_milestones m WHERE m.goal_id = g.id)`, ws),
    current_month_without_category_budget: n('SELECT COUNT(*) AS n FROM monthly_budgets WHERE workspace_id = ? AND month = ?', ws, today.slice(0, 7)) === 0,
  };
}
