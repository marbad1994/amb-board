import { Router } from 'express';
import { db } from '../db.js';
import { todayUtc, escapeLike } from '../validate.js';

const router = Router();

// Cross-project task list (cards). ?view=open|overdue|upcoming|done|mine (default open), ?project=<id>
// "mine" matches the free-text owner against the signed-in user's name.
// Dates compare in UTC until per-user timezones arrive (known limitation).
router.get('/', (req, res) => {
  const view = String(req.query.view || 'open');
  const today = todayUtc();
  const where = ['p.workspace_id = ?', 'p.archived_at IS NULL'];
  const params = [req.ws.id];
  if (req.query.project) { where.push('p.id = ?'); params.push(String(req.query.project)); }
  switch (view) {
    case 'open': where.push("c.status <> 'done'"); break;
    case 'overdue': where.push("c.status <> 'done'", 'c.due_date < ?'); params.push(today); break;
    case 'upcoming': where.push("c.status <> 'done'", 'c.due_date >= ?'); params.push(today); break;
    case 'done': where.push("c.status = 'done'"); break;
    case 'mine': where.push("c.status <> 'done'", 'LOWER(c.owner) = LOWER(?)'); params.push(req.user.name); break;
    default: return res.status(400).json({ error: 'unknown view' });
  }
  const rows = db.prepare(`
    SELECT c.id, c.title, c.status, c.priority, c.due_date, c.owner, c.completed_at, c.column_id,
      p.id AS project_id, p.name AS project_name, p.color AS project_color,
      (SELECT COUNT(*) FROM subtasks s WHERE s.card_id = c.id) AS subtask_count,
      (SELECT COUNT(*) FROM subtasks s WHERE s.card_id = c.id AND s.done = 1) AS subtask_done
    FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
    WHERE ${where.join(' AND ')}
    ORDER BY (c.due_date IS NULL), c.due_date ASC, c.created_at ASC LIMIT 500`).all(...params);
  res.json(rows.map((r) => ({ ...r, overdue: r.status !== 'done' && !!r.due_date && r.due_date < today })));
});

export const searchRouter = Router();

searchRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ projects: [], tasks: [], ideas: [] });
  const like = `%${escapeLike(q)}%`;
  const ws = req.ws.id;
  res.json({
    projects: db.prepare(`SELECT id, name, color FROM projects WHERE workspace_id = ? AND archived_at IS NULL
      AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') ORDER BY name LIMIT 8`).all(ws, like, like),
    tasks: db.prepare(`SELECT c.id, c.title, p.id AS project_id, p.name AS project_name FROM cards c
      JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
      WHERE p.workspace_id = ? AND p.archived_at IS NULL AND (c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')
      ORDER BY c.updated_at DESC LIMIT 8`).all(ws, like, like),
    ideas: db.prepare(`SELECT id, text FROM idea_notes WHERE workspace_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 8`).all(ws, like),
  });
});

export default router;
