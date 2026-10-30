import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { ideaInWs, lifeAreaInWs, audit } from '../access.js';
import { tx } from '../db.js';

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

// Idea -> project. The idea is kept (history) and linked to the new project; a converted idea cannot be converted twice.
router.post('/:id/convert', (req, res) => {
  const idea = ideaInWs(req.params.id, req.ws.id);
  if (idea.converted_project_id) return res.status(409).json({ error: 'idea was already converted', projectId: idea.converted_project_id });
  const text = idea.text.trim();
  if (!text) return res.status(400).json({ error: 'cannot convert an empty idea' });
  let lifeAreaId = null;
  if (req.body.lifeAreaId) {
    const area = lifeAreaInWs(req.body.lifeAreaId, req.ws.id);
    if (!area || area.archived_at) return res.status(400).json({ error: 'invalid life area' });
    lifeAreaId = area.id;
  }
  const name = (String(req.body.name || '').trim() || text.split('\n')[0]).slice(0, 120);
  const projectId = nanoid();
  const ts = nowIso();
  tx(() => {
    db.prepare(`INSERT INTO projects (id, name, color, description, workspace_id, life_area_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?)`).run(projectId, name, idea.color, text.slice(0, 5000), req.ws.id, lifeAreaId, ts, ts);
    [['Backlog', 'todo'], ['In Progress', 'doing'], ['Done', 'done']].forEach(([c, st], i) => db.prepare('INSERT INTO columns (id, project_id, name, position, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(nanoid(), projectId, c, i, st, ts));
    db.prepare('UPDATE idea_notes SET converted_project_id = ?, updated_at = ? WHERE id = ?').run(projectId, ts, idea.id);
    audit(req, 'idea.convert', 'project', projectId, { ideaId: idea.id });
  });
  res.status(201).json({ projectId });
});

export default router;
