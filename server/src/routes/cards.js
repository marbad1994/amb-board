import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, parseLabels } from '../db.js';
import { cardInWs, columnInWs } from '../access.js';
import { PRIORITIES, parseDate, todayUtc } from '../validate.js';
import { addDays, addMonths } from '../finance/money.js';

const router = Router();

router.param('id', (req, res, next, id) => {
  if (!cardInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});
router.param('columnId', (req, res, next, id) => {
  if (!columnInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

export function sanitizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  const seen = new Set();
  const clean = [];
  for (const label of labels) {
    const text = String(label || '').trim().slice(0, 24);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    clean.push(text);
    if (clean.length >= 6) break;
  }
  return clean;
}

const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'];

// When a recurring task is completed, create the next occurrence once (guarded by recurrence_spawned_at).
function spawnNextOccurrence(card, ts) {
  if (card.recurrence === 'none' || card.recurrence_spawned_at) return;
  const base = card.due_date || todayUtc();
  const next = card.recurrence === 'daily' ? addDays(base, 1) : card.recurrence === 'weekly' ? addDays(base, 7) : addMonths(base, 1);
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cards WHERE column_id = ?').get(card.column_id).p;
  db.prepare(`INSERT INTO cards (id, column_id, title, description, status, owner, creator, labels, position, created_at, updated_at, due_date, priority, recurrence)
    VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nanoid(), card.column_id, card.title, card.description, card.owner, card.creator, card.labels, pos, ts, ts, next, card.priority, card.recurrence);
  db.prepare('UPDATE cards SET recurrence_spawned_at = ? WHERE id = ?').run(ts, card.id);
}

function fullCard(id) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) return null;
  card.labels = parseLabels(card);
  card.comments = db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC').all(id);
  card.attachments = db.prepare('SELECT * FROM attachments WHERE card_id = ? ORDER BY uploaded_at ASC').all(id);
  card.subtasks = db.prepare('SELECT id, title, done, position FROM subtasks WHERE card_id = ? ORDER BY position ASC').all(id)
    .map((s) => ({ ...s, done: !!s.done }));
  return card;
}

router.get('/:id', (req, res) => {
  const card = fullCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'not found' });
  res.json(card);
});

router.post('/columns/:columnId/cards', (req, res) => {
  const { title, description, owner, status, labels } = req.body;
  const creator = req.user.name;
  const dueDate = parseDate(req.body.due_date);
  if (dueDate === undefined) return res.status(400).json({ error: 'due_date must be a valid YYYY-MM-DD date' });
  if (req.body.priority !== undefined && !PRIORITIES.includes(req.body.priority)) return res.status(400).json({ error: 'invalid priority' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM cards WHERE column_id = ?')
    .get(req.params.columnId).m;
  const id = nanoid();
  const ts = nowIso();
  db.prepare(`INSERT INTO cards (id, column_id, title, description, status, owner, creator, labels, position, created_at, updated_at, due_date, priority, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      req.params.columnId,
      title.trim(),
      description || '',
      status || 'todo',
      owner || '',
      creator,
      JSON.stringify(sanitizeLabels(labels)),
      maxPos + 1,
      ts,
      ts,
      dueDate,
      req.body.priority || 'medium',
      (status || 'todo') === 'done' ? ts : null
    );
  res.status(201).json(fullCard(id));
});

router.patch('/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'not found' });
  const fields = ['title', 'description', 'status', 'owner'];
  const updated = { ...card };
  for (const f of fields) {
    if (req.body[f] !== undefined) updated[f] = req.body[f];
  }
  const labels = req.body.labels !== undefined ? sanitizeLabels(req.body.labels) : parseLabels(card);
  if (!String(updated.title || '').trim()) return res.status(400).json({ error: 'title cannot be empty' });
  if (!['todo', 'doing', 'blocked', 'done'].includes(updated.status)) return res.status(400).json({ error: 'invalid status' });
  let dueDate = card.due_date;
  if (req.body.due_date !== undefined) {
    dueDate = parseDate(req.body.due_date);
    if (dueDate === undefined) return res.status(400).json({ error: 'due_date must be a valid YYYY-MM-DD date' });
  }
  let priority = card.priority;
  if (req.body.priority !== undefined) {
    if (!PRIORITIES.includes(req.body.priority)) return res.status(400).json({ error: 'invalid priority' });
    priority = req.body.priority;
  }
  // completion history: stamped when the card first becomes done, cleared if reopened
  let recurrence = card.recurrence;
  if (req.body.recurrence !== undefined) {
    if (!RECURRENCES.includes(req.body.recurrence)) return res.status(400).json({ error: 'invalid recurrence' });
    recurrence = req.body.recurrence;
  }
  const ts = nowIso();
  const completedAt = updated.status === 'done' ? (card.completed_at || ts) : null;
  db.prepare(`UPDATE cards SET title = ?, description = ?, status = ?, owner = ?, creator = ?, labels = ?, due_date = ?, priority = ?, completed_at = ?, recurrence = ?, updated_at = ? WHERE id = ?`)
    .run(updated.title, updated.description, updated.status, updated.owner, updated.creator, JSON.stringify(labels), dueDate, priority, completedAt, recurrence, ts, req.params.id);
  if (updated.status === 'done' && card.status !== 'done') spawnNextOccurrence({ ...card, recurrence, due_date: dueDate, title: updated.title, description: updated.description, owner: updated.owner, labels: JSON.stringify(labels), priority }, ts);
  res.json(fullCard(req.params.id));
});

// move a card to another column and/or position: body { columnId, position }
router.post('/:id/move', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'not found' });
  const { columnId, order } = req.body;
  if (columnId && !columnInWs(columnId, req.ws.id)) return res.status(404).json({ error: 'not found' });
  const targetColumn = columnId || card.column_id;

  db.prepare('UPDATE cards SET column_id = ? WHERE id = ?').run(targetColumn, req.params.id);

  if (Array.isArray(order)) {
    const stmt = db.prepare('UPDATE cards SET position = ? WHERE id = ? AND column_id = ?');
    order.forEach((cardId, i) => stmt.run(i, cardId, targetColumn));
  }
  res.json(fullCard(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// subtasks
router.post('/:id/subtasks', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'title is required' });
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM subtasks WHERE card_id = ?').get(req.params.id).p;
  db.prepare('INSERT INTO subtasks (id, card_id, title, done, position, created_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(nanoid(), req.params.id, title, pos, nowIso());
  res.status(201).json(fullCard(req.params.id));
});

router.patch('/:id/subtasks/:subId', (req, res) => {
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ? AND card_id = ?').get(req.params.subId, req.params.id);
  if (!sub) return res.status(404).json({ error: 'not found' });
  const title = req.body.title !== undefined ? String(req.body.title).trim().slice(0, 200) : sub.title;
  if (!title) return res.status(400).json({ error: 'title cannot be empty' });
  const done = req.body.done !== undefined ? (req.body.done ? 1 : 0) : sub.done;
  db.prepare('UPDATE subtasks SET title = ?, done = ?, completed_at = ? WHERE id = ?')
    .run(title, done, done ? (sub.completed_at || nowIso()) : null, sub.id);
  res.json(fullCard(req.params.id));
});

router.delete('/:id/subtasks/:subId', (req, res) => {
  db.prepare('DELETE FROM subtasks WHERE id = ? AND card_id = ?').run(req.params.subId, req.params.id);
  res.json(fullCard(req.params.id));
});

// comments
router.post('/:id/comments', (req, res) => {
  const { text } = req.body;
  const author = req.user.name;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  const id = nanoid();
  db.prepare('INSERT INTO comments (id, card_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, author || '', text.trim(), nowIso());
  res.status(201).json(fullCard(req.params.id));
});

router.delete('/:id/comments/:commentId', (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ? AND card_id = ?').run(req.params.commentId, req.params.id);
  res.json(fullCard(req.params.id));
});

export default router;
