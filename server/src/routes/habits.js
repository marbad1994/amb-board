import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { audit } from '../access.js';
import { parseDate, todayUtc } from '../validate.js';
import { addDays } from '../finance/money.js';
import { streakFor, weekStart } from '../habits/streak.js';
import { goalInWs } from './goals.js';

const router = Router();
// Habits and challenges belong to their creator; nobody else in the workspace can see or touch them.
const mine = (id, req) => db.prepare('SELECT * FROM habits WHERE id = ? AND workspace_id = ? AND user_id = ?').get(String(id), req.ws.id, req.user.id);

function present(h, today = todayUtc()) {
  const dates = db.prepare('SELECT date FROM habit_entries WHERE habit_id = ?').all(h.id).map((r) => r.date);
  const week = weekStart(today);
  return { id: h.id, title: h.title, description: h.description, frequency: h.frequency, target_per_week: h.target_per_week, goal_id: h.goal_id,
    archived: !!h.archived_at, done_today: dates.includes(today), done_this_week: dates.filter((d) => d >= week && d <= addDays(week, 6)).length,
    recent: dates.filter((d) => d >= addDays(today, -13)).sort(), streak: streakFor(h, dates, today) };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM habits WHERE workspace_id = ? AND user_id = ? AND archived_at IS NULL ORDER BY created_at').all(req.ws.id, req.user.id);
  res.json(rows.map((h) => present(h)));
});

router.post('/', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const frequency = req.body.frequency || 'daily';
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!['daily', 'weekly'].includes(frequency)) return res.status(400).json({ error: 'frequency must be daily or weekly' });
  const target = frequency === 'daily' ? 7 : Number(req.body.target_per_week ?? 3);
  if (!Number.isInteger(target) || target < 1 || target > 7) return res.status(400).json({ error: 'target_per_week must be 1-7' });
  let goalId = null;
  if (req.body.goalId) {
    const g = goalInWs(req.body.goalId, req.ws.id);
    if (!g) return res.status(400).json({ error: 'invalid goal' });
    goalId = g.id;
  }
  const id = nanoid();
  db.prepare('INSERT INTO habits (id, workspace_id, user_id, title, description, frequency, target_per_week, goal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.ws.id, req.user.id, title, String(req.body.description || '').slice(0, 1000), frequency, target, goalId, nowIso());
  res.status(201).json(present(mine(id, req)));
});

router.patch('/:id', (req, res) => {
  const h = mine(req.params.id, req);
  if (!h) return res.status(404).json({ error: 'not found' });
  const title = req.body.title !== undefined ? String(req.body.title).trim().slice(0, 120) : h.title;
  if (!title) return res.status(400).json({ error: 'title cannot be empty' });
  const archived = 'archived' in req.body ? (req.body.archived ? (h.archived_at || nowIso()) : null) : h.archived_at;
  db.prepare('UPDATE habits SET title = ?, archived_at = ? WHERE id = ?').run(title, archived, h.id);
  res.json(present(mine(h.id, req)));
});

// Idempotent toggle for one day. Future days (beyond tomorrow, to tolerate time zones) are rejected.
router.put('/:id/entries/:date', (req, res) => {
  const h = mine(req.params.id, req);
  if (!h) return res.status(404).json({ error: 'not found' });
  const date = parseDate(req.params.date);
  if (!date) return res.status(400).json({ error: 'date must be a valid YYYY-MM-DD date' });
  if (date > addDays(todayUtc(), 1)) return res.status(400).json({ error: 'cannot check in on a future date' });
  if (req.body.done === false) db.prepare('DELETE FROM habit_entries WHERE habit_id = ? AND date = ?').run(h.id, date);
  else db.prepare('INSERT OR IGNORE INTO habit_entries (habit_id, date, created_at) VALUES (?, ?, ?)').run(h.id, date, nowIso());
  res.json(present(mine(h.id, req)));
});

// ---- challenges: time-boxed, tied to one of your habits ----
function presentChallenge(c, today = todayUtc()) {
  const days = Math.round((Date.parse(`${c.end_date}T00:00:00Z`) - Date.parse(`${c.start_date}T00:00:00Z`)) / 86400_000) + 1;
  const done = db.prepare('SELECT COUNT(*) AS n FROM habit_entries WHERE habit_id = ? AND date BETWEEN ? AND ?').get(c.habit_id, c.start_date, c.end_date).n;
  const elapsed = Math.max(0, Math.min(days, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${c.start_date}T00:00:00Z`)) / 86400_000) + 1));
  return { id: c.id, title: c.title, habit_id: c.habit_id, start_date: c.start_date, end_date: c.end_date, total_days: days, completed_days: done,
    progress: Math.round((done / days) * 100), state: today < c.start_date ? 'upcoming' : today > c.end_date ? 'finished' : 'running', elapsed_days: elapsed };
}

router.get('/challenges/all', (req, res) => {
  res.json(db.prepare('SELECT * FROM challenges WHERE workspace_id = ? AND user_id = ? ORDER BY start_date DESC').all(req.ws.id, req.user.id).map((c) => presentChallenge(c)));
});

router.post('/challenges', (req, res) => {
  const h = mine(req.body.habitId, req);
  const start = parseDate(req.body.start_date); const end = parseDate(req.body.end_date);
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!h) return res.status(400).json({ error: 'choose one of your habits' });
  if (!start || !end || end < start) return res.status(400).json({ error: 'start_date and end_date must be valid dates, end not before start' });
  if ((Date.parse(end) - Date.parse(start)) / 86400_000 > 365) return res.status(400).json({ error: 'a challenge can last at most 366 days' });
  const id = nanoid();
  db.prepare('INSERT INTO challenges (id, workspace_id, user_id, title, habit_id, start_date, end_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, req.ws.id, req.user.id, title, h.id, start, end, nowIso());
  res.status(201).json(presentChallenge(db.prepare('SELECT * FROM challenges WHERE id = ?').get(id)));
});

router.delete('/challenges/:id', (req, res) => {
  db.prepare('DELETE FROM challenges WHERE id = ? AND workspace_id = ? AND user_id = ?').run(req.params.id, req.ws.id, req.user.id);
  res.status(204).end();
});

export default router;
