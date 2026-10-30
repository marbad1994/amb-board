import { Router } from 'express';
import { db } from '../db.js';
import { todayUtc } from '../validate.js';
import { addDays } from '../finance/money.js';
import { occurrences } from '../calendar/recurrence.js';
import { budgetAlerts } from '../finance/calc.js';
import { weekStart } from '../habits/streak.js';

const router = Router();

// Everything for "what matters today" from real records. The AI briefing is a separate, optional card.
router.get('/', (req, res) => {
  const ws = req.ws.id;
  const today = todayUtc();
  const base = `FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done'`;
  const pick = 'SELECT c.id, c.title, c.status, c.priority, c.due_date, p.id AS project_id, p.name AS project_name';

  const events = [];
  for (const e of db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ?').all(ws)) {
    for (const o of occurrences(e, today, today)) events.push({ id: `${e.id}:${o.date}`, event_id: e.id, title: e.title, kind: e.kind, start_local: o.start_local, all_day: !!e.all_day, timezone: e.timezone });
  }
  events.sort((a, b) => a.start_local.localeCompare(b.start_local));

  const week = weekStart(today);
  const habits = db.prepare('SELECT * FROM habits WHERE workspace_id = ? AND user_id = ? AND archived_at IS NULL ORDER BY created_at').all(ws, req.user.id).map((h) => {
    const doneToday = !!db.prepare('SELECT 1 FROM habit_entries WHERE habit_id = ? AND date = ?').get(h.id, today);
    const weekDone = db.prepare('SELECT COUNT(*) AS n FROM habit_entries WHERE habit_id = ? AND date BETWEEN ? AND ?').get(h.id, week, addDays(week, 6)).n;
    return { id: h.id, title: h.title, frequency: h.frequency, done_today: doneToday, week_done: weekDone, week_target: h.target_per_week,
      due: h.frequency === 'daily' || weekDone < h.target_per_week || doneToday };
  }).filter((h) => h.due);

  res.json({
    today,
    due_today: db.prepare(`${pick} ${base} AND c.due_date = ? ORDER BY c.priority DESC LIMIT 30`).all(ws, today),
    overdue: db.prepare(`${pick} ${base} AND c.due_date < ? ORDER BY c.due_date LIMIT 30`).all(ws, today),
    in_progress: db.prepare(`${pick} ${base} AND c.status = 'doing' ORDER BY c.updated_at DESC LIMIT 10`).all(ws),
    events,
    habits,
    milestones_soon: db.prepare(`SELECT m.id, m.title, m.due_date, g.id AS goal_id, g.title AS goal_title FROM goal_milestones m JOIN goals g ON g.id = m.goal_id
      WHERE g.workspace_id = ? AND g.status = 'active' AND m.done = 0 AND m.due_date IS NOT NULL AND m.due_date <= ? ORDER BY m.due_date LIMIT 10`).all(ws, addDays(today, 7)),
    important_projects: db.prepare(`SELECT id, name, priority, target_date FROM projects WHERE workspace_id = ? AND archived_at IS NULL AND status <> 'done'
      AND priority IN ('high','urgent') ORDER BY priority DESC, (target_date IS NULL), target_date LIMIT 5`).all(ws),
    budget_alerts: budgetAlerts(ws),
  });
});

export default router;
