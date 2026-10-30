import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { projectInWs, cardInWs, membershipRole, can } from '../access.js';
import { parseDate, PRIORITIES, PROJECT_STATUSES, todayUtc } from '../validate.js';
import { readEvent, eventInWs } from '../routes/calendar.js';
import { goalInWs } from '../routes/goals.js';
import { copyEntityInner, checkCopyTarget } from '../routes/transfer.js';
import { columnRoom, fullMessage } from '../boards.js';
import { COLUMN_STATUSES } from '../boards.js';
import { spawnNextOccurrence } from '../routes/cards.js';
import { nextRunAt } from '../automations/spec.js';
import { forget } from './mcpServers.js';
import { assertSafeUrl } from './mcpClient.js';
import { encryptSecret } from '../secrets.js';
import { CURRENCY_RE } from '../finance/money.js';

// Everything a person can do in the app that is not already a proposal type in actions.js. The same rules as the screens apply:
// the person's CURRENT role is checked, every id must belong to the workspace, and descriptions are generated here from checked values.
// Nothing here runs without approval (or the person's opt-in for the routine ones).

export const MORE_DOCS = {
  update_project: '{"project_id":"","name":"","description":"","status":"todo|in_progress|done","priority":"low|medium|high|urgent","start_date":"YYYY-MM-DD or null","target_date":"YYYY-MM-DD or null","life_area_id":"id or null"} (only fields to change)',
  archive_project: '{"project_id":"","archived":true}',
  delete_project: '{"project_id":""} deletes the project with all its tasks; cannot be undone, prefer archive_project unless the user asked to delete',
  delete_task: '{"task_id":""} cannot be undone',
  move_task: '{"task_id":"","column":"column name in the task\'s project"} (the task takes the column\'s status; refused if the column is full)',
  complete_subtask: '{"task_id":"","subtask":"subtask id or exact title","done":true}',
  update_event: '{"event_id":"","title":"","start_local":"YYYY-MM-DDTHH:mm","end_local":"","timezone":"","all_day":false,"reminder_minutes":30,"description":""} (only fields to change)',
  delete_event: '{"event_id":""} cannot be undone',
  update_goal: '{"goal_id":"","title":"","status":"active|achieved|archived","target_date":"YYYY-MM-DD or null"}',
  complete_milestone: '{"goal_id":"","milestone":"milestone id or exact title","done":true}',
  log_habit: '{"habit_id":"your habit","date":"YYYY-MM-DD (default today)","done":true}',
  update_note: '{"note_id":"your note","title":"","body":"","privacy":"private|workspace"}',
  delete_note: '{"note_id":"your note"} cannot be undone',
  create_idea: '{"text":""} adds a sticky note to the idea board',
  create_category: '{"name":"","parent":"existing category name or empty"}',
  set_monthly_budget: '{"month":"YYYY-MM","category":"existing category name","currency":"EUR","amount":450} needs the budget permission; amount 0 removes the line',
  void_transaction: '{"transaction_id":""} marks a transaction as void (it stops counting)',
  create_column: '{"project_id":"","name":"","status":"todo|doing|blocked|done or empty","card_limit":5}',
  update_column: '{"project_id":"","column":"column name","name":"","status":"todo|doing|blocked|done or null","card_limit":"number or null"}',
  update_automation: '{"automation_id":"","enabled":true}',
  run_automation: '{"automation_id":"your scheduled automation"} runs it now',
  connect_mcp_server: '{"name":"short name","url":"https://... the server\'s MCP address"} sets up a connection for the assistant. Do NOT ask for or include any token in chat: the user types it into the approval card. Servers that need a browser login (OAuth) are not supported, only access tokens or open servers',
  disconnect_mcp_server: '{"name":"name of a connected server"}',
  copy_to_workspace: '{"entity":"project|goal|note|idea","id":"","workspace":"name of the other workspace"} makes an independent copy there; the original stays (attachments, budgets and links are not copied, journals never)',
};
export const MORE_TYPES = Object.keys(MORE_DOCS);
export const MORE_ASYNC = new Set(['run_automation', 'connect_mcp_server']);
export const MORE_DESTRUCTIVE = new Set(['delete_project', 'delete_task', 'delete_event', 'delete_note']);
export const MORE_PERSONAL = new Set(['connect_mcp_server', 'disconnect_mcp_server']);

