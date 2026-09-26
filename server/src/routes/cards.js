import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';

const router = Router();

function fullCard(id) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) return null;
  card.comments = db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC').all(id);
  card.attachments = db.prepare('SELECT * FROM attachments WHERE card_id = ? ORDER BY uploaded_at ASC').all(id);
  return card;
}

router.get('/:id', (req, res) => {
  const card = fullCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'not found' });
  res.json(card);
});

router.post('/columns/:columnId/cards', (req, res) => {
  const { title, description, owner, creator, status } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM cards WHERE column_id = ?')
    .get(req.params.columnId).m;
  const id = nanoid();
  const ts = nowIso();
  db.prepare(`INSERT INTO cards (id, column_id, title, description, status, owner, creator, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.params.columnId, title.trim(), description || '', status || 'todo', owner || '', creator || '', maxPos + 1, ts, ts);
  res.status(201).json(fullCard(id));
});

router.patch('/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'not found' });
  const fields = ['title', 'description', 'status', 'owner', 'creator'];
  const updated = { ...card };
  for (const f of fields) {
    if (req.body[f] !== undefined) updated[f] = req.body[f];
  }
  db.prepare(`UPDATE cards SET title = ?, description = ?, status = ?, owner = ?, creator = ?, updated_at = ? WHERE id = ?`)
    .run(updated.title, updated.description, updated.status, updated.owner, updated.creator, nowIso(), req.params.id);
  res.json(fullCard(req.params.id));
});

// move a card to another column and/or position: body { columnId, position }
router.post('/:id/move', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'not found' });
  const { columnId, order } = req.body;
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

// comments
router.post('/:id/comments', (req, res) => {
  const { author, text } = req.body;
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
