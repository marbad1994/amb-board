import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { lifeAreaInWs, requirePermission, audit } from '../access.js';

const router = Router();

// Reads are open to any member (applied by methodPermission); every write needs lifearea:manage.
router.use((req, res, next) => (req.method === 'GET' ? next() : requirePermission('lifearea:manage')(req, res, next)));

router.param('id', (req, res, next, id) => {
  if (!lifeAreaInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

function present(area) {
  return {
    ...area,
    subcategories: db.prepare('SELECT id, name, position FROM life_area_subcategories WHERE life_area_id = ? AND archived_at IS NULL ORDER BY position ASC').all(area.id),
    project_count: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE life_area_id = ? AND archived_at IS NULL').get(area.id).n,
  };
}

// ?archived=1 includes archived areas
router.get('/', (req, res) => {
  const filter = req.query.archived === '1' ? '' : 'AND archived_at IS NULL';
  const areas = db.prepare(`SELECT * FROM life_areas WHERE workspace_id = ? ${filter} ORDER BY position ASC`).all(req.ws.id);
  res.json(areas.map(present));
});

function cleanName(v) { return String(v ?? '').trim().slice(0, 80); }

router.post('/', (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = nanoid();
  const ts = nowIso();
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM life_areas WHERE workspace_id = ?').get(req.ws.id).p;
  db.prepare(`INSERT INTO life_areas (id, workspace_id, name, description, icon, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.ws.id, name, String(req.body.description || '').slice(0, 1000), String(req.body.icon || 'layers').slice(0, 40), pos, ts, ts);
  audit(req, 'lifearea.create', 'life_area', id, { name });
  res.status(201).json(present(lifeAreaInWs(id, req.ws.id)));
});

router.patch('/:id', (req, res) => {
  const area = lifeAreaInWs(req.params.id, req.ws.id);
  const name = req.body.name !== undefined ? cleanName(req.body.name) : area.name;
  if (!name) return res.status(400).json({ error: 'name cannot be empty' });
  let archivedAt = area.archived_at;
  if ('archived' in req.body) archivedAt = req.body.archived ? (archivedAt || nowIso()) : null;
  db.prepare('UPDATE life_areas SET name = ?, description = ?, icon = ?, archived_at = ?, updated_at = ? WHERE id = ?')
    .run(name,
      req.body.description !== undefined ? String(req.body.description).slice(0, 1000) : area.description,
      req.body.icon !== undefined ? String(req.body.icon).slice(0, 40) : area.icon,
      archivedAt, nowIso(), area.id);
  audit(req, 'archived' in req.body ? (req.body.archived ? 'lifearea.archive' : 'lifearea.restore') : 'lifearea.update', 'life_area', area.id);
  res.json(present(lifeAreaInWs(area.id, req.ws.id)));
});

// body: { order: [areaId, ...] }
router.post('/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  tx(() => {
    const stmt = db.prepare('UPDATE life_areas SET position = ? WHERE id = ? AND workspace_id = ?');
    order.forEach((id, i) => stmt.run(i, String(id), req.ws.id));
  });
  res.status(204).end();
});

// ---- subcategories ----
router.post('/:id/subcategories', (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = nanoid();
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM life_area_subcategories WHERE life_area_id = ?').get(req.params.id).p;
  db.prepare('INSERT INTO life_area_subcategories (id, life_area_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, name, pos, nowIso());
  res.status(201).json({ id, name, position: pos });
});

router.delete('/:id/subcategories/:subId', (req, res) => {
  db.prepare('UPDATE life_area_subcategories SET archived_at = ? WHERE id = ? AND life_area_id = ?')
    .run(nowIso(), req.params.subId, req.params.id);
  res.status(204).end();
});

export default router;