const str = (v, n) => String(v ?? '').trim().slice(0, n);
const has = (a, k) => Object.hasOwn(a, k);
const catByName = (ws, name) => db.prepare('SELECT id, name FROM transaction_categories WHERE workspace_id = ? AND archived_at IS NULL AND lower(name) = lower(?)').get(ws, str(name, 60));
const dateOrNull = (v) => (v === null || v === '' ? null : parseDate(v));

function columnOf(projectId, ref) {
  const r = str(ref, 60);
  return db.prepare('SELECT * FROM columns WHERE project_id = ? AND (id = ? OR lower(name) = lower(?)) ORDER BY position LIMIT 1').get(projectId, r, r);
}
const projectOfColumn = (columnId) => db.prepare('SELECT p.* FROM projects p JOIN columns c ON c.project_id = p.id WHERE c.id = ?').get(columnId);
const myHabit = (id, ws, userId) => db.prepare('SELECT * FROM habits WHERE id = ? AND workspace_id = ? AND user_id = ? AND archived_at IS NULL').get(str(id, 40), ws, userId);
const myNote = (id, ws, userId) => db.prepare("SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND kind = 'note' AND author_id = ?").get(str(id, 40), ws, userId);
const myAutomation = (id, ws) => db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?').get(str(id, 40), ws);
const workspaceByRef = (userId, ref) => {
  const r = str(ref, 80);
  return db.prepare(`SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? AND w.archived_at IS NULL AND (w.id = ? OR lower(w.name) = lower(?)) LIMIT 1`).get(userId, r, r);
};

