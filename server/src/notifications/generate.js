import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { occurrences } from '../calendar/recurrence.js';
import { budgetAlerts } from '../finance/calc.js';
import { addDays } from '../finance/money.js';

// Generates in-app notifications for one workspace. Safe to run any number of times and from several
// processes: every notification has a dedupe key and UNIQUE(user_id, dedupe_key), so a repeat is a no-op.
// `now` is injectable so behaviour is deterministic in tests.
const GRACE_MS = 10 * 60_000;       // an event reminder still fires up to 10 minutes after the event starts
const OVERDUE_LOOKBACK_DAYS = 7;    // do not flood users with ancient overdue tasks on the first run

export function generateForWorkspace(workspaceId, now = new Date()) {
  const members = db.prepare(`SELECT m.user_id, COALESCE(p.event_reminders, 1) AS ev, COALESCE(p.task_due, 1) AS td, COALESCE(p.budget_alerts, 1) AS ba
    FROM workspace_members m LEFT JOIN notification_preferences p ON p.user_id = m.user_id WHERE m.workspace_id = ?`).all(workspaceId);
  if (members.length === 0) return 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO notifications (id, workspace_id, user_id, kind, title, body, link, dedupe_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let created = 0;
  const notify = (pref, kind, title, body, link, key) => {
    for (const m of members) {
      if (!m[pref]) continue;
      created += Number(insert.run(nanoid(), workspaceId, m.user_id, kind, title, body, link, key, now.toISOString()).changes);
    }
  };
  const today = now.toISOString().slice(0, 10);

  // 1. event reminders
  for (const e of db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ? AND reminder_minutes IS NOT NULL AND all_day = 0').all(workspaceId)) {
    for (const o of occurrences(e, addDays(today, -1), addDays(today, 8))) {
      const start = Date.parse(o.start_utc);
      if (now.getTime() >= start - e.reminder_minutes * 60_000 && now.getTime() <= start + GRACE_MS) {
        const when = e.reminder_minutes === 0 ? 'now' : e.reminder_minutes >= 60 && e.reminder_minutes % 60 === 0 ? `in ${e.reminder_minutes / 60} h` : `in ${e.reminder_minutes} min`;
        notify('ev', 'event_reminder', `${e.title} starts ${when}`, `${o.start_local.replace('T', ' ')} (${e.timezone})`, '/calendar', `event:${e.id}:${o.date}:${e.reminder_minutes}`);
      }
    }
  }

  // 2. tasks due today / recently overdue (one notification per task and due date)
  const tasks = db.prepare(`SELECT c.id, c.title, c.due_date, p.name AS project FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done' AND c.due_date BETWEEN ? AND ?`).all(workspaceId, addDays(today, -OVERDUE_LOOKBACK_DAYS), today);
  for (const t of tasks) {
    const proj = db.prepare('SELECT p.id FROM projects p JOIN columns c ON c.project_id = p.id WHERE c.id = (SELECT column_id FROM cards WHERE id = ?)').get(t.id);
    const href = `/projects/${proj.id}?card=${t.id}`;
    if (t.due_date === today) notify('td', 'task_due', `Task due today: ${t.title}`, t.project, href, `task-due:${t.id}:${t.due_date}`);
    else notify('td', 'task_overdue', `Task overdue: ${t.title}`, `${t.project}, was due ${t.due_date}`, href, `task-overdue:${t.id}:${t.due_date}`);
  }

  // 3. budget attention, once per project per status (a change of status notifies again)
  for (const a of budgetAlerts(workspaceId)) {
    const text = { warning: 'is approaching its budget', forecast_over: 'is forecast to exceed its budget', over: 'is over budget' }[a.status];
    notify('ba', 'budget_alert', `${a.project_name} ${text}`, `${(a.actual_minor / 100).toFixed(2)} of ${(a.approved_minor / 100).toFixed(2)} ${a.currency} spent`, `/projects/${a.project_id}`, `budget:${a.project_id}:${a.status}`);
  }
  return created;
}

export function generateAll(now = new Date()) {
  let n = 0;
  for (const { id } of db.prepare('SELECT id FROM workspaces WHERE archived_at IS NULL').all()) {
    try { n += generateForWorkspace(id, now); } catch (err) { console.error('notification generation failed for workspace', id, err); }
  }
  return n;
}

// Background loop for the real server. unref() so it never keeps a process (or a test) alive.
export function startScheduler(intervalMs = 60_000) {
  const timer = setInterval(() => generateAll(), intervalMs);
  timer.unref();
  generateAll();
  return timer;
}
