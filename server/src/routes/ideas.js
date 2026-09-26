import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';

const router = Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM idea_notes ORDER BY created_at ASC').all());
});

router.post('/', (req, res) => {
  const { author, text, color, x, y, rotation } = req.body;
  const id = nanoid();
  const ts = nowIso();
  db.prepare(`INSERT INTO idea_notes (id, author, text, color, x, y, rotation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, author || '', (text || '').trim(), color || '#fde68a', x || 0, y || 0, rotation || 0, ts, ts);
  res.status(201).json(db.prepare('SELECT * FROM idea_notes WHERE id = ?').get(id));
});

router.patch('/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM idea_notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });
  const merged = { ...note, ...req.body };
  db.prepare(`UPDATE idea_notes SET text = ?, color = ?, x = ?, y = ?, rotation = ?, updated_at = ? WHERE id = ?`)
    .run(merged.text, merged.color, merged.x, merged.y, merged.rotation, nowIso(), req.params.id);
  res.json(db.prepare('SELECT * FROM idea_notes WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM idea_notes WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
