import { db } from '../db.js';
import { addDays, addMonths } from '../finance/money.js';
import { weekStart, streakFor } from '../habits/streak.js';
import { occurrences } from '../calendar/recurrence.js';
import { monthBudget } from '../finance/budget.js';
import { todayUtc } from '../validate.js';

// Deterministic facts for weekly and monthly reviews. The model only writes prose around these numbers.
// Personal data (habits) is included only for the requesting user. Journal and notes are never included.

export function periodFor(period, date) {
  if (period === 'weekly') { const start = weekStart(date); return { start, end: addDays(start, 6) }; }
  const start = `${date.slice(0, 7)}-01`;
  return { start, end: addDays(addMonths(start, 1), -1) };
}

const tsStart = (d) => `${d}T00:00:00.000Z`;
const tsEnd = (d) => `${addDays(d, 1)}T00:00:00.000Z`;

function finance(ws, start, end) {
  const rows = db.prepare(`SELECT t.currency, t.type, t.category_id, SUM(t.amount_minor) AS total FROM transactions t
    WHERE t.workspace_id = ? AND t.voided_at IS NULL AND t.status = 'posted' AND t.type <> 'transfer' AND t.date BETWEEN ? AND ? GROUP BY t.currency, t.type, t.category_id`).all(ws, start, end);
  const names = Object.fromEntries(db.prepare('SELECT id, name FROM transaction_categories WHERE workspace_id = ?').all(ws).map((c) => [c.id, c.name]));
  const by = {};
  for (const r of rows) {
    const c = (by[r.currency] ||= { currency: r.currency, income_minor: 0, expenses_minor: 0, categories: {} });
    if (r.type === 'income') { c.income_minor += r.total; continue; }
    const signed = r.type === 'expense' ? r.total : -r.total;
    c.expenses_minor += signed;
    const n = r.category_id ? names[r.category_id] || 'Uncategorised' : 'Uncategorised';
    c.categories[n] = (c.categories[n] || 0) + signed;
  }
  return Object.values(by).map((c) => ({ currency: c.currency, income_minor: c.income_minor, expenses_minor: c.expenses_minor, net_minor: c.income_minor - c.expenses_minor,
    top_categories: Object.entries(c.categories).map(([name, total_minor]) => ({ name, total_minor })).sort((a, b) => b.total_minor - a.total_minor).slice(0, 5) }));
}

function habitsFor(ws, userId, start, end, today) {
  const upto = end < today ? end : today;
  const days = Math.max(0, Math.round((Date.parse(`${upto}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000) + 1);
  return db.prepare('SELECT * FROM habits WHERE workspace_id = ? AND user_id = ? AND archived_at IS NULL').all(ws, userId).map((h) => {
    const all = db.prepare('SELECT date FROM habit_entries WHERE habit_id = ?').all(h.id).map((r) => r.date);
    const done = all.filter((d) => d >= start && d <= end).length;
    return { title: h.title, frequency: h.frequency, completions: done,
      expected: h.frequency === 'daily' ? days : Math.round((h.target_per_week * days) / 7 * 10) / 10, current_streak: streakFor(h, all, today).current };
  });
}

export function reviewFacts(period, workspaceId, user, date = todayUtc(), today = todayUtc()) {
  const { start, end } = periodFor(period, date);
  const base = `FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id WHERE p.workspace_id = ? AND p.archived_at IS NULL`;
  const facts = {
    period: { kind: period, start, end, today, in_progress: today <= end },
    completed_tasks: db.prepare(`SELECT c.title, p.name AS project, c.completed_at ${base} AND c.completed_at >= ? AND c.completed_at < ? ORDER BY c.completed_at LIMIT 40`).all(workspaceId, tsStart(start), tsEnd(end)),
    incomplete_tasks_due_in_period: db.prepare(`SELECT c.title, p.name AS project, c.due_date, c.status ${base} AND c.status <> 'done' AND c.due_date BETWEEN ? AND ? ORDER BY c.due_date LIMIT 40`).all(workspaceId, start, end),
    overdue_now: db.prepare(`SELECT COUNT(*) AS n ${base} AND c.status <> 'done' AND c.due_date < ?`).get(workspaceId, today).n,
    active_projects: db.prepare(`SELECT p.name, p.status, p.priority, p.target_date,
        (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) AS tasks_total,
        (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id AND c.status = 'done') AS tasks_done
      FROM projects p WHERE p.workspace_id = ? AND p.archived_at IS NULL AND p.status <> 'done' ORDER BY p.created_at LIMIT 20`).all(workspaceId),
    finance_posted: finance(workspaceId, start, end),
    habits: habitsFor(workspaceId, user.id, start, end, today),
    appointments_in_period: (() => {
      let n = 0;
      for (const e of db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ?').all(workspaceId)) n += occurrences(e, start, end).length;
      return n;
    })(),
    upcoming_deadlines_next_7_days: [
      ...db.prepare(`SELECT c.title, p.name AS project, c.due_date ${base} AND c.status <> 'done' AND c.due_date BETWEEN ? AND ?`).all(workspaceId, addDays(end, 1), addDays(end, 7)).map((t) => ({ type: 'task', ...t })),
      ...db.prepare("SELECT name AS title, target_date AS due_date FROM projects WHERE workspace_id = ? AND archived_at IS NULL AND status <> 'done' AND target_date BETWEEN ? AND ?").all(workspaceId, addDays(end, 1), addDays(end, 7)).map((p) => ({ type: 'project', ...p })),
    ].slice(0, 20),
    not_available: ['journal and notes are never included', 'external calendars are not connected'],
  };
  if (period === 'monthly') {
    const prev = periodFor('monthly', addDays(start, -1));
    facts.projects_completed = db.prepare("SELECT name FROM projects WHERE workspace_id = ? AND status = 'done' AND archived_at IS NULL AND updated_at >= ? AND updated_at < ?").all(workspaceId, tsStart(start), tsEnd(end)).map((p) => p.name);
    facts.goals = db.prepare("SELECT id, title, target_date FROM goals WHERE workspace_id = ? AND status = 'active' LIMIT 20").all(workspaceId).map((g) => {
      const ms = db.prepare('SELECT done FROM goal_milestones WHERE goal_id = ?').all(g.id);
      return { title: g.title, target_date: g.target_date, milestones_done: ms.filter((m) => m.done).length, milestones_total: ms.length };
    });
    facts.budget_performance = monthBudget(workspaceId, start.slice(0, 7));
    facts.finance_previous_month = finance(workspaceId, prev.start, prev.end);
    facts.savings = db.prepare('SELECT id, name, currency, target_minor, is_emergency_fund FROM savings_goals WHERE workspace_id = ? AND archived_at IS NULL').all(workspaceId).map((g) => ({
      name: g.name, currency: g.currency, target_minor: g.target_minor, is_emergency_fund: !!g.is_emergency_fund,
      balance_minor: db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'deposit' THEN amount_minor ELSE -amount_minor END), 0) AS b FROM savings_entries WHERE goal_id = ?").get(g.id).b }));
    facts.debts = db.prepare('SELECT id, name, currency, original_minor FROM debts WHERE workspace_id = ? AND archived_at IS NULL').all(workspaceId).map((d) => ({ name: d.name, currency: d.currency,
      remaining_minor: Math.max(0, d.original_minor - db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM debt_payments WHERE debt_id = ?').get(d.id).n) }));
  }
  return facts;
}
