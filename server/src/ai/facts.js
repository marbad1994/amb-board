import { db } from '../db.js';
import { todayUtc } from '../validate.js';
import { projectBudgetMetrics, budgetAlerts } from '../finance/calc.js';
import { occurrences } from '../calendar/recurrence.js';

// Deterministic facts. Every number the AI is allowed to state comes from here, never from the model.

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

export function projectFacts(project, workspaceId) {
  const today = todayUtc();
  const tasks = db.prepare(`SELECT c.title, c.status, c.priority, c.due_date, c.owner, c.completed_at,
      (SELECT COUNT(*) FROM subtasks s WHERE s.card_id = c.id) AS subtasks_total,
      (SELECT COUNT(*) FROM subtasks s WHERE s.card_id = c.id AND s.done = 1) AS subtasks_done
    FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = ? ORDER BY c.position LIMIT 200`).all(project.id)
    .map((t) => ({ ...t, overdue: t.status !== 'done' && !!t.due_date && t.due_date < today }));
  const done = tasks.filter((t) => t.status === 'done').length;
  const area = project.life_area_id
    ? db.prepare('SELECT name FROM life_areas WHERE id = ? AND workspace_id = ?').get(project.life_area_id, workspaceId)?.name ?? null
    : null;

  // Schedule assessment is arithmetic, not model judgement.
  let schedule = { assessment: 'unknown', reason: 'No target date is set.' };
  if (project.target_date) {
    const daysLeft = daysBetween(today, project.target_date);
    const progress = tasks.length ? done / tasks.length : 0;
    if (project.status === 'done' || (tasks.length && done === tasks.length)) schedule = { assessment: 'complete', days_to_target: daysLeft };
    else if (daysLeft < 0) schedule = { assessment: 'overdue', days_to_target: daysLeft, reason: 'Target date has passed and the project is not complete.' };
    else if (project.start_date && project.start_date < project.target_date) {
      const total = daysBetween(project.start_date, project.target_date);
      const elapsed = Math.max(0, daysBetween(project.start_date, today));
      const expected = Math.min(1, elapsed / total);
      schedule = { assessment: progress + 0.15 < expected ? 'behind' : 'on_track', days_to_target: daysLeft, expected_progress_pct: Math.round(expected * 100) };
    } else schedule = { assessment: 'unknown', days_to_target: daysLeft, reason: 'No start date, so pace cannot be judged.' };
  }

  const budget = projectBudgetMetrics(project.id, workspaceId);
  return {
    today,
    project: { name: project.name, description: project.description, status: project.status, priority: project.priority,
      life_area: area, start_date: project.start_date, target_date: project.target_date },
    progress: { tasks_total: tasks.length, tasks_done: done, percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
      overdue: tasks.filter((t) => t.overdue).length, blocked: tasks.filter((t) => t.status === 'blocked').length },
    schedule,
    // authoritative figures computed by the server; amounts are minor units (cents) in the stated currency
    budget: budget.has_budget ? { ...budget, note: 'amounts are in minor units (divide by 100)' } : null,
    tasks,
    not_available: ['calendar commitments tied to this project are not included', ...(budget.has_budget ? [] : ['no budget has been set for this project'])],
  };
}

const addDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);

function appointments(workspaceId, from, to) {
  const out = [];
  for (const e of db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ?').all(workspaceId)) {
    for (const o of occurrences(e, from, to)) out.push({ title: e.title, kind: e.kind, when_local: o.start_local, timezone: e.timezone, all_day: !!e.all_day });
  }
  return out.sort((a, b) => a.when_local.localeCompare(b.when_local)).slice(0, 40);
}

export function dailyFacts(workspaceId, user) {
  const today = todayUtc();
  const horizon = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const base = `FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done'`;
  const pick = 'SELECT c.title, c.status, c.priority, c.due_date, c.owner, p.name AS project';
  return {
    today,
    user: user.name,
    due_today: db.prepare(`${pick} ${base} AND c.due_date = ? LIMIT 50`).all(workspaceId, today),
    overdue: db.prepare(`${pick} ${base} AND c.due_date < ? ORDER BY c.due_date LIMIT 50`).all(workspaceId, today),
    due_next_7_days: db.prepare(`${pick} ${base} AND c.due_date > ? AND c.due_date <= ? ORDER BY c.due_date LIMIT 50`).all(workspaceId, today, horizon),
    blocked: db.prepare(`${pick} ${base} AND c.status = 'blocked' LIMIT 50`).all(workspaceId),
    completed_last_7_days: db.prepare(`SELECT c.title, p.name AS project FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
      WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.completed_at >= ? LIMIT 50`).all(workspaceId, new Date(Date.now() - 7 * 86400_000).toISOString()),
    active_projects: db.prepare(`SELECT name, status, priority, target_date FROM projects WHERE workspace_id = ? AND archived_at IS NULL AND status <> 'done'
      ORDER BY (target_date IS NULL), target_date LIMIT 30`).all(workspaceId),
    appointments_today: appointments(workspaceId, today, today),
    appointments_next_7_days: appointments(workspaceId, addDay(today), horizon),
    budget_alerts: budgetAlerts(workspaceId).map((a) => ({ project: a.project_name, status: a.status, currency: a.currency, approved_minor: a.approved_minor,
      actual_minor: a.actual_minor, forecast_minor: a.forecast_minor })),
    not_available: ['habits (not built)', 'personal finance outside project budgets is not summarised here'],
  };
}
