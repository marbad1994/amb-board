import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { ideaInWs } from '../access.js';

const router = Router();

router.param('id', (req, res, next, id) => {
  if (!ideaInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM idea_notes WHERE workspace_id = ? ORDER BY created_at ASC').all(req.ws.id));
});

router.post('/', (req, res) => {
  const { text, color, x, y, rotation } = req.body;
  const id = nanoid();
  const ts = nowIso();
  db.prepare(`INSERT INTO idea_notes (id, workspace_id, author, text, color, x, y, rotation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.ws.id, req.user.name, String(text || '').trim(), color || '#fde68a', Number(x) || 0, Number(y) || 0, Number(rotation) || 0, ts, ts);
  res.status(201).json(db.prepare('SELECT * FROM idea_notes WHERE id = ?').get(id));
});

router.patch('/:id', (req, res) => {
  const note = ideaInWs(req.params.id, req.ws.id);
  const merged = { ...note, ...req.body };
  db.prepare('UPDATE idea_notes SET text = ?, color = ?, x = ?, y = ?, rotation = ?, updated_at = ? WHERE id = ?')
    .run(String(merged.text ?? ''), merged.color, Number(merged.x) || 0, Number(merged.y) || 0, Number(merged.rotation) || 0, nowIso(), req.params.id);
  res.json(db.prepare('SELECT * FROM idea_notes WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM idea_notes WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
