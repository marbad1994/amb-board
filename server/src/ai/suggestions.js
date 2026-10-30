import { db, nowIso } from '../db.js';
import { todayUtc } from '../validate.js';
import { addDays } from '../finance/money.js';
import { budgetAlerts } from '../finance/calc.js';
import { analyzeWorkload, projectHealth, findGaps } from './analysis.js';
import { weekStart, streakFor } from '../habits/streak.js';

// Proactive next steps. Pure rules over the user's data: free (no AI call), explainable ("why"), and dismissible.
// action.type 'ask' hands the prompt to the assistant (which proposes changes for approval); 'link' navigates.
const MAX = 6;

export function computeSuggestions({ workspaceId, userId, role, context = null, today = todayUtc() }) {
  const out = [];
  const add = (key, priority, title, why, action) => out.push({ key, priority, title, why, action });
  const writable = ['owner', 'admin', 'member'].includes(role);
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  const projectCtx = context?.page === 'project' && context.id
    ? db.prepare('SELECT id, name FROM projects WHERE id = ? AND workspace_id = ?').get(String(context.id), workspaceId) : null;

  const projects = n("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL", workspaceId);
  if (projects === 0) add('first-project', 100, 'Create your first project', 'Projects hold your tasks, deadlines and budgets.', writable ? { type: 'ask', prompt: 'Help me set up my first project. Ask what I am working on, then propose a project with a few starter tasks.' } : { type: 'link', to: '/projects' });

  const overdue = n(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done' AND c.due_date < ?`, workspaceId, today);
  if (overdue > 0 && writable) add('overdue-tasks', 90, `${overdue} overdue task${overdue > 1 ? 's' : ''}`, 'Overdue work usually needs a new date or a decision to drop it.', { type: 'ask', prompt: 'Look at my overdue tasks and propose new due dates, taking my calendar and workload into account.' });

  const alerts = budgetAlerts(workspaceId);
  for (const a of alerts.slice(0, 2)) add(`budget:${a.project_id}:${a.status}`, 88, `${a.project_name}: ${a.status === 'over' ? 'over budget' : a.status === 'forecast_over' ? 'forecast to exceed budget' : 'close to its budget'}`, 'Spending plus planned costs is at or past the approved budget.', { type: 'ask', prompt: `Analyse the budget of project "${a.project_name}" (id ${a.project_id}): what drives the spending and what are my options? Do not change the budget.` });

  const health = projectHealth(workspaceId, {}, today).filter((h) => h.risk === 'high').slice(0, 2);
  for (const h of health) add(`risk:${h.id}`, 85, `${h.name} looks at risk`, h.reasons.join('; '), { type: 'ask', prompt: `Project "${h.name}" (id ${h.id}) is at risk: ${h.reasons.join('; ')}. Analyse it and propose concrete next steps.` });

  const w = analyzeWorkload(workspaceId, { days: 7 }, today);
  if (w.heavy_days.length) add(`heavy:${w.heavy_days[0]}`, 80, `Busy day coming up: ${w.heavy_days[0]}`, 'Something is due and there are three or more appointments that day.', { type: 'ask', prompt: `${w.heavy_days[0]} looks heavy (deadlines plus several appointments). What could move, and what should I do first?` });

  const dueToday = n(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done' AND c.due_date = ?`, workspaceId, today);
  if (dueToday > 0) add('due-today', 70, `${dueToday} task${dueToday > 1 ? 's' : ''} due today`, 'See today at a glance.', { type: 'link', to: '/my-day' });

  const gaps = findGaps(workspaceId, {}, today);
  if (gaps.active_projects_without_tasks > 0 && writable) {
    const p = db.prepare("SELECT p.id, p.name FROM projects p WHERE p.workspace_id = ? AND p.archived_at IS NULL AND p.status <> 'done' AND NOT EXISTS (SELECT 1 FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) ORDER BY p.created_at LIMIT 1").get(workspaceId);
    add(`plan:${p.id}`, 60, `"${p.name}" has no tasks yet`, 'A project without tasks cannot show progress.', { type: 'ask', prompt: `Create a plan for project "${p.name}" (id ${p.id}): propose the main tasks with sensible due dates.` });
  }
  if (gaps.uncategorised_expenses_last_90_days >= 3 && writable) add('categorise', 55, `${gaps.uncategorised_expenses_last_90_days} expenses have no category`, 'Categories make spending analysis and budgets accurate.', { type: 'ask', prompt: 'Find my recent uncategorised expenses and propose a category for each one.' });
  if (gaps.current_month_without_category_budget && n("SELECT COUNT(*) AS n FROM transactions WHERE workspace_id = ? AND voided_at IS NULL AND type = 'expense'", workspaceId) > 0) add('month-budget', 50, 'No category budget for this month', 'You have spending but no monthly limits to compare it with.', { type: 'link', to: '/finance?tab=budget' });
  if (gaps.active_goals_without_milestones > 0 && writable) {
    const g = db.prepare("SELECT g.id, g.title FROM goals g WHERE g.workspace_id = ? AND g.status = 'active' AND NOT EXISTS (SELECT 1 FROM goal_milestones m WHERE m.goal_id = g.id) LIMIT 1").get(workspaceId);
    add(`milestones:${g.id}`, 45, `Break down your goal "${g.title}"`, 'Milestones turn a goal into measurable progress.', { type: 'ask', prompt: `Suggest milestones with dates for my goal "${g.title}" (id ${g.id}).` });
  }
  if (gaps.tasks_without_due_date >= 5 && writable) add('undated', 40, `${gaps.tasks_without_due_date} open tasks have no due date`, 'Dated tasks show up on your calendar and in My Day.', { type: 'ask', prompt: 'Suggest due dates for my open tasks that have none, spreading them sensibly over the coming weeks.' });

  const habits = db.prepare("SELECT * FROM habits WHERE workspace_id = ? AND user_id = ? AND archived_at IS NULL AND frequency = 'daily'").all(workspaceId, userId);
  const pending = habits.filter((h) => !db.prepare('SELECT 1 FROM habit_entries WHERE habit_id = ? AND date = ?').get(h.id, today));
  if (pending.length) {
    const longest = pending.map((h) => ({ h, s: streakFor(h, db.prepare('SELECT date FROM habit_entries WHERE habit_id = ?').all(h.id).map((r) => r.date), today).current })).sort((a, b) => b.s - a.s)[0];
    add('habits-today', 35, `${pending.length} habit${pending.length > 1 ? 's' : ''} not done today`, longest.s > 0 ? `Your "${longest.h.title}" streak is ${longest.s} days.` : 'Small daily steps add up.', { type: 'link', to: '/my-day' });
  }
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  if (dow === 1 || dow === 0) add(`weekly:${weekStart(today)}`, 30, 'Review your week', 'A short review shows what got done and what to carry over.', { type: 'link', to: '/assistant?tab=weekly' });

  if (projectCtx) {
    const undated = n(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = ? AND c.status <> 'done' AND c.due_date IS NULL`, projectCtx.id);
    if (undated > 0 && writable) add(`ctx:undated:${projectCtx.id}`, 95, `${undated} task${undated > 1 ? 's' : ''} here have no due date`, `Viewing "${projectCtx.name}".`, { type: 'ask', prompt: `Suggest due dates for the undated tasks in this project (id ${projectCtx.id}).` });
    add(`ctx:report:${projectCtx.id}`, 20, 'Create a status report for this project', 'A standalone HTML report with charts you can share.', { type: 'ask', prompt: `Generate a project status report for this project (id ${projectCtx.id}) and give me a short summary.` });
  }
  if (context?.page === 'finance') add('ctx:finance-report', 25, 'Create a finance report for this month', 'A standalone HTML report with charts.', { type: 'ask', prompt: 'Generate a monthly finance report for the current month with your commentary.' });

  const dismissed = new Set(db.prepare('SELECT key FROM suggestion_dismissals WHERE user_id = ? AND workspace_id = ? AND until > ?').all(userId, workspaceId, nowIso()).map((r) => r.key));
  return out.filter((s) => !dismissed.has(s.key)).sort((a, b) => b.priority - a.priority).slice(0, MAX);
}

export function dismiss(userId, workspaceId, key, days) {
  const until = new Date(Date.now() + days * 86400_000).toISOString();
  db.prepare(`INSERT INTO suggestion_dismissals (user_id, workspace_id, key, until) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, workspace_id, key) DO UPDATE SET until = excluded.until`).run(userId, workspaceId, String(key).slice(0, 120), until);
}
