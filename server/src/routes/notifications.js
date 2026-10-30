import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { generateForWorkspace } from '../notifications/generate.js';
import { mailConfigured, sendMail, renderDigest } from '../notifications/mailer.js';

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

const PREF_KEYS = ['event_reminders', 'task_due', 'budget_alerts', 'email'];
const prefs = (userId) => {
  const r = db.prepare('SELECT event_reminders, task_due, budget_alerts, email FROM notification_preferences WHERE user_id = ?').get(userId) || { event_reminders: 1, task_due: 1, budget_alerts: 1, email: 0 };
  return { ...Object.fromEntries(PREF_KEYS.map((k) => [k, !!r[k]])), email_available: mailConfigured() };
};
router.get('/preferences', (req, res) => res.json(prefs(req.user.id)));
router.put('/preferences', (req, res) => {
  const cur = prefs(req.user.id);
  for (const k of PREF_KEYS) if (typeof req.body[k] === 'boolean') cur[k] = req.body[k];
  if (cur.email && !mailConfigured()) return res.status(409).json({ error: 'Email delivery is not set up on this server yet. Ask the server administrator to add the SMTP settings.' });
  const was = db.prepare('SELECT email FROM notification_preferences WHERE user_id = ?').get(req.user.id)?.email;
  // only notifications created after email is switched on are sent, so turning it on never floods the inbox with old ones
  db.prepare(`INSERT INTO notification_preferences (user_id, event_reminders, task_due, budget_alerts, email, email_enabled_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET event_reminders = excluded.event_reminders, task_due = excluded.task_due, budget_alerts = excluded.budget_alerts, email = excluded.email,
      email_enabled_at = CASE WHEN excluded.email = 1 AND COALESCE(notification_preferences.email, 0) = 0 THEN excluded.email_enabled_at ELSE notification_preferences.email_enabled_at END`)
    .run(req.user.id, +cur.event_reminders, +cur.task_due, +cur.budget_alerts, +cur.email, cur.email && !was ? nowIso() : null);
  res.json(prefs(req.user.id));
});

// "Send a test email" to the signed-in user's own address, at most once a minute.
const lastTest = new Map();
router.post('/email-test', async (req, res) => {
  if (!mailConfigured()) return res.status(409).json({ error: 'Email delivery is not set up on this server yet.' });
  if (Date.now() - (lastTest.get(req.user.id) || 0) < 60_000) return res.status(429).json({ error: 'Please wait a minute before sending another test.' });
  lastTest.set(req.user.id, Date.now());
  try {
    await sendMail({ to: req.user.email, ...renderDigest(req.user.name, [{ title: 'Email notifications are working', body: 'This is a test from AMB Board.', link: '/settings' }]) });
    res.json({ ok: true, sent_to: req.user.email });
  } catch (err) {
    console.error('test email failed:', err.message);
    res.status(502).json({ error: 'The mail server did not accept the message. Check the SMTP settings on the server.' });
  }
});

export default router;