// -> { error } | { payload, target, description }
export function validateMore(type, a, ws, user) {
  if (!user) return { error: 'needs a signed-in user' };
  const role = membershipRole(user.id, ws);
  if (!can(role, 'content:write')) return { error: 'you do not have write access in this workspace' };

  if (type === 'update_project') {
    const p = projectInWs(a.project_id, ws); if (!p) return { error: 'unknown project' };
    const out = { project_id: p.id }; const bits = [];
    if (has(a, 'name')) { const n = str(a.name, 120); if (!n) return { error: 'name cannot be empty' }; out.name = n; bits.push(`rename to "${n}"`); }
    if (has(a, 'description')) { out.description = str(a.description, 5000); bits.push('change the description'); }
    if (has(a, 'status')) { if (!PROJECT_STATUSES.includes(a.status)) return { error: 'invalid status' }; out.status = a.status; bits.push(`status ${p.status} -> ${a.status}`); }
    if (has(a, 'priority')) { if (!PRIORITIES.includes(a.priority)) return { error: 'invalid priority' }; out.priority = a.priority; bits.push(`priority ${a.priority}`); }
    for (const k of ['start_date', 'target_date']) if (has(a, k)) { const d = dateOrNull(a[k]); if (d === undefined) return { error: `invalid ${k}` }; out[k] = d; bits.push(`${k.replace('_', ' ')} ${d ?? 'cleared'}`); }
    if (has(a, 'life_area_id')) {
      if (a.life_area_id !== null && !db.prepare('SELECT 1 FROM life_areas WHERE id = ? AND workspace_id = ?').get(str(a.life_area_id, 40), ws)) return { error: 'unknown life area' };
      out.life_area_id = a.life_area_id; bits.push('change the life area');
    }
    if (!bits.length) return { error: 'nothing to change' };
    return { payload: out, target: { entity: 'project', id: p.id }, description: `Update project "${p.name}": ${bits.join(', ')}` };
  }
  if (type === 'archive_project') {
    const p = projectInWs(a.project_id, ws); if (!p) return { error: 'unknown project' };
    const archived = a.archived !== false;
    return { payload: { project_id: p.id, archived }, target: { entity: 'project', id: p.id }, description: `${archived ? 'Archive' : 'Restore'} project "${p.name}"` };
  }
  if (type === 'delete_project') {
    const p = projectInWs(a.project_id, ws); if (!p) return { error: 'unknown project' };
    const n = db.prepare('SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = ?').get(p.id).n;
    return { payload: { project_id: p.id }, target: { entity: 'project', id: p.id }, description: `DELETE project "${p.name}" and its ${n} task${n === 1 ? '' : 's'}. This cannot be undone` };
  }
  if (type === 'delete_task') {
    const c = cardInWs(a.task_id, ws); if (!c) return { error: 'unknown task' };
    return { payload: { task_id: c.id }, target: { entity: 'task', id: c.id }, description: `DELETE task "${c.title}". This cannot be undone` };
  }
  if (type === 'move_task') {
    const c = cardInWs(a.task_id, ws); if (!c) return { error: 'unknown task' };
    const col = columnOf(projectOfColumn(c.column_id).id, a.column ?? a.column_id);
    if (!col) return { error: 'unknown column in that task\'s project' };
    if (col.id === c.column_id) return { error: 'the task is already in that column' };
    const room = columnRoom(col.id, c.id);
    if (!room.ok) return { error: fullMessage(col) };
    return { payload: { task_id: c.id, column_id: col.id }, target: { entity: 'task', id: c.id },
      description: `Move task "${c.title}" to column "${col.name}"${col.status && col.status !== c.status ? ` (status becomes ${col.status})` : ''}` };
  }
  if (type === 'complete_subtask') {
    const c = cardInWs(a.task_id, ws); if (!c) return { error: 'unknown task' };
    const ref = str(a.subtask ?? a.subtask_id, 200);
    const sub = db.prepare('SELECT * FROM subtasks WHERE card_id = ? AND (id = ? OR lower(title) = lower(?)) LIMIT 1').get(c.id, ref, ref);
    if (!sub) return { error: 'unknown subtask' };
    const done = a.done !== false;
    return { payload: { task_id: c.id, subtask_id: sub.id, done }, target: { entity: 'task', id: c.id }, description: `Mark subtask "${sub.title}" of "${c.title}" as ${done ? 'done' : 'not done'}` };
  }
  if (type === 'update_event' || type === 'delete_event') {
    const cur = eventInWs(a.event_id, ws); if (!cur) return { error: 'unknown event' };
    if (type === 'delete_event') return { payload: { event_id: cur.id }, target: { entity: 'calendar_event', id: cur.id }, description: `DELETE event "${cur.title}" (${cur.start_local.replace('T', ' ')}${cur.recurrence !== 'none' ? ', the whole series' : ''}). This cannot be undone` };
    const src = a.v && typeof a.v === 'object' ? a.v : a;   // a stored proposal carries the full merged event
    const body = {}; for (const k of ['title', 'description', 'start_local', 'end_local', 'timezone', 'all_day', 'reminder_minutes', 'kind']) if (has(src, k)) body[k] = src[k];
    if (!Object.keys(body).length) return { error: 'nothing to change' };
    const r = readEvent(body, ws, cur);
    if (r.error) return { error: r.error };
    return { payload: { event_id: cur.id, v: r.v }, target: { entity: 'calendar_event', id: cur.id }, description: `Update event "${cur.title}": ${Object.keys(body).join(', ')}${r.v.start_local !== cur.start_local ? ` (starts ${r.v.start_local.replace('T', ' ')})` : ''}` };
  }
  if (type === 'update_goal') {
    const g = goalInWs(a.goal_id, ws); if (!g) return { error: 'unknown goal' };
    const out = { goal_id: g.id }; const bits = [];
    if (has(a, 'title')) { const t = str(a.title, 200); if (!t) return { error: 'title cannot be empty' }; out.title = t; bits.push(`rename to "${t}"`); }
    if (has(a, 'status')) { if (!['active', 'achieved', 'archived'].includes(a.status)) return { error: 'invalid status' }; out.status = a.status; bits.push(`status ${a.status}`); }
    if (has(a, 'target_date')) { const d = dateOrNull(a.target_date); if (d === undefined) return { error: 'invalid target_date' }; out.target_date = d; bits.push(`target ${d ?? 'cleared'}`); }
    if (!bits.length) return { error: 'nothing to change' };
    return { payload: out, target: { entity: 'goal', id: g.id }, description: `Update goal "${g.title}": ${bits.join(', ')}` };
  }
  if (type === 'complete_milestone') {
    const g = goalInWs(a.goal_id, ws); if (!g) return { error: 'unknown goal' };
    const ref = str(a.milestone ?? a.milestone_id, 200);
    const m = db.prepare('SELECT * FROM goal_milestones WHERE goal_id = ? AND (id = ? OR lower(title) = lower(?)) LIMIT 1').get(g.id, ref, ref);
    if (!m) return { error: 'unknown milestone' };
    const done = a.done !== false;
    return { payload: { goal_id: g.id, milestone_id: m.id, done }, target: { entity: 'goal', id: g.id }, description: `Mark milestone "${m.title}" of goal "${g.title}" as ${done ? 'done' : 'not done'}` };
  }
  if (type === 'log_habit') {
    const h = myHabit(a.habit_id, ws, user.id); if (!h) return { error: 'unknown habit (only your own)' };
    const date = a.date == null ? todayUtc() : parseDate(a.date);
    if (!date) return { error: 'invalid date' };
    if (date > new Date(Date.parse(`${todayUtc()}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10)) return { error: 'cannot check in on a future date' };
    const done = a.done !== false;
    return { payload: { habit_id: h.id, date, done }, target: { entity: 'habit', id: h.id }, description: `${done ? 'Check in' : 'Remove the check-in for'} habit "${h.title}" on ${date}` };
  }
  if (type === 'update_note' || type === 'delete_note') {
    const n = myNote(a.note_id, ws, user.id); if (!n) return { error: 'unknown note (only your own; journals are never editable here)' };
    if (type === 'delete_note') return { payload: { note_id: n.id }, target: { entity: 'note', id: n.id }, description: `DELETE note "${n.title || '(untitled)'}". This cannot be undone` };
    const out = { note_id: n.id }; const bits = [];
    if (has(a, 'title')) { out.title = str(a.title, 200); bits.push('title'); }
    if (has(a, 'body')) { out.body = String(a.body ?? '').slice(0, 50_000); bits.push('text'); }
    if (has(a, 'privacy')) { if (!['private', 'workspace'].includes(a.privacy)) return { error: 'invalid privacy' }; out.privacy = a.privacy; bits.push(`visibility ${a.privacy === 'private' ? 'private' : 'shared'}`); }
    if (!bits.length) return { error: 'nothing to change' };
    return { payload: out, target: { entity: 'note', id: n.id }, description: `Update note "${n.title || '(untitled)'}": ${bits.join(', ')}` };
  }
  if (type === 'create_idea') {
    const text = str(a.text, 2000); if (!text) return { error: 'text required' };
    return { payload: { text }, target: { entity: 'idea', id: null }, description: `Add idea "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}" to the idea board` };
  }
  if (type === 'create_category') {
    const name = str(a.name, 60); if (!name) return { error: 'name required' };
    if (catByName(ws, name)) return { error: 'a category with that name already exists' };
    let parent = null;
    if (a.parent_id) { parent = db.prepare('SELECT id, name FROM transaction_categories WHERE id = ? AND workspace_id = ?').get(str(a.parent_id, 40), ws); if (!parent) return { error: 'unknown parent category' }; }
    else if (str(a.parent, 60)) { parent = catByName(ws, a.parent); if (!parent) return { error: 'unknown parent category' }; }
    return { payload: { name, parent_id: parent?.id ?? null }, target: { entity: 'category', id: null }, description: `Create category "${name}"${parent ? ` under "${parent.name}"` : ''}` };
  }
  if (type === 'set_monthly_budget') {
    if (!can(role, 'budget:approve')) return { error: 'only an owner or admin can change budgets' };
    const month = str(a.month, 7); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { error: 'month must be YYYY-MM' };
    const cat = a.category_id ? db.prepare('SELECT id, name FROM transaction_categories WHERE id = ? AND workspace_id = ?').get(str(a.category_id, 40), ws) : catByName(ws, a.category); if (!cat) return { error: 'unknown category (create it first)' };
    const currency = str(a.currency, 3).toUpperCase(); if (!CURRENCY_RE.test(currency)) return { error: 'currency must be a 3-letter code' };
    const amount = a.amount_minor != null ? Number(a.amount_minor) / 100 : Number(a.amount); if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) return { error: 'invalid amount' };
    const minor = Math.round(amount * 100);
    return { payload: { month, category_id: cat.id, currency, amount_minor: minor }, target: { entity: 'category', id: cat.id },
      description: minor === 0 ? `Remove the ${month} budget line for "${cat.name}" (${currency})` : `Set the ${month} budget for "${cat.name}" to ${(minor / 100).toFixed(2)} ${currency}` };
  }
  if (type === 'void_transaction') {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ? AND workspace_id = ? AND voided_at IS NULL').get(str(a.transaction_id, 40), ws); if (!t) return { error: 'unknown transaction' };
    return { payload: { transaction_id: t.id }, target: { entity: 'transaction', id: t.id }, description: `Void ${t.type} "${t.description || '(no description)'}" of ${(t.amount_minor / 100).toFixed(2)} ${t.currency} on ${t.date}` };
  }
  if (type === 'create_column' || type === 'update_column') {
    const p = projectInWs(a.project_id, ws); if (!p) return { error: 'unknown project' };
    const out = { project_id: p.id }; const bits = [];
    let col = null;
    if (type === 'update_column') { col = columnOf(p.id, a.column ?? a.column_id); if (!col) return { error: 'unknown column' }; out.column_id = col.id; }
    if (type === 'create_column' || has(a, 'name')) { const n = str(a.name, 80); if (!n && type === 'create_column') return { error: 'name required' }; if (n) { out.name = n; bits.push(`name "${n}"`); } }
    if (has(a, 'status') || type === 'create_column') {
      const st = a.status === '' || a.status == null ? null : a.status;
      if (st !== null && !COLUMN_STATUSES.includes(st)) return { error: 'invalid status' };
      if (has(a, 'status') || st) { out.status = st; bits.push(`status ${st ?? 'none'}`); }
    }
    if (has(a, 'card_limit')) {
      const v = a.card_limit === '' ? null : a.card_limit;
      if (v !== null && (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 999)) return { error: 'card limit must be 1 to 999 or null' };
      out.card_limit = v === null ? null : Number(v); bits.push(`limit ${out.card_limit ?? 'none'}`);
    }
    if (type === 'update_column' && !bits.length) return { error: 'nothing to change' };
    return { payload: out, target: { entity: 'column', id: col?.id ?? null }, description: type === 'create_column' ? `Add column "${out.name}" to project "${p.name}"${bits.length > 1 ? ` (${bits.slice(1).join(', ')})` : ''}` : `Change column "${col.name}" in "${p.name}": ${bits.join(', ')}` };
  }
  if (type === 'update_automation' || type === 'run_automation') {
    const au = myAutomation(a.automation_id, ws); if (!au) return { error: 'unknown automation' };
    if (type === 'update_automation') {
      if (au.user_id !== user.id && !['owner', 'admin'].includes(role)) return { error: 'only the flow owner or an admin can change it' };
      if (typeof a.enabled !== 'boolean') return { error: 'enabled must be true or false' };
      return { payload: { automation_id: au.id, enabled: a.enabled }, target: { entity: 'automation', id: au.id }, description: `${a.enabled ? 'Turn on' : 'Turn off'} automation "${au.name}"` };
    }
    if (au.user_id !== user.id) return { error: 'only the flow owner can run it' };
    if (JSON.parse(au.trigger).type !== 'schedule') return { error: 'event flows run when their event happens' };
    return { payload: { automation_id: au.id }, target: { entity: 'automation', id: au.id }, description: `Run automation "${au.name}" now (${JSON.parse(au.steps).length} step${JSON.parse(au.steps).length === 1 ? '' : 's'}, as you)` };
  }
  if (type === 'connect_mcp_server') {
    const name = str(a.name, 40); if (!name) return { error: 'name required' };
    if (db.prepare('SELECT 1 FROM mcp_servers WHERE workspace_id = ? AND user_id = ? AND lower(name) = lower(?)').get(ws, user.id, name)) return { error: 'you already have a server with that name' };
    if (db.prepare('SELECT COUNT(*) AS n FROM mcp_servers WHERE workspace_id = ? AND user_id = ?').get(ws, user.id).n >= 10) return { error: 'at most 10 connected servers' };
    let u; try { u = new URL(str(a.url, 300)); } catch { return { error: 'the address is not a valid URL' }; }
    const dev = process.env.MCP_ALLOW_PRIVATE === 'true';
    if (u.protocol !== 'https:' && !(dev && u.protocol === 'http:')) return { error: 'the server address must start with https://' };
    if (u.username || u.password) return { error: 'credentials do not belong in the URL' };
    if (!dev && (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) || /^[0-9.]+$/.test(u.hostname) || u.hostname.includes(':'))) return { error: 'that address is not a public server' };
    return { payload: { name, url: u.toString() }, target: { entity: 'mcp_server', id: null },
      description: `Connect the tool server "${name}" at ${u.host} for your assistant. Read-only tools will run directly; anything that changes data asks you first. You can add an access token when you approve (it is stored encrypted)` };
  }
  if (type === 'disconnect_mcp_server') {
    const s = db.prepare('SELECT * FROM mcp_servers WHERE workspace_id = ? AND user_id = ? AND (id = ? OR lower(name) = lower(?))').get(ws, user.id, str(a.name, 80), str(a.name, 80));
    if (!s) return { error: 'unknown connected server' };
    return { payload: { name: s.name }, target: { entity: 'mcp_server', id: s.id }, description: `Disconnect the tool server "${s.name}" (${new URL(s.url).host})` };
  }
  if (type === 'copy_to_workspace') {
    const entity = String(a.entity ?? '');
    if (!['project', 'goal', 'note', 'idea'].includes(entity)) return { error: 'entity must be project, goal, note or idea' };
    const target = workspaceByRef(user.id, a.workspace ?? a.target_workspace_id);
    if (!target) return { error: `unknown workspace "${str(a.workspace ?? a.target_workspace_id, 60)}". Your workspaces: ${db.prepare('SELECT w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? AND w.archived_at IS NULL').all(user.id).map((w) => w.name).join(', ')}` };
    try { checkCopyTarget(user.id, ws, target.id); } catch (e) { return { error: e.message }; }
    let name;
    if (entity === 'project') name = projectInWs(a.id, ws)?.name;
    else if (entity === 'goal') name = goalInWs(a.id, ws)?.title;
    else if (entity === 'note') { const n = db.prepare("SELECT title, privacy, author_id FROM notes WHERE id = ? AND workspace_id = ? AND kind = 'note'").get(str(a.id, 40), ws); name = n && (n.privacy !== 'private' || n.author_id === user.id) ? (n.title || 'note') : undefined; }
    else name = db.prepare('SELECT text FROM idea_notes WHERE id = ? AND workspace_id = ?').get(str(a.id, 40), ws)?.text?.slice(0, 40);
    if (!name) return { error: `unknown ${entity}` };
    return { payload: { entity, id: str(a.id, 40), target_workspace_id: target.id }, target: { entity, id: str(a.id, 40) }, description: `Copy ${entity} "${name}" to workspace "${target.name}" (an independent copy; the original stays)` };
  }
  return { error: 'action type not allowed' };
}

// Runs inside the caller's transaction.
export function applyMore(type, p, ws, actor, ts) {
  switch (type) {
    case 'update_project': {
      const cur = projectInWs(p.project_id, ws);
      db.prepare('UPDATE projects SET name = ?, description = ?, status = ?, priority = ?, start_date = ?, target_date = ?, life_area_id = ?, updated_at = ? WHERE id = ?')
        .run(p.name ?? cur.name, 'description' in p ? p.description : cur.description, p.status ?? cur.status, p.priority ?? cur.priority, 'start_date' in p ? p.start_date : cur.start_date,
          'target_date' in p ? p.target_date : cur.target_date, 'life_area_id' in p ? p.life_area_id : cur.life_area_id, ts, cur.id);
      return { entity: 'project', id: cur.id };
    }
    case 'archive_project': db.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?').run(p.archived ? ts : null, ts, p.project_id); return { entity: 'project', id: p.project_id };
    case 'delete_project': db.prepare('DELETE FROM projects WHERE id = ?').run(p.project_id); return { entity: 'project', id: p.project_id, deleted: true };
    case 'delete_task': db.prepare('DELETE FROM cards WHERE id = ?').run(p.task_id); return { entity: 'task', id: p.task_id, deleted: true };
    case 'move_task': {
      const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(p.task_id);
      const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(p.column_id);
      db.prepare('UPDATE cards SET column_id = ?, position = (SELECT COALESCE(MAX(position), -1) + 1 FROM cards WHERE column_id = ?), updated_at = ? WHERE id = ?').run(col.id, col.id, ts, card.id);
      if (col.status && col.status !== card.status) {
        db.prepare('UPDATE cards SET status = ?, completed_at = ? WHERE id = ?').run(col.status, col.status === 'done' ? (card.completed_at || ts) : null, card.id);
        if (col.status === 'done') spawnNextOccurrence({ ...card, status: 'done' }, ts);
      }
      return { entity: 'task', id: card.id };
    }
    case 'complete_subtask': db.prepare('UPDATE subtasks SET done = ?, completed_at = ? WHERE id = ?').run(p.done ? 1 : 0, p.done ? ts : null, p.subtask_id); return { entity: 'task', id: p.task_id };
    case 'update_event': {
      const v = p.v;
      db.prepare(`UPDATE calendar_events SET title = ?, description = ?, kind = ?, all_day = ?, start_local = ?, end_local = ?, timezone = ?, recurrence = ?, recurrence_interval = ?,
        recurrence_until = ?, project_id = ?, card_id = ?, reminder_minutes = ?, updated_at = ? WHERE id = ?`)
        .run(v.title, v.description, v.kind, v.all_day, v.start_local, v.end_local, v.timezone, v.recurrence, v.recurrence_interval, v.recurrence_until, v.project_id, v.card_id, v.reminder_minutes, ts, p.event_id);
      return { entity: 'calendar_event', id: p.event_id };
    }
    case 'delete_event': db.prepare('DELETE FROM calendar_events WHERE id = ? AND workspace_id = ?').run(p.event_id, ws); return { entity: 'calendar_event', id: p.event_id, deleted: true };
    case 'update_goal': {
      const g = goalInWs(p.goal_id, ws);
      db.prepare('UPDATE goals SET title = ?, status = ?, target_date = ?, updated_at = ? WHERE id = ?').run(p.title ?? g.title, p.status ?? g.status, 'target_date' in p ? p.target_date : g.target_date, ts, g.id);
      return { entity: 'goal', id: g.id };
    }
    case 'complete_milestone': db.prepare('UPDATE goal_milestones SET done = ?, completed_at = ? WHERE id = ?').run(p.done ? 1 : 0, p.done ? ts : null, p.milestone_id); return { entity: 'goal', id: p.goal_id };
    case 'log_habit':
      if (p.done) db.prepare('INSERT OR IGNORE INTO habit_entries (habit_id, date, created_at) VALUES (?, ?, ?)').run(p.habit_id, p.date, ts);
      else db.prepare('DELETE FROM habit_entries WHERE habit_id = ? AND date = ?').run(p.habit_id, p.date);
      return { entity: 'habit', id: p.habit_id };
    case 'update_note': {
      const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(p.note_id);
      db.prepare('UPDATE notes SET title = ?, body = ?, privacy = ?, updated_at = ? WHERE id = ?').run(p.title ?? n.title, p.body ?? n.body, p.privacy ?? n.privacy, ts, n.id);
      return { entity: 'note', id: n.id };
    }
    case 'delete_note': db.prepare('DELETE FROM notes WHERE id = ?').run(p.note_id); return { entity: 'note', id: p.note_id, deleted: true };
    case 'create_idea': {
      const id = nanoid();
      db.prepare('INSERT INTO idea_notes (id, author, text, color, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, actor.name, p.text, '#fde68a', ws, ts, ts);
      return { entity: 'idea', id };
    }
    case 'create_category': {
      const id = nanoid();
      db.prepare('INSERT INTO transaction_categories (id, workspace_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, ws, p.name, p.parent_id, ts);
      return { entity: 'category', id };
    }
    case 'set_monthly_budget':
      if (p.amount_minor === 0) db.prepare('DELETE FROM monthly_budgets WHERE workspace_id = ? AND month = ? AND category_id = ? AND currency = ?').run(ws, p.month, p.category_id, p.currency);
      else db.prepare(`INSERT INTO monthly_budgets (workspace_id, month, category_id, currency, amount_minor) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, month, category_id, currency) DO UPDATE SET amount_minor = excluded.amount_minor`).run(ws, p.month, p.category_id, p.currency, p.amount_minor);
      return { entity: 'category', id: p.category_id };
    case 'void_transaction': db.prepare('UPDATE transactions SET voided_at = ?, updated_at = ? WHERE id = ? AND voided_at IS NULL').run(ts, ts, p.transaction_id); return { entity: 'transaction', id: p.transaction_id };
    case 'create_column': {
      const id = nanoid();
      const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM columns WHERE project_id = ?').get(p.project_id).n;
      db.prepare('INSERT INTO columns (id, project_id, name, position, status, card_limit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, p.project_id, p.name, pos, p.status ?? null, p.card_limit ?? null, ts);
      return { entity: 'column', id };
    }
    case 'update_column': {
      const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(p.column_id);
      const status = 'status' in p ? p.status : col.status;
      db.prepare('UPDATE columns SET name = ?, status = ?, card_limit = ? WHERE id = ?').run(p.name ?? col.name, status, 'card_limit' in p ? p.card_limit : col.card_limit, col.id);
      if (status && status !== col.status) db.prepare("UPDATE cards SET status = ?, completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END, updated_at = ? WHERE column_id = ? AND status <> ?").run(status, status, ts, ts, col.id, status);
      return { entity: 'column', id: col.id };
    }
    case 'update_automation': {
      const au = myAutomation(p.automation_id, ws);
      db.prepare('UPDATE automations SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?').run(p.enabled ? 1 : 0, p.enabled ? nextRunAt(JSON.parse(au.trigger)) : null, ts, au.id);
      return { entity: 'automation', id: au.id };
    }
    case 'disconnect_mcp_server': {
      const s = db.prepare('SELECT id FROM mcp_servers WHERE workspace_id = ? AND user_id = ? AND lower(name) = lower(?)').get(ws, actor.id, p.name);
      if (s) { db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(s.id); forget(s.id); }
      return { entity: 'mcp_server', id: s?.id ?? null, deleted: true };
    }
    case 'copy_to_workspace': {
      const out = copyEntityInner({ entity: p.entity, id: p.id, sourceWs: ws, targetId: p.target_workspace_id, user: actor, ts });
      db.prepare('INSERT INTO audit_log (id, workspace_id, user_id, action, entity_type, entity_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), p.target_workspace_id, actor.id, 'workspace.copy_in', out.entity, out.id, JSON.stringify({ from: ws, via: 'assistant' }), ts);
      return { entity: out.entity, id: out.id, name: out.name, copied: out.copied, skipped: out.skipped, target_workspace_id: p.target_workspace_id };
    }
    default: throw new Error('action type not allowed');
  }
}

// run_automation waits on the network-free but async engine, outside a transaction.
export async function applyMoreAsync(type, p, ws, actor, extra = {}) {
  if (type === 'connect_mcp_server') {
    await assertSafeUrl(p.url);   // full check (DNS, private ranges) now that we are about to connect
    const id = nanoid();
    db.prepare('INSERT INTO mcp_servers (id, workspace_id, user_id, name, url, auth_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, ws, actor.id, p.name, p.url, encryptSecret(String(extra.token || '').trim().slice(0, 4000)), nowIso());
    db.prepare('INSERT INTO audit_log (id, workspace_id, user_id, action, entity_type, entity_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), ws, actor.id, 'ai.connection_added', 'mcp_server', id, JSON.stringify({ name: p.name, via: 'assistant', with_token: !!extra.token }), nowIso());
    const { toolsOf } = await import('./mcpServers.js');
    try { const tools = await toolsOf(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)); return { entity: 'mcp_server', id, tools: tools.length, read_only: tools.filter((t) => t.read_only).length }; }
    catch (e) { return { entity: 'mcp_server', id, tools: 0, warning: `Saved, but the server could not be reached: ${String(e.message).slice(0, 120)}` }; }
  }
  const { runNow, readAutomation } = await import('../automations/engine.js');
  const au = readAutomation(ws, p.automation_id);
  if (!au) throw new Error('automation no longer exists');
  const r = await runNow(au);
  return { entity: 'automation', id: au.id, status: r.status, log: r.log };
}
