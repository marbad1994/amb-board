import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { projectInWs, cardInWs, lifeAreaInWs } from '../access.js';
import { parseDate, PRIORITIES } from '../validate.js';
import { readEvent } from '../routes/calendar.js';

// The ONLY change types the assistant may propose. Anything else (budgets, deletes, members, roles,
// permissions, external messages...) is dropped at proposal time and could not be executed anyway:
// there is no executor for it.
export const ACTION_TYPES = ['create_task', 'reschedule_task', 'create_event', 'create_project'];

const str = (v, n) => String(v ?? '').trim().slice(0, n);

// Validates a model-supplied proposal against the CURRENT workspace data.
// Returns { error } or { payload, target, description } where description is built here from validated values.
export function validateProposal(type, args, ws) {
  const a = args && typeof args === 'object' ? args : {};
  if (type === 'create_task') {
    const project = projectInWs(a.project_id, ws);
    if (!project || project.archived_at) return { error: 'unknown project' };
    const title = str(a.title, 200);
    if (!title) return { error: 'title required' };
    const due = a.due_date == null ? null : parseDate(a.due_date);
    if (due === undefined) return { error: 'invalid due_date' };
    const priority = a.priority == null ? 'medium' : a.priority;
    if (!PRIORITIES.includes(priority)) return { error: 'invalid priority' };
    return { payload: { project_id: project.id, title, due_date: due, priority }, target: { entity: 'project', id: project.id },
      description: `Create task "${title}" in project "${project.name}"${due ? `, due ${due}` : ''}, priority ${priority}` };
  }
  if (type === 'reschedule_task') {
    const card = cardInWs(a.task_id, ws);
    if (!card) return { error: 'unknown task' };
    const due = parseDate(a.due_date);
    if (!due) return { error: 'invalid due_date' };
    const project = db.prepare('SELECT p.name FROM projects p JOIN columns c ON c.project_id = p.id WHERE c.id = ?').get(card.column_id);
    return { payload: { task_id: card.id, due_date: due, from: card.due_date }, target: { entity: 'task', id: card.id },
      description: `Change due date of "${card.title}" (project "${project.name}") from ${card.due_date || 'no date'} to ${due}` };
  }
  if (type === 'create_event') {
    const r = readEvent({ title: a.title, start_local: a.start_local, end_local: a.end_local, timezone: a.timezone, all_day: a.all_day,
      kind: a.kind, projectId: a.project_id, description: a.description }, ws);
    if (r.error) return { error: r.error };
    const v = r.v;
    return { payload: v, target: { entity: 'calendar_event', id: null },
      description: `Add ${v.kind} "${v.title}" on ${v.start_local.replace('T', ' ')} (${v.timezone})` };
  }
  if (type === 'create_project') {
    const name = str(a.name, 120);
    if (!name) return { error: 'name required' };
    let lifeArea = null;
    if (a.life_area_id) {
      lifeArea = lifeAreaInWs(a.life_area_id, ws);
      if (!lifeArea || lifeArea.archived_at) return { error: 'unknown life area' };
    }
    const target = a.target_date == null ? null : parseDate(a.target_date);
    if (target === undefined) return { error: 'invalid target_date' };
    return { payload: { name, description: str(a.description, 5000), life_area_id: lifeArea?.id ?? null, target_date: target },
      target: { entity: 'project', id: null },
      description: `Create project "${name}"${lifeArea ? ` in ${lifeArea.name}` : ''}${target ? `, target ${target}` : ''}` };
  }
  return { error: 'action type not allowed' };
}

// Executes an already-approved proposal. Re-validates against current data first, so a stale proposal
// (task deleted, project archived, ...) fails safely instead of acting on something that changed.
export function executeProposal(proposal, actor) {
  const ws = proposal.workspace_id;
  const check = validateProposal(proposal.type, proposal.type === 'create_event' ? { ...JSON.parse(proposal.payload), project_id: JSON.parse(proposal.payload).project_id } : JSON.parse(proposal.payload), ws);
  if (check.error) throw new Error(`no longer valid: ${check.error}`);
  const p = check.payload;
  const ts = nowIso();
  return tx(() => {
    if (proposal.type === 'create_task') {
      const col = db.prepare('SELECT id FROM columns WHERE project_id = ? ORDER BY position LIMIT 1').get(p.project_id);
      if (!col) throw new Error('project has no columns');
      const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM cards WHERE column_id = ?').get(col.id).n;
      const id = nanoid();
      db.prepare(`INSERT INTO cards (id, column_id, title, description, status, owner, creator, labels, position, created_at, updated_at, due_date, priority)
        VALUES (?, ?, ?, '', 'todo', '', ?, '[]', ?, ?, ?, ?, ?)`).run(id, col.id, p.title, actor.name, pos, ts, ts, p.due_date, p.priority);
      return { entity: 'task', id, project_id: p.project_id };
    }
    if (proposal.type === 'reschedule_task') {
      db.prepare('UPDATE cards SET due_date = ?, updated_at = ? WHERE id = ?').run(p.due_date, ts, p.task_id);
      return { entity: 'task', id: p.task_id, from: p.from ?? null, to: p.due_date };
    }
    if (proposal.type === 'create_event') {
      const id = nanoid();
      db.prepare(`INSERT INTO calendar_events (id, workspace_id, title, description, kind, all_day, start_local, end_local, timezone, recurrence,
          recurrence_interval, recurrence_until, project_id, card_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 1, NULL, ?, NULL, ?, ?, ?)`)
        .run(id, ws, p.title, p.description, p.kind, p.all_day, p.start_local, p.end_local, p.timezone, p.project_id, actor.id, ts, ts);
      return { entity: 'calendar_event', id };
    }
    // create_project
    const id = nanoid();
    db.prepare(`INSERT INTO projects (id, name, color, description, workspace_id, life_area_id, status, target_date, created_at, updated_at)
      VALUES (?, ?, '#0ea5e9', ?, ?, ?, 'todo', ?, ?, ?)`).run(id, p.name, p.description, ws, p.life_area_id, p.target_date, ts, ts);
    ['Backlog', 'In Progress', 'Done'].forEach((c, i) => db.prepare('INSERT INTO columns (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').run(nanoid(), id, c, i, ts));
    return { entity: 'project', id };
  });
}
