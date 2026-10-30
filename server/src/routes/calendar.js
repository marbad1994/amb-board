import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { projectInWs, cardInWs, audit } from '../access.js';
import { parseDate } from '../validate.js';
import { isValidTimeZone, occurrences } from '../calendar/recurrence.js';

const router = Router();
const KINDS = ['appointment', 'personal'];
const RECURRENCES = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const eventInWs = (id, ws) => db.prepare('SELECT * FROM calendar_events WHERE id = ? AND workspace_id = ?').get(String(id), ws);

router.param('id', (req, res, next, id) => {
  if (!eventInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

function readEvent(body, ws, cur = {}) {
  const v = {
    title: cur.title, description: cur.description ?? '', kind: cur.kind ?? 'appointment', all_day: cur.all_day ?? 0,
    start_local: cur.start_local, end_local: cur.end_local ?? null, timezone: cur.timezone, recurrence: cur.recurrence ?? 'none',
    recurrence_interval: cur.recurrence_interval ?? 1, recurrence_until: cur.recurrence_until ?? null,
    project_id: cur.project_id ?? null, card_id: cur.card_id ?? null,
  };
  if (body.title !== undefined) v.title = String(body.title).trim().slice(0, 200);
  if (!v.title) return { error: 'title is required' };
  if (body.description !== undefined) v.description = String(body.description).slice(0, 2000);
  if (body.kind !== undefined) v.kind = body.kind;
  if (!KINDS.includes(v.kind)) return { error: `kind must be one of ${KINDS.join(', ')}` };
  if (body.all_day !== undefined) v.all_day = body.all_day ? 1 : 0;
  if (body.timezone !== undefined) v.timezone = body.timezone;
  if (!isValidTimeZone(v.timezone)) return { error: 'timezone must be a valid IANA zone, e.g. Europe/Bucharest' };
  const shape = v.all_day ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
  for (const k of ['start_local', 'end_local']) {
    if (body[k] !== undefined) v[k] = body[k] || null;
    if (v[k] && (!shape.test(v[k]) || parseDate(v[k].slice(0, 10)) === undefined || !parseDate(v[k].slice(0, 10)))) {
      return { error: `${k} must be ${v.all_day ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm'}` };
    }
  }
  if (!v.start_local) return { error: 'start_local is required' };
  if (v.end_local && v.end_local < v.start_local) return { error: 'end cannot be before start' };
  if (body.recurrence !== undefined) v.recurrence = body.recurrence;
  if (!RECURRENCES.includes(v.recurrence)) return { error: `recurrence must be one of ${RECURRENCES.join(', ')}` };
  if (body.recurrence_interval !== undefined) v.recurrence_interval = Number(body.recurrence_interval);
  if (!Number.isInteger(v.recurrence_interval) || v.recurrence_interval < 1 || v.recurrence_interval > 52) return { error: 'recurrence_interval must be 1-52' };
  if (body.recurrence_until !== undefined) {
    v.recurrence_until = parseDate(body.recurrence_until);
    if (v.recurrence_until === undefined) return { error: 'recurrence_until must be a valid YYYY-MM-DD date' };
  }
  if (body.projectId !== undefined) {
    if (body.projectId && !projectInWs(body.projectId, ws)) return { error: 'invalid project' };
    v.project_id = body.projectId || null;
  }
  if (body.cardId !== undefined) {
    if (body.cardId && !cardInWs(body.cardId, ws)) return { error: 'invalid task' };
    v.card_id = body.cardId || null;
  }
  return { v };
}

// Merged calendar feed for [from, to] (max 93 days): events (recurrence expanded), task due dates, project deadlines.
router.get('/', (req, res) => {
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (!from || !to || to < from) return res.status(400).json({ error: 'from and to must be valid YYYY-MM-DD dates' });
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 93) return res.status(400).json({ error: 'range is limited to 93 days' });

  const items = [];
  const events = db.prepare('SELECT e.*, p.name AS project_name FROM calendar_events e LEFT JOIN projects p ON p.id = e.project_id WHERE e.workspace_id = ?').all(req.ws.id);
  for (const e of events) {
    // cheap pre-filter: a non-recurring event outside the window cannot match
    if (e.recurrence === 'none' && (e.start_local.slice(0, 10) > to || (e.end_local || e.start_local).slice(0, 10) < from)) continue;
    for (const o of occurrences(e, from, to)) {
      items.push({ id: `event:${e.id}:${o.date}`, source: 'event', kind: e.kind, recurring: e.recurrence !== 'none', event_id: e.id, title: e.title,
        date: o.date, start_local: o.start_local, end_local: o.end_local, all_day: !!e.all_day, timezone: e.timezone, start_utc: o.start_utc,
        project_id: e.project_id, project_name: e.project_name, card_id: e.card_id,
        description: e.description, series_start: e.start_local, series_end: e.end_local, recurrence: e.recurrence, recurrence_interval: e.recurrence_interval, recurrence_until: e.recurrence_until });
    }
  }
  for (const t of db.prepare(`SELECT c.id, c.title, c.due_date, c.status, p.id AS project_id, p.name AS project_name FROM cards c
      JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
      WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.due_date BETWEEN ? AND ?`).all(req.ws.id, from, to)) {
    items.push({ id: `task:${t.id}`, source: 'task', kind: 'task_due', title: t.title, date: t.due_date, all_day: true, done: t.status === 'done',
      project_id: t.project_id, project_name: t.project_name, card_id: t.id });
  }
  for (const p of db.prepare(`SELECT id, name, target_date, status FROM projects WHERE workspace_id = ? AND archived_at IS NULL AND target_date BETWEEN ? AND ?`).all(req.ws.id, from, to)) {
    items.push({ id: `deadline:${p.id}`, source: 'project', kind: 'project_deadline', title: `${p.name} deadline`, date: p.target_date, all_day: true,
      done: p.status === 'done', project_id: p.id, project_name: p.name });
  }
  items.sort((a, b) => (a.date + (a.start_local || '')).localeCompare(b.date + (b.start_local || '')));

  // Scheduling pressure: days with something due and 3+ timed commitments. Advice only; nothing is moved.
  const days = {};
  for (const i of items) {
    const d = (days[i.date] ||= { date: i.date, deadlines: 0, events: 0 });
    if (i.source === 'event') d.events += 1; else if (!i.done) d.deadlines += 1;
  }
  res.json({ from, to, items, pressure: Object.values(days).filter((d) => d.deadlines >= 1 && d.events >= 3) });
});

router.post('/events', (req, res) => {
  const r = readEvent(req.body, req.ws.id);
  if (r.error) return res.status(400).json({ error: r.error });
  const v = r.v;
  const id = nanoid();
  const ts = nowIso();
  db.prepare(`INSERT INTO calendar_events (id, workspace_id, title, description, kind, all_day, start_local, end_local, timezone, recurrence,
      recurrence_interval, recurrence_until, project_id, card_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.ws.id, v.title, v.description, v.kind, v.all_day, v.start_local, v.end_local, v.timezone, v.recurrence, v.recurrence_interval,
      v.recurrence_until, v.project_id, v.card_id, req.user.id, ts, ts);
  audit(req, 'event.create', 'calendar_event', id);
  res.status(201).json(eventInWs(id, req.ws.id));
});

router.patch('/events/:id', (req, res) => {
  const cur = eventInWs(req.params.id, req.ws.id);
  const r = readEvent(req.body, req.ws.id, cur);
  if (r.error) return res.status(400).json({ error: r.error });
  const v = r.v;
  db.prepare(`UPDATE calendar_events SET title = ?, description = ?, kind = ?, all_day = ?, start_local = ?, end_local = ?, timezone = ?, recurrence = ?,
      recurrence_interval = ?, recurrence_until = ?, project_id = ?, card_id = ?, updated_at = ? WHERE id = ?`)
    .run(v.title, v.description, v.kind, v.all_day, v.start_local, v.end_local, v.timezone, v.recurrence, v.recurrence_interval, v.recurrence_until,
      v.project_id, v.card_id, nowIso(), cur.id);
  audit(req, 'event.update', 'calendar_event', cur.id);
  res.json(eventInWs(cur.id, req.ws.id));
});

router.delete('/events/:id', (req, res) => {
  db.prepare('DELETE FROM calendar_events WHERE id = ? AND workspace_id = ?').run(req.params.id, req.ws.id);
  audit(req, 'event.delete', 'calendar_event', req.params.id);
  res.status(204).end();
});

export default router;
