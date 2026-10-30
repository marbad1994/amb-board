import { db } from '../db.js';
import { todayUtc } from '../validate.js';
import { budgetAlerts } from '../finance/calc.js';
import { occurrences } from '../calendar/recurrence.js';
import { presentGoal } from '../routes/goals.js';
import { presentHabit, presentChallenge } from '../routes/habits.js';
import { monthBudget } from '../finance/budget.js';

const OPEN = `FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
  WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done'`;
const PICK = 'SELECT c.id, c.title, c.due_date, c.priority, p.id AS project_id, p.name AS project_name';

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);

// This month's money in the currency with the most spending: spent, income, the budget (if there is one) and the biggest categories.
function moneyFor(ws, month) {
  const rows = db.prepare(`SELECT currency, type, SUM(amount_minor) AS total FROM transactions WHERE workspace_id = ? AND voided_at IS NULL AND status = 'posted'
    AND substr(date, 1, 7) = ? AND type IN ('expense','income','refund') GROUP BY currency, type`).all(ws, month);
  const budget = monthBudget(ws, month);
  const cur = {};
  for (const r of rows) { const c = (cur[r.currency] ||= { spent: 0, income: 0 }); if (r.type === 'income') c.income += r.total; else c.spent += r.type === 'expense' ? r.total : -r.total; }
  for (const t of Object.values(budget.totals || {})) (cur[t.currency] ||= { spent: 0, income: 0 });
  const currency = Object.keys(cur).sort((a, b) => cur[b].spent - cur[a].spent)[0];
  if (!currency) return null;
  const tot = Object.values(budget.totals || {}).find((t) => t.currency === currency);
  const top = db.prepare(`SELECT COALESCE(c.name, 'Uncategorised') AS name, SUM(CASE t.type WHEN 'expense' THEN t.amount_minor ELSE -t.amount_minor END) AS total_minor
    FROM transactions t LEFT JOIN transaction_categories c ON c.id = t.category_id WHERE t.workspace_id = ? AND t.voided_at IS NULL AND t.status = 'posted' AND t.currency = ?
    AND t.type IN ('expense','refund') AND substr(t.date, 1, 7) = ? GROUP BY name ORDER BY total_minor DESC LIMIT 3`).all(ws, currency, month);
  return { month, currency, spent_minor: cur[currency].spent, income_minor: cur[currency].income, budget_minor: tot?.budget_minor || null,
    used_pct: tot?.budget_minor ? Math.round((cur[currency].spent / tot.budget_minor) * 100) : null, top: top.filter((t) => t.total_minor > 0) };
}

// Everything the dashboard shows, for one person in one workspace. Real counts only; habits and challenges are the person's own.
export function dashboardData(ws, user) {
  const one = (sql, ...a) => db.prepare(sql).get(ws, ...a).n;
  const today = todayUtc();
  return {
    counts: {
      activeProjects: one('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL'),
      archivedProjects: one('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NOT NULL'),
      tasks: one(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
        WHERE p.workspace_id = ? AND p.archived_at IS NULL`),
      openTasks: one(`SELECT COUNT(*) AS n ${OPEN}`),
      overdueTasks: one(`SELECT COUNT(*) AS n ${OPEN} AND c.due_date < ?`, today),
      dueToday: one(`SELECT COUNT(*) AS n ${OPEN} AND c.due_date = ?`, today),
      ideas: one('SELECT COUNT(*) AS n FROM idea_notes WHERE workspace_id = ?'),
      lifeAreas: one('SELECT COUNT(*) AS n FROM life_areas WHERE workspace_id = ? AND archived_at IS NULL'),
    },
    overdueList: db.prepare(`${PICK} ${OPEN} AND c.due_date < ? ORDER BY c.due_date, c.priority LIMIT 10`).all(ws, today),
    dueTodayList: db.prepare(`${PICK} ${OPEN} AND c.due_date = ? ORDER BY c.priority LIMIT 10`).all(ws, today),
    budgetAlerts: budgetAlerts(ws),
    habits: user ? db.prepare('SELECT * FROM habits WHERE workspace_id = ? AND user_id = ? AND archived_at IS NULL ORDER BY created_at').all(ws, user.id).map((h) => { const x = presentHabit(h, today); return { ...x, streak: x.streak.current, longest_streak: x.streak.longest }; }) : [],
    challenges: user ? db.prepare('SELECT * FROM challenges WHERE workspace_id = ? AND user_id = ? AND start_date <= ? AND end_date >= ? ORDER BY end_date').all(ws, user.id, today, today)
      .map((c) => presentChallenge(c, today)).map((c) => ({ ...c, days_left: daysBetween(today, c.end_date) })) : [],
    goals: db.prepare("SELECT * FROM goals WHERE workspace_id = ? AND status = 'active' ORDER BY (target_date IS NULL), target_date, created_at LIMIT 8").all(ws).map((g) => {
      const p = presentGoal(g); const next = p.milestones.find((m) => !m.done);
      return { id: g.id, title: g.title, progress: p.progress, target_date: g.target_date, days_left: g.target_date ? daysBetween(today, g.target_date) : null, next_milestone: next?.title || null };
    }),
    ideas: { total: one('SELECT COUNT(*) AS n FROM idea_notes WHERE workspace_id = ?'), new_7d: db.prepare('SELECT COUNT(*) AS n FROM idea_notes WHERE workspace_id = ? AND created_at >= ?').get(ws, new Date(Date.now() - 7 * 86400_000).toISOString()).n,
      latest: db.prepare('SELECT id, text, color, created_at FROM idea_notes WHERE workspace_id = ? AND trim(text) <> \'\' ORDER BY created_at DESC LIMIT 6').all(ws) },
    money: moneyFor(ws, today.slice(0, 7)),
    upcomingEvents: (() => {
      const to = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
      const out = [];
      for (const e of db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ?').all(ws)) {
        for (const o of occurrences(e, today, to)) out.push({ id: `${e.id}:${o.date}`, title: e.title, start_local: o.start_local, all_day: !!e.all_day, timezone: e.timezone, kind: e.kind });
      }
      return out.sort((a, b) => a.start_local.localeCompare(b.start_local)).slice(0, 8);
    })(),
    lifeAreas: db.prepare(`SELECT la.id, la.name, la.icon,
        (SELECT COUNT(*) FROM projects p WHERE p.life_area_id = la.id AND p.archived_at IS NULL) AS project_count
      FROM life_areas la WHERE la.workspace_id = ? AND la.archived_at IS NULL ORDER BY la.position ASC`).all(ws),
    recentProjects: db.prepare(`SELECT p.id, p.name, p.color, la.name AS life_area_name,
        (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) AS card_count
      FROM projects p LEFT JOIN life_areas la ON la.id = p.life_area_id
      WHERE p.workspace_id = ? AND p.archived_at IS NULL ORDER BY p.created_at DESC LIMIT 6`).all(ws),
    activity: db.prepare(`SELECT a.action, a.entity_type, a.created_at, u.name AS user_name FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT 12`).all(ws),
  };
}
