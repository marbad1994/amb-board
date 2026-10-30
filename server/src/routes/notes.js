import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { projectInWs, audit } from '../access.js';
import { parseDate, todayUtc, escapeLike } from '../validate.js';
import { goalInWs } from './goals.js';

const router = Router();

// Visibility rule used by EVERY read and write below: you can touch a row only if you wrote it,
// or it is a workspace-visible note (never a journal entry, never a private note).
const VISIBLE = "n.workspace_id = ? AND (n.author_id = ? OR (n.kind = 'note' AND n.privacy = 'workspace'))";
const visibleNote = (id, req) => db.prepare(`SELECT n.* FROM notes n WHERE n.id = ? AND ${VISIBLE}`).get(String(id), req.ws.id, req.user.id);

const SELECT = `SELECT n.*, u.name AS author_name, p.name AS project_name, g.title AS goal_title FROM notes n
  JOIN users u ON u.id = n.author_id LEFT JOIN projects p ON p.id = n.project_id LEFT JOIN goals g ON g.id = n.goal_id`;

const present = (n, req) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, entry_date: n.entry_date, privacy: n.privacy, project_id: n.project_id, project_name: n.project_name,
  goal_id: n.goal_id, goal_title: n.goal_title, author_name: n.author_name, mine: n.author_id === req.user.id, created_at: n.created_at, updated_at: n.updated_at });

// ?kind=note|journal  ?q=text  ?project=<id>  ?goal=<id>
router.get('/', (req, res) => {
  const where = [VISIBLE];
  const params = [req.ws.id, req.user.id];
  if (['note', 'journal'].includes(req.query.kind)) { where.push('n.kind = ?'); params.push(req.query.kind); }
  if (req.query.project) { where.push('n.project_id = ?'); params.push(String(req.query.project)); }
  if (req.query.goal) { where.push('n.goal_id = ?'); params.push(String(req.query.goal)); }
  if (req.query.q) { const l = `%${escapeLike(String(req.query.q).slice(0, 80))}%`; where.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')"); params.push(l, l); }
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(n.entry_date, substr(n.updated_at, 1, 10)) DESC, n.updated_at DESC LIMIT 200`).all(...params);
  res.json(rows.map((n) => present(n, req)));
});

function links(body, ws) {
  const out = {};
  if (body.projectId !== undefined) { if (body.projectId && !projectInWs(body.projectId, ws)) return { error: 'invalid project' }; out.project_id = body.projectId || null; }
  if (body.goalId !== undefined) { if (body.goalId && !goalInWs(body.goalId, ws)) return { error: 'invalid goal' }; out.goal_id = body.goalId || null; }
  return { out };
}

router.post('/', (req, res) => {
  const kind = req.body.kind === 'journal' ? 'journal' : 'note';
  const title = String(req.body.title ?? '').slice(0, 200);
  const body = String(req.body.body ?? '').slice(0, 50_000);
  if (kind === 'note' && !title.trim() && !body.trim()) return res.status(400).json({ error: 'a note needs a title or text' });
  const entryDate = kind === 'journal' ? (req.body.entry_date ? parseDate(req.body.entry_date) : todayUtc()) : null;
  if (kind === 'journal' && !entryDate) return res.status(400).json({ error: 'entry_date must be a valid YYYY-MM-DD date' });
  const l = links(req.body, req.ws.id);
  if (l.error) return res.status(400).json({ error: l.error });
  // journal entries are private no matter what the client sends
  const privacy = kind === 'journal' ? 'private' : (req.body.privacy === 'private' ? 'private' : 'workspace');
  const id = nanoid(); const ts = nowIso();
  db.prepare(`INSERT INTO notes (id, workspace_id, author_id, kind, title, body, entry_date, privacy, project_id, goal_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.ws.id, req.user.id, kind, title, body, entryDate, privacy, l.out.project_id ?? null, l.out.goal_id ?? null, ts, ts);
  res.status(201).json(present(db.prepare(`${SELECT} WHERE n.id = ?`).get(id), req));
});

// Only the author edits or deletes (even for workspace-visible notes).
function ownNote(req) {
  return db.prepare('SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND author_id = ?').get(String(req.params.id), req.ws.id, req.user.id);
}

router.get('/:id', (req, res) => {
  const n = visibleNote(req.params.id, req);
  if (!n) return res.status(404).json({ error: 'not found' });
  res.json(present(db.prepare(`${SELECT} WHERE n.id = ?`).get(n.id), req));
});

router.patch('/:id', (req, res) => {
  const n = ownNote(req);
  if (!n) return visibleNote(req.params.id, req) ? res.status(403).json({ error: 'only the author can edit this note' }) : res.status(404).json({ error: 'not found' });
  const l = links(req.body, req.ws.id);
  if (l.error) return res.status(400).json({ error: l.error });
  const title = req.body.title !== undefined ? String(req.body.title).slice(0, 200) : n.title;
  const body = req.body.body !== undefined ? String(req.body.body).slice(0, 50_000) : n.body;
  let privacy = n.privacy;
  if (n.kind === 'note' && req.body.privacy !== undefined) privacy = req.body.privacy === 'private' ? 'private' : 'workspace';
  db.prepare('UPDATE notes SET title = ?, body = ?, privacy = ?, project_id = ?, goal_id = ?, updated_at = ? WHERE id = ?')
    .run(title, body, privacy, l.out.project_id !== undefined ? l.out.project_id : n.project_id, l.out.goal_id !== undefined ? l.out.goal_id : n.goal_id, nowIso(), n.id);
  res.json(present(db.prepare(`${SELECT} WHERE n.id = ?`).get(n.id), req));
});

router.delete('/:id', (req, res) => {
  const n = ownNote(req);
  if (!n) return visibleNote(req.params.id, req) ? res.status(403).json({ error: 'only the author can delete this note' }) : res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
  audit(req, 'note.delete', 'note', n.id, { kind: n.kind });
  res.status(204).end();
});

export default router;
