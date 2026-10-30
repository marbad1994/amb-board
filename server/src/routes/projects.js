import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { projectInWs, lifeAreaInWs, audit } from '../access.js';

const router = Router();

router.param('id', (req, res, next, id) => {
  if (!projectInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

const SELECT = `
  SELECT p.*, la.name AS life_area_name,
    (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) AS card_count
  FROM projects p LEFT JOIN life_areas la ON la.id = p.life_area_id`;

const present = (id) => db.prepare(`${SELECT} WHERE p.id = ?`).get(id);

// ?archived=1 lists archived projects instead of active ones; ?lifeArea=<id> filters.
router.get('/', (req, res) => {
  const where = ['p.workspace_id = ?', req.query.archived === '1' ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL'];
  const params = [req.ws.id];
  if (req.query.lifeArea) { where.push('p.life_area_id = ?'); params.push(String(req.query.lifeArea)); }
  res.json(db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY p.created_at ASC`).all(...params));
});

// Returns the life area id (or null) if valid for the workspace; undefined if invalid.
function resolveLifeArea(value, wsId) {
  if (value === null || value === '' || value === undefined) return null;
  const area = lifeAreaInWs(value, wsId);
  return area && !area.archived_at ? area.id : undefined;
}

router.post('/', (req, res) => {
  const { name, color, description } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const lifeAreaId = resolveLifeArea(req.body.lifeAreaId, req.ws.id);
  if (lifeAreaId === undefined) return res.status(400).json({ error: 'invalid life area' });
  const id = nanoid();
  const ts = nowIso();
  tx(() => {
    db.prepare(`INSERT INTO projects (id, name, color, description, workspace_id, life_area_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, String(name).trim().slice(0, 120), color || '#6366f1', String(description || '').slice(0, 5000), req.ws.id, lifeAreaId, ts, ts);
    ['Backlog', 'In Progress', 'Done'].forEach((colName, i) => {
      db.prepare('INSERT INTO columns (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(nanoid(), id, colName, i, ts);
    });
    audit(req, 'project.create', 'project', id, { name: String(name).trim() });
  });
  res.status(201).json(present(id));
});

router.get('/:id', (req, res) => res.json(present(req.params.id)));

router.patch('/:id', (req, res) => {
  const project = projectInWs(req.params.id, req.ws.id);
  const { name, color, description } = req.body;
  let lifeAreaId = project.life_area_id;
  if ('lifeAreaId' in req.body) {
    lifeAreaId = resolveLifeArea(req.body.lifeAreaId, req.ws.id);
    if (lifeAreaId === undefined) return res.status(400).json({ error: 'invalid life area' });
  }
  let archivedAt = project.archived_at;
  if ('archived' in req.body) archivedAt = req.body.archived ? (archivedAt || nowIso()) : null;
  db.prepare(`UPDATE projects SET name = ?, color = ?, description = ?, life_area_id = ?, archived_at = ?, updated_at = ? WHERE id = ?`)
    .run(String(name ?? '').trim().slice(0, 120) || project.name, color || project.color,
      description !== undefined ? String(description).slice(0, 5000) : project.description,
      lifeAreaId, archivedAt, nowIso(), req.params.id);
  if ('archived' in req.body) audit(req, req.body.archived ? 'project.archive' : 'project.restore', 'project', req.params.id);
  res.json(present(req.params.id));
});

router.delete('/:id', (req, res) => {
  const project = projectInWs(req.params.id, req.ws.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  audit(req, 'project.delete', 'project', req.params.id, { name: project.name });
  res.status(204).end();
});

export default router;
