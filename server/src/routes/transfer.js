import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { audit, membershipRole, can, projectInWs } from '../access.js';
import { goalInWs } from './goals.js';

const router = Router();

// "Copy to another workspace". The original is never touched. The user needs write access in BOTH workspaces (checked
// from the database, not from anything the browser sends), and the target must be a workspace they belong to.
// Not copied, and reported back: attachments and uploaded files, budgets and transactions, links to other records.
router.post('/', (req, res) => {
  const { entity, id } = req.body;
  const targetId = String(req.body.target_workspace_id || '');
  if (!targetId || targetId === req.ws.id) return res.status(400).json({ error: 'choose a different workspace' });
  const targetRole = membershipRole(req.user.id, targetId);
  if (!targetRole) return res.status(404).json({ error: 'workspace not found' });
  if (!can(targetRole, 'content:write')) return res.status(403).json({ error: 'you can only read the target workspace, so you cannot copy into it' });
  const target = db.prepare('SELECT id, name FROM workspaces WHERE id = ? AND archived_at IS NULL').get(targetId);
  if (!target) return res.status(404).json({ error: 'workspace not found' });
  const ts = nowIso();
  const areaByName = (areaId) => {
    if (!areaId) return null;
    const name = db.prepare('SELECT name FROM life_areas WHERE id = ?').get(areaId)?.name;
    return name ? db.prepare('SELECT id FROM life_areas WHERE workspace_id = ? AND archived_at IS NULL AND lower(name) = lower(?)').get(targetId, name)?.id ?? null : null;
  };
  let out;
  try {
    out = tx(() => {
      if (entity === 'project') {
        const p = projectInWs(id, req.ws.id);
        if (!p) throw Object.assign(new Error('not found'), { status: 404 });
        const np = nanoid(); const skipped = { attachments: 0 };
        db.prepare(`INSERT INTO projects (id, name, color, description, workspace_id, life_area_id, status, priority, start_date, target_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(np, p.name, p.color, p.description, targetId, areaByName(p.life_area_id), p.status, p.priority, p.start_date, p.target_date, ts, ts);
        const counts = { columns: 0, tasks: 0, subtasks: 0, comments: 0 };
        for (const col of db.prepare('SELECT * FROM columns WHERE project_id = ? ORDER BY position').all(p.id)) {
          const nc = nanoid();
          db.prepare('INSERT INTO columns (id, project_id, name, position, status, card_limit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nc, np, col.name, col.position, col.status, col.card_limit, ts);
          counts.columns += 1;
          for (const c of db.prepare('SELECT * FROM cards WHERE column_id = ? ORDER BY position').all(col.id)) {
            const ncard = nanoid();
            db.prepare(`INSERT INTO cards (id, column_id, title, description, status, owner, creator, labels, position, created_at, updated_at, due_date, priority, completed_at, recurrence)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ncard, nc, c.title, c.description, c.status, c.owner, c.creator, c.labels, c.position, ts, ts, c.due_date, c.priority, c.completed_at, c.recurrence);
            counts.tasks += 1;
            for (const s of db.prepare('SELECT * FROM subtasks WHERE card_id = ? ORDER BY position').all(c.id)) {
              db.prepare('INSERT INTO subtasks (id, card_id, title, done, position, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nanoid(), ncard, s.title, s.done, s.position, ts, s.completed_at); counts.subtasks += 1;
            }
            for (const m of db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY created_at').all(c.id)) {
              db.prepare('INSERT INTO comments (id, card_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)').run(nanoid(), ncard, m.author, m.text, m.created_at); counts.comments += 1;
            }
            skipped.attachments += db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE card_id = ?').get(c.id).n;
          }
        }
        return { entity, id: np, name: p.name, link: `/projects/${np}`, copied: counts, skipped };
      }
      if (entity === 'goal') {
        const g = goalInWs(id, req.ws.id);
        if (!g) throw Object.assign(new Error('not found'), { status: 404 });
        const ng = nanoid();
        db.prepare("INSERT INTO goals (id, workspace_id, title, description, life_area_id, target_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(ng, targetId, g.title, g.description, areaByName(g.life_area_id), g.target_date, g.status, req.user.id, ts, ts);
        let n = 0;
        for (const m of db.prepare('SELECT * FROM goal_milestones WHERE goal_id = ? ORDER BY position').all(g.id)) {
          db.prepare('INSERT INTO goal_milestones (id, goal_id, title, due_date, done, completed_at, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(nanoid(), ng, m.title, m.due_date, m.done, m.completed_at, m.position, ts); n += 1;
        }
        return { entity, id: ng, name: g.title, link: '/goals', copied: { milestones: n }, skipped: { linked_projects: db.prepare('SELECT COUNT(*) AS n FROM goal_projects WHERE goal_id = ?').get(g.id)?.n ?? 0 } };
      }
      if (entity === 'note') {
        const n = db.prepare("SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND kind = 'note'").get(String(id), req.ws.id);
        if (!n || (n.privacy === 'private' && n.author_id !== req.user.id)) throw Object.assign(new Error('not found'), { status: 404 });   // journal entries are never copied
        const nn = nanoid();
        db.prepare("INSERT INTO notes (id, workspace_id, author_id, kind, title, body, privacy, created_at, updated_at) VALUES (?, ?, ?, 'note', ?, ?, ?, ?, ?)").run(nn, targetId, req.user.id, n.title, n.body, n.privacy, ts, ts);
        return { entity, id: nn, name: n.title || 'Note', link: '/notes', copied: { notes: 1 }, skipped: { links_to_project_or_goal: (n.project_id ? 1 : 0) + (n.goal_id ? 1 : 0) } };
      }
      if (entity === 'idea') {
        const i = db.prepare('SELECT * FROM idea_notes WHERE id = ? AND workspace_id = ?').get(String(id), req.ws.id);
        if (!i) throw Object.assign(new Error('not found'), { status: 404 });
        const ni = nanoid();
        db.prepare('INSERT INTO idea_notes (id, author, text, color, x, y, rotation, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ni, i.author, i.text, i.color, i.x, i.y, i.rotation, ts, ts, targetId);
        return { entity, id: ni, name: i.text.slice(0, 40), link: '/ideas', copied: { ideas: 1 }, skipped: {} };
      }
      throw Object.assign(new Error('entity must be project, goal, note or idea'), { status: 400 });
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  audit(req, 'workspace.copy_out', out.entity, id, { to: target.id, to_name: target.name });
  db.prepare('INSERT INTO audit_log (id, workspace_id, user_id, action, entity_type, entity_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(nanoid(), target.id, req.user.id, 'workspace.copy_in', out.entity, out.id, JSON.stringify({ from: req.ws.id }), ts);
  res.status(201).json({ ...out, target: { id: target.id, name: target.name } });
});

export default router;
