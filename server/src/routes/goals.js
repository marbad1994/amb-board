import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { projectInWs, lifeAreaInWs, audit } from '../access.js';
import { parseDate } from '../validate.js';

const router = Router();
export const goalInWs = (id, ws) => db.prepare('SELECT * FROM goals WHERE id = ? AND workspace_id = ?').get(String(id), ws);

router.param('id', (req, res, next, id) => {
  if (!goalInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

// Progress is derived: milestones done / total if there are milestones; otherwise the mean progress of linked projects.
function present(goal) {
  const milestones = db.prepare('SELECT id, title, due_date, done, completed_at FROM goal_milestones WHERE goal_id = ? ORDER BY position').all(goal.id)
    .map((m) => ({ ...m, done: !!m.done }));
  const projects = db.prepare(`SELECT p.id, p.name, p.status,
      (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) AS total,
      (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id AND c.status = 'done') AS done
    FROM goal_projects gp JOIN projects p ON p.id = gp.project_id WHERE gp.goal_id = ? AND p.workspace_id = ?`).all(goal.id, goal.workspace_id)
    .map((p) => ({ id: p.id, name: p.name, status: p.status, progress: p.total ? Math.round((p.done / p.total) * 100) : 0 }));
  let progress = 0; let source = 'none';
  if (milestones.length) { progress = Math.round((milestones.filter((m) => m.done).length / milestones.length) * 100); source = 'milestones'; }
  else if (projects.length) { progress = Math.round(projects.reduce((a, p) => a + p.progress, 0) / projects.length); source = 'projects'; }
  const habits = db.prepare('SELECT COUNT(*) AS n FROM habits WHERE goal_id = ? AND archived_at IS NULL').get(goal.id).n;
  return { ...goal, milestones, projects, progress, progress_source: source, linked_habits: habits };
}

export { present as presentGoal };

router.get('/', (req, res) => {
  const filter = req.query.status && ['active', 'achieved', 'archived'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`SELECT * FROM goals WHERE workspace_id = ? ${filter ? 'AND status = ?' : "AND status <> 'archived'"} ORDER BY (target_date IS NULL), target_date, created_at`)
    .all(...(filter ? [req.ws.id, filter] : [req.ws.id]));
  res.json(rows.map(present));
});

function read(body, ws, cur = {}) {
  const v = { title: cur.title, description: cur.description ?? '', life_area_id: cur.life_area_id ?? null, target_date: cur.target_date ?? null, status: cur.status ?? 'active' };
  if (body.title !== undefined) v.title = String(body.title).trim().slice(0, 200);
  if (!v.title) return { error: 'title is required' };
  if (body.description !== undefined) v.description = String(body.description).slice(0, 5000);
  if (body.lifeAreaId !== undefined) {
    const a = body.lifeAreaId ? lifeAreaInWs(body.lifeAreaId, ws) : null;
    if (body.lifeAreaId && (!a || a.archived_at)) return { error: 'invalid life area' };
    v.life_area_id = a?.id ?? null;
  }
  if (body.target_date !== undefined) { v.target_date = parseDate(body.target_date); if (v.target_date === undefined) return { error: 'target_date must be a valid YYYY-MM-DD date' }; }
  if (body.status !== undefined) { if (!['active', 'achieved', 'archived'].includes(body.status)) return { error: 'invalid status' }; v.status = body.status; }
  return { v };
}

router.post('/', (req, res) => {
  const r = read(req.body, req.ws.id);
  if (r.error) return res.status(400).json({ error: r.error });
  const id = nanoid(); const ts = nowIso(); const v = r.v;
  db.prepare('INSERT INTO goals (id, workspace_id, title, description, life_area_id, target_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.ws.id, v.title, v.description, v.life_area_id, v.target_date, v.status, req.user.id, ts, ts);
  audit(req, 'goal.create', 'goal', id, { title: v.title });
  res.status(201).json(present(goalInWs(id, req.ws.id)));
});

router.get('/:id', (req, res) => res.json(present(goalInWs(req.params.id, req.ws.id))));

router.patch('/:id', (req, res) => {
  const cur = goalInWs(req.params.id, req.ws.id);
  const r = read(req.body, req.ws.id, cur);
  if (r.error) return res.status(400).json({ error: r.error });
  const v = r.v;
  db.prepare('UPDATE goals SET title = ?, description = ?, life_area_id = ?, target_date = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(v.title, v.description, v.life_area_id, v.target_date, v.status, nowIso(), cur.id);
  if (v.status !== cur.status) audit(req, `goal.${v.status}`, 'goal', cur.id);
  res.json(present(goalInWs(cur.id, req.ws.id)));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  audit(req, 'goal.delete', 'goal', req.params.id);
  res.status(204).end();
});

// milestones
router.post('/:id/milestones', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const due = parseDate(req.body.due_date);
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (due === undefined) return res.status(400).json({ error: 'due_date must be a valid YYYY-MM-DD date' });
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM goal_milestones WHERE goal_id = ?').get(req.params.id).p;
  db.prepare('INSERT INTO goal_milestones (id, goal_id, title, due_date, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(nanoid(), req.params.id, title, due, pos, nowIso());
  res.status(201).json(present(goalInWs(req.params.id, req.ws.id)));
});

router.patch('/:id/milestones/:mid', (req, res) => {
  const m = db.prepare('SELECT * FROM goal_milestones WHERE id = ? AND goal_id = ?').get(req.params.mid, req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const title = req.body.title !== undefined ? String(req.body.title).trim().slice(0, 200) : m.title;
  if (!title) return res.status(400).json({ error: 'title cannot be empty' });
  let due = m.due_date;
  if (req.body.due_date !== undefined) { due = parseDate(req.body.due_date); if (due === undefined) return res.status(400).json({ error: 'due_date must be a valid YYYY-MM-DD date' }); }
  const done = req.body.done !== undefined ? (req.body.done ? 1 : 0) : m.done;
  db.prepare('UPDATE goal_milestones SET title = ?, due_date = ?, done = ?, completed_at = ? WHERE id = ?').run(title, due, done, done ? (m.completed_at || nowIso()) : null, m.id);
  res.json(present(goalInWs(req.params.id, req.ws.id)));
});

router.delete('/:id/milestones/:mid', (req, res) => {
  db.prepare('DELETE FROM goal_milestones WHERE id = ? AND goal_id = ?').run(req.params.mid, req.params.id);
  res.json(present(goalInWs(req.params.id, req.ws.id)));
});

// project links (both directions are navigable: goal.projects and, for habits, goal_id)
router.put('/:id/projects/:projectId', (req, res) => {
  if (!projectInWs(req.params.projectId, req.ws.id)) return res.status(404).json({ error: 'project not found' });
  db.prepare('INSERT OR IGNORE INTO goal_projects (goal_id, project_id) VALUES (?, ?)').run(req.params.id, req.params.projectId);
  res.json(present(goalInWs(req.params.id, req.ws.id)));
});
router.delete('/:id/projects/:projectId', (req, res) => {
  db.prepare('DELETE FROM goal_projects WHERE goal_id = ? AND project_id = ?').run(req.params.id, req.params.projectId);
  res.json(present(goalInWs(req.params.id, req.ws.id)));
});

export const projectGoalsRouter = Router(); // GET /api/projects/:id/goals
projectGoalsRouter.get('/:id/goals', (req, res) => {
  if (!projectInWs(req.params.id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  res.json(db.prepare(`SELECT g.id, g.title, g.status FROM goal_projects gp JOIN goals g ON g.id = gp.goal_id WHERE gp.project_id = ? AND g.workspace_id = ?`).all(req.params.id, req.ws.id));
});

export default router;
