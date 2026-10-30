import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, parseLabels } from '../db.js';
import { projectInWs, columnInWs } from '../access.js';

const router = Router();

router.param('projectId', (req, res, next, id) => {
  if (!projectInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});
// `/columns/:id` routes: :id is a column id
router.param('id', (req, res, next, id) => {
  if (!columnInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

// GET /api/projects/:projectId/columns  (with nested cards)
router.get('/:projectId/columns', (req, res) => {
  const columns = db.prepare('SELECT * FROM columns WHERE project_id = ? ORDER BY position ASC')
    .all(req.params.projectId);
  const cardsStmt = db.prepare(`
    SELECT cards.*,
      (SELECT COUNT(*) FROM comments WHERE comments.card_id = cards.id) AS commentCount,
      (SELECT COUNT(*) FROM attachments WHERE attachments.card_id = cards.id) AS attachmentCount,
      (SELECT COUNT(*) FROM subtasks WHERE subtasks.card_id = cards.id) AS subtaskCount,
      (SELECT COUNT(*) FROM subtasks WHERE subtasks.card_id = cards.id AND done = 1) AS subtaskDone
    FROM cards WHERE column_id = ? ORDER BY position ASC
  `);
  const result = columns.map((col) => ({
    ...col,
    cards: cardsStmt.all(col.id).map((card) => ({ ...card, labels: parseLabels(card) })),
  }));
  res.json(result);
});

router.post('/:projectId/columns', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM columns WHERE project_id = ?')
    .get(req.params.projectId).m;
  const id = nanoid();
  db.prepare('INSERT INTO columns (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.projectId, name.trim(), maxPos + 1, nowIso());
  res.status(201).json({ ...db.prepare('SELECT * FROM columns WHERE id = ?').get(id), cards: [] });
});

router.patch('/columns/:id', (req, res) => {
  const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
  if (!column) return res.status(404).json({ error: 'not found' });
  const { name } = req.body;
  db.prepare('UPDATE columns SET name = ? WHERE id = ?').run(name?.trim() || column.name, req.params.id);
  res.json(db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id));
});

router.delete('/columns/:id', (req, res) => {
  db.prepare('DELETE FROM columns WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// reorder columns within a project: body { order: [columnId, columnId, ...] }
router.post('/:projectId/columns/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  const stmt = db.prepare('UPDATE columns SET position = ? WHERE id = ? AND project_id = ?');
  order.forEach((colId, i) => stmt.run(i, colId, req.params.projectId));
  res.status(204).end();
});

export default router;
