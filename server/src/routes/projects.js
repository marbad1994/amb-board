import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { projectInWs, lifeAreaInWs, audit } from '../access.js';
import { PROJECT_STATUSES, PRIORITIES, parseDate, todayUtc } from '../validate.js';

const router = Router();

router.param('id', (req, res, next, id) => {
  if (!projectInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

// progress is derived: done cards / all cards (a project with no tasks has progress 0, not 100)
const SELECT = `
  SELECT p.*, la.name AS life_area_name,
    (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) AS card_count,
    (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id AND c.status = 'done') AS done_count,
    (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id AND c.status <> 'done' AND c.due_date < ?) AS overdue_count
  FROM projects p LEFT JOIN life_areas la ON la.id = p.life_area_id`;

function shape(row) {
  if (!row) return row;
  return { ...row, progress: row.card_count ? Math.round((row.done_count / row.card_count) * 100) : 0 };
}
const present = (id) => shape(db.prepare(`${SELECT} WHERE p.id = ?`).get(todayUtc(), id));

// Validates optional status/priority/dates in a body; returns { error } or { values }.
function readDetails(body, current = {}) {
  const out = {
    status: current.status ?? 'todo', priority: current.priority ?? 'medium',
    start_date: current.start_date ?? null, target_date: current.target_date ?? null,
  };
  if (body.status !== undefined) {
    if (!PROJECT_STATUSES.includes(body.status)) return { error: `status must be one of ${PROJECT_STATUSES.join(', ')}` };
    out.status = body.status;
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return { error: `priority must be one of ${PRIORITIES.join(', ')}` };
    out.priority = body.priority;
  }
  for (const k of ['start_date', 'target_date']) {
    if (body[k] !== undefined) {
      const d = parseDate(body[k]);
      if (d === undefined) return { error: `${k} must be a valid YYYY-MM-DD date` };
      out[k] = d;
    }
  }
  if (out.start_date && out.target_date && out.target_date < out.start_date) return { error: 'target_date cannot be before start_date' };
  return { values: out };
}

// ?archived=1 lists archived projects instead of active ones; ?lifeArea=<id> filters.
router.get('/', (req, res) => {
  const where = ['p.workspace_id = ?', req.query.archived === '1' ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL'];
  const params = [req.ws.id];
  if (req.query.lifeArea) { where.push('p.life_area_id = ?'); params.push(String(req.query.lifeArea)); }
  res.json(db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY p.created_at ASC`).all(todayUtc(), ...params).map(shape));
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
  const details = readDetails(req.body);
  if (details.error) return res.status(400).json({ error: details.error });
  const d = details.values;
  const id = nanoid();
  const ts = nowIso();
  tx(() => {
    db.prepare(`INSERT INTO projects (id, name, color, description, workspace_id, life_area_id, status, priority, start_date, target_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, String(name).trim().slice(0, 120), color || '#6366f1', String(description || '').slice(0, 5000), req.ws.id, lifeAreaId,
        d.status, d.priority, d.start_date, d.target_date, ts, ts);
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
  const details = readDetails(req.body, project);
  if (details.error) return res.status(400).json({ error: details.error });
  const d = details.values;
  db.prepare(`UPDATE projects SET name = ?, color = ?, description = ?, life_area_id = ?, archived_at = ?,
      status = ?, priority = ?, start_date = ?, target_date = ?, updated_at = ? WHERE id = ?`)
    .run(String(name ?? '').trim().slice(0, 120) || project.name, color || project.color,
      description !== undefined ? String(description).slice(0, 5000) : project.description,
      lifeAreaId, archivedAt, d.status, d.priority, d.start_date, d.target_date, nowIso(), req.params.id);
  if (d.status !== project.status) audit(req, 'project.status_change', 'project', req.params.id, { from: project.status, to: d.status });
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
