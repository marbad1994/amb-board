import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { projectInWs, cardInWs, lifeAreaInWs } from '../access.js';
import { parseDate, PRIORITIES } from '../validate.js';
import { readEvent } from '../routes/calendar.js';
import { readTransaction } from '../routes/finance.js';
import { sanitizeLabels, spawnNextOccurrence } from '../routes/cards.js';
import { goalInWs } from '../routes/goals.js';
import { todayUtc } from '../validate.js';

// The ONLY change types the assistant may propose. Anything else (budgets, deletes, members, roles,
// permissions, external messages...) is dropped at proposal time and could not be executed anyway:
// there is no executor for it.
export const ACTION_TYPES = ['create_task', 'update_task', 'reschedule_task', 'add_subtask', 'add_comment', 'create_event', 'create_project', 'create_transaction',
  'categorize_transaction', 'create_goal', 'add_milestone', 'create_note', 'create_habit'];

// What the model is told about each proposal type (kept next to the validators so they cannot drift apart).
export const PROPOSAL_DOCS = {
  create_task: '{"project_id":"","title":"","due_date":"YYYY-MM-DD","priority":"low|medium|high|urgent"}',
  update_task: '{"task_id":"","title":"","status":"todo|doing|blocked|done","priority":"","due_date":"YYYY-MM-DD or null","owner":"","labels":[]} (only include fields to change)',
  reschedule_task: '{"task_id":"","due_date":"YYYY-MM-DD"}',
  add_subtask: '{"task_id":"","title":""}',
  add_comment: '{"task_id":"","text":""}',
  create_event: '{"title":"","start_local":"YYYY-MM-DDTHH:mm","end_local":"","timezone":"IANA zone","all_day":false,"kind":"appointment|personal","project_id":"","reminder_minutes":30}',
  create_project: '{"name":"","description":"","life_area_id":"","target_date":"YYYY-MM-DD"}',
  create_transaction: '{"type":"expense|income|refund","amount":25.5,"currency":"EUR","date":"YYYY-MM-DD","description":"","category":"existing category name","project_id":"","status":"posted|planned"}',
  categorize_transaction: '{"transaction_id":"","category":"existing category name"}',
  create_goal: '{"title":"","target_date":"YYYY-MM-DD","life_area_id":""}',
  add_milestone: '{"goal_id":"","title":"","due_date":"YYYY-MM-DD"}',
  create_note: '{"title":"","body":""} (shared with the workspace; journal entries are never writable)',
  create_habit: '{"title":"","frequency":"daily|weekly","target_per_week":3}',
};
const catByName = (ws, name) => db.prepare('SELECT id, name FROM transaction_categories WHERE workspace_id = ? AND archived_at IS NULL AND lower(name) = lower(?)').get(ws, String(name ?? '').trim());
const catById = (ws, id) => db.prepare('SELECT id, name FROM transaction_categories WHERE workspace_id = ? AND archived_at IS NULL AND id = ?').get(ws, String(id ?? ''));
const resolveCategory = (ws, a) => (a.category_id ? catById(ws, a.category_id) : a.category ? catByName(ws, a.category) : null);
const projectNameOfCard = (card) => db.prepare('SELECT p.name FROM projects p JOIN columns c ON c.project_id = p.id WHERE c.id = ?').get(card.column_id)?.name ?? '';
const STATUS_LABEL = { todo: 'to do', doing: 'doing', blocked: 'blocked', done: 'done' };

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
      kind: a.kind, projectId: a.project_id, description: a.description, reminder_minutes: a.reminder_minutes }, ws);
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
  if (type === 'update_task') {
    const card = cardInWs(a.task_id, ws);
    if (!card) return { error: 'unknown task' };
    const payload = { task_id: card.id }; const parts = [];
    if (a.title !== undefined) { const t = str(a.title, 200); if (!t) return { error: 'title cannot be empty' }; payload.title = t; parts.push(`title: "${t}"`); }
    if (a.status !== undefined) { if (!STATUS_LABEL[a.status]) return { error: 'invalid status' }; payload.status = a.status; parts.push(`status: ${STATUS_LABEL[card.status]} -> ${STATUS_LABEL[a.status]}`); }
    if (a.priority !== undefined) { if (!PRIORITIES.includes(a.priority)) return { error: 'invalid priority' }; payload.priority = a.priority; parts.push(`priority: ${card.priority} -> ${a.priority}`); }
    if (a.due_date !== undefined) { const d = a.due_date === null ? null : parseDate(a.due_date); if (d === undefined) return { error: 'invalid due_date' }; payload.due_date = d; parts.push(`due date: ${card.due_date || 'none'} -> ${d || 'none'}`); }
    if (a.owner !== undefined) { payload.owner = str(a.owner, 80); parts.push(`owner: "${payload.owner || 'nobody'}"`); }
    if (a.labels !== undefined) { payload.labels = sanitizeLabels(a.labels); parts.push(`labels: [${payload.labels.join(', ')}]`); }
    if (parts.length === 0) return { error: 'nothing to change' };
    return { payload, target: { entity: 'task', id: card.id }, description: `Update "${card.title}" (project "${projectNameOfCard(card)}"): ${parts.join('; ')}` };
  }
  if (type === 'add_subtask' || type === 'add_comment') {
    const card = cardInWs(a.task_id, ws);
    if (!card) return { error: 'unknown task' };
    const text = type === 'add_subtask' ? str(a.title, 200) : str(a.text, 2000);
    if (!text) return { error: 'text required' };
    return { payload: type === 'add_subtask' ? { task_id: card.id, title: text } : { task_id: card.id, text }, target: { entity: 'task', id: card.id },
      description: type === 'add_subtask' ? `Add subtask "${text}" to "${card.title}"` : `Add comment to "${card.title}": "${text.slice(0, 120)}${text.length > 120 ? '...' : ''}"` };
  }
  if (type === 'create_transaction') {
    const minor = a.amount_minor !== undefined ? Number(a.amount_minor) : Math.round(Number(a.amount) * 100);
    if (a.amount !== undefined && Math.abs(Number(a.amount) * 100 - minor) > 1e-6) return { error: 'amount can have at most 2 decimals' };
    const cat = resolveCategory(ws, a);
    if ((a.category || a.category_id) && !cat) return { error: 'unknown category (use an existing category name)' };
    const body = { type: a.type, amount_minor: minor, currency: a.currency, date: a.date || todayUtc(), description: a.description, status: a.status || 'posted', categoryId: cat?.id ?? '', projectId: a.project_id || '' };
    if (body.type === 'transfer') return { error: 'transfers cannot be created by the assistant' };
    const r = readTransaction(body, ws);
    if (r.error) return { error: r.error };
    const v = r.v;
    const project = v.project_id ? db.prepare('SELECT name FROM projects WHERE id = ?').get(v.project_id)?.name : null;
    return { payload: { type: v.type, amount_minor: v.amount_minor, currency: v.currency, date: v.date, description: v.description, category_id: v.category_id, project_id: v.project_id, status: v.status },
      target: { entity: 'transaction', id: null },
      description: `Record ${v.status === 'planned' ? 'planned ' : ''}${v.type} of ${(v.amount_minor / 100).toFixed(2)} ${v.currency} on ${v.date}${v.description ? `: "${v.description}"` : ''}${cat ? ` (${cat.name})` : ''}${project ? `, project "${project}"` : ''}` };
  }
  if (type === 'categorize_transaction') {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ? AND workspace_id = ? AND voided_at IS NULL').get(String(a.transaction_id ?? ''), ws);
    const cat = resolveCategory(ws, a);
    if (!t) return { error: 'unknown transaction' };
    if (!cat) return { error: 'unknown category (use an existing category name)' };
    return { payload: { transaction_id: t.id, category_id: cat.id }, target: { entity: 'transaction', id: t.id },
      description: `Set category of "${t.description || t.type}" (${(t.amount_minor / 100).toFixed(2)} ${t.currency}, ${t.date}) to ${cat.name}` };
  }
  if (type === 'create_goal') {
    const title = str(a.title, 200);
    if (!title) return { error: 'title required' };
    const due = a.target_date == null ? null : parseDate(a.target_date);
    if (due === undefined) return { error: 'invalid target_date' };
    let area = null;
    if (a.life_area_id) { area = lifeAreaInWs(a.life_area_id, ws); if (!area || area.archived_at) return { error: 'unknown life area' }; }
    return { payload: { title, target_date: due, life_area_id: area?.id ?? null }, target: { entity: 'goal', id: null }, description: `Create goal "${title}"${due ? `, target ${due}` : ''}${area ? ` in ${area.name}` : ''}` };
  }
  if (type === 'add_milestone') {
    const g = goalInWs(a.goal_id, ws);
    if (!g) return { error: 'unknown goal' };
    const title = str(a.title, 200);
    const due = a.due_date == null ? null : parseDate(a.due_date);
    if (!title) return { error: 'title required' };
    if (due === undefined) return { error: 'invalid due_date' };
    return { payload: { goal_id: g.id, title, due_date: due }, target: { entity: 'goal', id: g.id }, description: `Add milestone "${title}"${due ? ` (due ${due})` : ''} to goal "${g.title}"` };
  }
  if (type === 'create_note') {
    const title = str(a.title, 200); const body = String(a.body ?? '').slice(0, 20000);
    if (!title && !body.trim()) return { error: 'a note needs a title or text' };
    return { payload: { title, body }, target: { entity: 'note', id: null }, description: `Create shared note "${title || body.slice(0, 40)}"` };
  }
  if (type === 'create_habit') {
    const title = str(a.title, 120);
    const freq = a.frequency || 'daily';
    const target = freq === 'daily' ? 7 : Number(a.target_per_week ?? 3);
    if (!title) return { error: 'title required' };
    if (!['daily', 'weekly'].includes(freq) || !Number.isInteger(target) || target < 1 || target > 7) return { error: 'invalid frequency' };
    return { payload: { title, frequency: freq, target_per_week: target }, target: { entity: 'habit', id: null }, description: `Create habit "${title}" (${freq === 'daily' ? 'every day' : `${target}x per week`}), private to you` };
  }
  return { error: 'action type not allowed' };
}

