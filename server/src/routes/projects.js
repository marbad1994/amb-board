import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const id = nanoid();
  const created_at = nowIso();
  db.prepare('INSERT INTO projects (id, name, color, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name.trim(), color || '#6366f1', created_at);

  const defaultColumns = ['Backlog', 'In Progress', 'Done'];
  defaultColumns.forEach((colName, i) => {
    db.prepare('INSERT INTO columns (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(nanoid(), id, colName, i, nowIso());
  });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.status(201).json(project);
});

router.get('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  res.json(project);
});

router.patch('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const { name, color } = req.body;
  db.prepare('UPDATE projects SET name = ?, color = ? WHERE id = ?')
    .run(name?.trim() || project.name, color || project.color, req.params.id);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
