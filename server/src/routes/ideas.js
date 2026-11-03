import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { ideaInWs, lifeAreaInWs, audit } from '../access.js';
import { tx } from '../db.js';

const router = Router();

const REACTIONS = ['like', 'dislike'];

function ideaWithReactions(id, userId) {
  return db.prepare(`
    SELECT n.*,
      SUM(CASE WHEN r.reaction = 'like' THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN r.reaction = 'dislike' THEN 1 ELSE 0 END) AS dislikes,
      MAX(CASE WHEN r.user_id = ? THEN r.reaction END) AS my_reaction
    FROM idea_notes n
    LEFT JOIN idea_reactions r ON r.idea_id = n.id
    WHERE n.id = ?
    GROUP BY n.id
  `).get(userId, id);
}

router.param('id', (req, res, next, id) => {
  if (!ideaInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

router.get('/', (req, res) => {
  res.json(db.prepare(`
    SELECT n.*,
      SUM(CASE WHEN r.reaction = 'like' THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN r.reaction = 'dislike' THEN 1 ELSE 0 END) AS dislikes,
      MAX(CASE WHEN r.user_id = ? THEN r.reaction END) AS my_reaction
    FROM idea_notes n
    LEFT JOIN idea_reactions r ON r.idea_id = n.id
    WHERE n.workspace_id = ?
    GROUP BY n.id
    ORDER BY n.created_at ASC
  `).all(req.user.id, req.ws.id));
});

router.post('/', (req, res) => {
  const { text, color, x, y, rotation } = req.body;
  const id = nanoid();
  const ts = nowIso();
  db.prepare(`INSERT INTO idea_notes (id, workspace_id, author, text, color, x, y, rotation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.ws.id, req.user.name, String(text || '').trim(), color || '#fde68a', Number(x) || 0, Number(y) || 0, Number(rotation) || 0, ts, ts);
  res.status(201).json(ideaWithReactions(id, req.user.id));
});

router.patch('/:id', (req, res) => {
  const note = ideaInWs(req.params.id, req.ws.id);
  const merged = { ...note, ...req.body };
  db.prepare('UPDATE idea_notes SET text = ?, color = ?, x = ?, y = ?, rotation = ?, updated_at = ? WHERE id = ?')
    .run(String(merged.text ?? ''), merged.color, Number(merged.x) || 0, Number(merged.y) || 0, Number(merged.rotation) || 0, nowIso(), req.params.id);
  res.json(ideaWithReactions(req.params.id, req.user.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM idea_notes WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Like / dislike. Sending the reaction you already have removes it; sending the
// other one switches it. Sending an empty/absent reaction clears your vote.
router.post('/:id/react', (req, res) => {
  const { reaction } = req.body || {};
  const ideaId = req.params.id;
  const userId = req.user.id;

  if (reaction === undefined || reaction === null || reaction === '') {
    db.prepare('DELETE FROM idea_reactions WHERE idea_id = ? AND user_id = ?').run(ideaId, userId);
  } else if (!REACTIONS.includes(reaction)) {
    return res.status(400).json({ error: 'reaction must be like or dislike' });
  } else {
    const existing = db.prepare('SELECT reaction FROM idea_reactions WHERE idea_id = ? AND user_id = ?').get(ideaId, userId);
    if (existing?.reaction === reaction) {
      db.prepare('DELETE FROM idea_reactions WHERE idea_id = ? AND user_id = ?').run(ideaId, userId);
    } else {
      db.prepare(`INSERT INTO idea_reactions (idea_id, user_id, reaction, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(idea_id, user_id) DO UPDATE SET reaction = excluded.reaction, created_at = excluded.created_at`)
        .run(ideaId, userId, reaction, nowIso());
    }
  }
  res.json(ideaWithReactions(ideaId, userId));
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