// Executes an already-approved proposal. Re-validates against current data first, so a stale proposal
// (task deleted, project archived, ...) fails safely instead of acting on something that changed.
export function executeProposal(proposal, actor) {
  const ws = proposal.workspace_id;
  const check = validateProposal(proposal.type, JSON.parse(proposal.payload), ws);
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
          recurrence_interval, recurrence_until, project_id, card_id, reminder_minutes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 1, NULL, ?, NULL, ?, ?, ?, ?)`)
        .run(id, ws, p.title, p.description, p.kind, p.all_day, p.start_local, p.end_local, p.timezone, p.project_id, p.reminder_minutes ?? null, actor.id, ts, ts);
      return { entity: 'calendar_event', id };
    }
    if (proposal.type === 'update_task') {
      const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(p.task_id);
      const next = { title: p.title ?? card.title, status: p.status ?? card.status, priority: p.priority ?? card.priority, due_date: 'due_date' in p ? p.due_date : card.due_date,
        owner: p.owner ?? card.owner, labels: p.labels ? JSON.stringify(p.labels) : card.labels };
      const completedAt = next.status === 'done' ? (card.completed_at || ts) : null;
      db.prepare('UPDATE cards SET title = ?, status = ?, priority = ?, due_date = ?, owner = ?, labels = ?, completed_at = ?, updated_at = ? WHERE id = ?')
        .run(next.title, next.status, next.priority, next.due_date, next.owner, next.labels, completedAt, ts, card.id);
      if (next.status === 'done' && card.status !== 'done') spawnNextOccurrence({ ...card, ...next }, ts);
      return { entity: 'task', id: card.id };
    }
    if (proposal.type === 'add_subtask') {
      const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM subtasks WHERE card_id = ?').get(p.task_id).n;
      const id = nanoid();
      db.prepare('INSERT INTO subtasks (id, card_id, title, done, position, created_at) VALUES (?, ?, ?, 0, ?, ?)').run(id, p.task_id, p.title, pos, ts);
      return { entity: 'task', id: p.task_id, subtask_id: id };
    }
    if (proposal.type === 'add_comment') {
      db.prepare('INSERT INTO comments (id, card_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)').run(nanoid(), p.task_id, actor.name, p.text, ts);
      return { entity: 'task', id: p.task_id };
    }
    if (proposal.type === 'create_transaction') {
      const id = nanoid();
      db.prepare(`INSERT INTO transactions (id, workspace_id, type, status, amount_minor, currency, date, description, category_id, project_id, source, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?)`).run(id, ws, p.type, p.status, p.amount_minor, p.currency, p.date, p.description, p.category_id, p.project_id, actor.id, ts, ts);
      return { entity: 'transaction', id };
    }
    if (proposal.type === 'categorize_transaction') {
      db.prepare('UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?').run(p.category_id, ts, p.transaction_id);
      return { entity: 'transaction', id: p.transaction_id };
    }
    if (proposal.type === 'create_goal') {
      const id = nanoid();
      db.prepare("INSERT INTO goals (id, workspace_id, title, description, life_area_id, target_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, 'active', ?, ?, ?)").run(id, ws, p.title, p.life_area_id, p.target_date, actor.id, ts, ts);
      return { entity: 'goal', id };
    }
    if (proposal.type === 'add_milestone') {
      const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM goal_milestones WHERE goal_id = ?').get(p.goal_id).n;
      const id = nanoid();
      db.prepare('INSERT INTO goal_milestones (id, goal_id, title, due_date, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, p.goal_id, p.title, p.due_date, pos, ts);
      return { entity: 'goal', id: p.goal_id, milestone_id: id };
    }
    if (proposal.type === 'create_note') {
      const id = nanoid();
      db.prepare("INSERT INTO notes (id, workspace_id, author_id, kind, title, body, privacy, created_at, updated_at) VALUES (?, ?, ?, 'note', ?, ?, 'workspace', ?, ?)").run(id, ws, actor.id, p.title, p.body, ts, ts);
      return { entity: 'note', id };
    }
    if (proposal.type === 'create_habit') {
      const id = nanoid();
      db.prepare('INSERT INTO habits (id, workspace_id, user_id, title, description, frequency, target_per_week, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, ws, actor.id, p.title, '', p.frequency, p.target_per_week, ts);
      return { entity: 'habit', id };
    }
    // create_project
    const id = nanoid();
    db.prepare(`INSERT INTO projects (id, name, color, description, workspace_id, life_area_id, status, target_date, created_at, updated_at)
      VALUES (?, ?, '#0ea5e9', ?, ?, ?, 'todo', ?, ?, ?)`).run(id, p.name, p.description, ws, p.life_area_id, p.target_date, ts, ts);
    ['Backlog', 'In Progress', 'Done'].forEach((c, i) => db.prepare('INSERT INTO columns (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').run(nanoid(), id, c, i, ts));
    return { entity: 'project', id };
  });
}
