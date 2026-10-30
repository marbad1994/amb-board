import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { generateForWorkspace } from '../notifications/generate.js';

const router = Router(); // any workspace member (including viewers) manages their OWN notifications

const list = (req) => ({
  unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL').get(req.user.id, req.ws.id).n,
  items: db.prepare('SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id = ? AND workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(req.user.id, req.ws.id),
});

router.get('/', (req, res) => res.json(list(req)));

// Runs the (idempotent) generator now, so the bell is fresh even between scheduler ticks.
router.post('/refresh', (req, res) => { generateForWorkspace(req.ws.id); res.json(list(req)); });

router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL').run(nowIso(), req.user.id, req.ws.id);
  res.json(list(req));
});

router.post('/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ? AND workspace_id = ?').run(nowIso(), req.params.id, req.user.id, req.ws.id);
  res.json(list(req));
});

const PREF_KEYS = ['event_reminders', 'task_due', 'budget_alerts'];
const prefs = (userId) => {
  const r = db.prepare('SELECT event_reminders, task_due, budget_alerts FROM notification_preferences WHERE user_id = ?').get(userId) || { event_reminders: 1, task_due: 1, budget_alerts: 1 };
  return Object.fromEntries(PREF_KEYS.map((k) => [k, !!r[k]]));
};
router.get('/preferences', (req, res) => res.json(prefs(req.user.id)));
router.put('/preferences', (req, res) => {
  const cur = prefs(req.user.id);
  for (const k of PREF_KEYS) if (typeof req.body[k] === 'boolean') cur[k] = req.body[k];
  db.prepare(`INSERT INTO notification_preferences (user_id, event_reminders, task_due, budget_alerts) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET event_reminders = excluded.event_reminders, task_due = excluded.task_due, budget_alerts = excluded.budget_alerts`)
    .run(req.user.id, +cur.event_reminders, +cur.task_due, +cur.budget_alerts);
  res.json(cur);
});

export default router;
