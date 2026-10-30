// The assistant can propose anything a person can do on the screens (approval still required). The AI provider is MOCKED.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp } from './helpers.js';

let srv, ai, db;
let script = [];
before(async () => {
  ai = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(script.shift() ?? { type: 'final', answer: 'x', proposals: [] }) } }], usage: {} })); });
  });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  srv = await startServer();
  process.env.DEEPSEEK_API_KEY = 'k'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
  ({ db } = await import('../src/db.js'));
});
after(() => { srv.close(); ai.close(); });

// asks the (scripted) assistant for one proposal and returns it with the dropped list
async function propose(u, type, args) {
  script = [{ type: 'final', answer: 'ok', proposals: [{ type, args }] }];
  const r = (await u.c.post('/api/ai/assistant/chat', { message: 'do it' })).json;
  return { p: r.message.proposals[0], dropped: r.dropped };
}
const approve = (u, p) => u.c.post(`/api/ai/assistant/proposals/${p.id}/approve`);
const run = async (u, type, args) => { const { p, dropped } = await propose(u, type, args); assert.ok(p, `${type} was dropped: ${JSON.stringify(dropped)}`); const r = await approve(u, p); assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.json)}`); return r.json; };

async function world(label) {
  const u = await signUp(srv.base, label);
  const p = (await u.c.post('/api/projects', { name: `${label} project` })).json;
  const cols = (await u.c.get(`/api/projects/${p.id}/columns`)).json;
  const t = (await u.c.post(`/api/cards/columns/${cols[0].id}/cards`, { title: 'Task one' })).json;
  return { u, p, cols, t };
}

test('projects, tasks and columns: update, archive, move (status follows, limit respected), subtask, delete', async () => {
  const { u, p, cols, t } = await world('Par1');
  await run(u, 'update_project', { project_id: p.id, name: 'Renamed', priority: 'urgent', target_date: '2027-05-01' });
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
  assert.equal(row.name, 'Renamed'); assert.equal(row.priority, 'urgent'); assert.equal(row.target_date, '2027-05-01');
  assert.equal((await propose(u, 'update_project', { project_id: p.id })).dropped.length, 1, 'nothing to change');
  assert.equal((await propose(u, 'update_project', { project_id: p.id, priority: 'whatever' })).dropped.length, 1);
  await run(u, 'move_task', { task_id: t.id, column: 'In Progress' });
  const moved = db.prepare('SELECT * FROM cards WHERE id = ?').get(t.id);
  assert.equal(moved.column_id, cols[1].id); assert.equal(moved.status, 'doing');
  await run(u, 'update_column', { project_id: p.id, column: 'In Progress', card_limit: 1 });
  const t2 = (await u.c.post(`/api/cards/columns/${cols[0].id}/cards`, { title: 'Task two' })).json;
  assert.equal((await propose(u, 'move_task', { task_id: t2.id, column: 'In Progress' })).dropped[0].reason.includes('full'), true, 'a full column is refused');
  await run(u, 'create_column', { project_id: p.id, name: 'Review', status: 'doing' });
  assert.deepEqual({ ...db.prepare("SELECT status, card_limit FROM columns WHERE project_id = ? AND name = 'Review'").get(p.id) }, { status: 'doing', card_limit: null });
  await u.c.post(`/api/cards/${t.id}/subtasks`, { title: 'Measure' });
  await run(u, 'complete_subtask', { task_id: t.id, subtask: 'measure', done: true });
  assert.equal(db.prepare('SELECT done FROM subtasks WHERE card_id = ?').get(t.id).done, 1);
  await run(u, 'archive_project', { project_id: p.id, archived: true });
  assert.ok(db.prepare('SELECT archived_at FROM projects WHERE id = ?').get(p.id).archived_at);
  await run(u, 'archive_project', { project_id: p.id, archived: false });
  // deletes show a warning in the description and need approval; nothing is removed by proposing
  const del = await propose(u, 'delete_task', { task_id: t2.id });
  assert.match(del.p.description, /^DELETE task "Task two"/); assert.ok(db.prepare('SELECT 1 FROM cards WHERE id = ?').get(t2.id));
  assert.equal((await approve(u, del.p)).status, 200); assert.equal(db.prepare('SELECT 1 FROM cards WHERE id = ?').get(t2.id), undefined);
  const dp = await propose(u, 'delete_project', { project_id: p.id });
  assert.match(dp.p.description, /^DELETE project "Renamed" and its 1 task/);
  await approve(u, dp.p); assert.equal(db.prepare('SELECT 1 FROM projects WHERE id = ?').get(p.id), undefined);
});

test('events, goals, habits, notes, ideas', async () => {
  const { u } = await world('Par2');
  const ev = (await u.c.post('/api/calendar/events', { title: 'Dentist', start_local: '2027-03-01T10:00', timezone: 'UTC' })).json;
  await run(u, 'update_event', { event_id: ev.id, start_local: '2027-03-02T11:30', title: 'Dentist (moved)' });
  assert.deepEqual({ ...db.prepare('SELECT title, start_local FROM calendar_events WHERE id = ?').get(ev.id) }, { title: 'Dentist (moved)', start_local: '2027-03-02T11:30' });
  await run(u, 'delete_event', { event_id: ev.id });
  assert.equal(db.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(ev.id), undefined);
  const g = (await u.c.post('/api/goals', { title: 'Marathon' })).json;
  await u.c.post(`/api/goals/${g.id}/milestones`, { title: '10k' });
  await run(u, 'complete_milestone', { goal_id: g.id, milestone: '10K', done: true });
  assert.equal(db.prepare('SELECT done FROM goal_milestones WHERE goal_id = ?').get(g.id).done, 1);
  await run(u, 'update_goal', { goal_id: g.id, status: 'achieved' });
  assert.equal(db.prepare('SELECT status FROM goals WHERE id = ?').get(g.id).status, 'achieved');
  const h = (await u.c.post('/api/habits', { title: 'Walk', frequency: 'daily' })).json;
  await run(u, 'log_habit', { habit_id: h.id });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM habit_entries WHERE habit_id = ?').get(h.id).n, 1);
  assert.equal((await propose(u, 'log_habit', { habit_id: h.id, date: '2099-01-01' })).dropped.length, 1, 'no future check-ins');
  const n = (await u.c.post('/api/notes', { title: 'Plan', body: 'a', privacy: 'workspace' })).json;
  await run(u, 'update_note', { note_id: n.id, body: 'b', privacy: 'private' });
  assert.deepEqual({ ...db.prepare('SELECT body, privacy FROM notes WHERE id = ?').get(n.id) }, { body: 'b', privacy: 'private' });
  const j = (await u.c.post('/api/notes', { kind: 'journal', title: 'Diary', body: 'secret', entry_date: '2027-01-01' })).json;
  assert.equal((await propose(u, 'update_note', { note_id: j.id, body: 'x' })).dropped.length, 1, 'journals are never editable');
  assert.equal((await propose(u, 'delete_note', { note_id: j.id })).dropped.length, 1);
  await run(u, 'delete_note', { note_id: n.id });
  await run(u, 'create_idea', { text: 'Balcony garden' });
  assert.ok(db.prepare("SELECT 1 FROM idea_notes WHERE text = 'Balcony garden'").get());
});

test('money: categories, monthly budget (budget permission), voiding', async () => {
  const { u } = await world('Par3');
  await run(u, 'create_category', { name: 'Zebra food' });
  assert.equal((await propose(u, 'create_category', { name: 'zebra food' })).dropped.length, 1, 'duplicate');
  await run(u, 'set_monthly_budget', { month: '2027-04', category: 'Zebra food', currency: 'RON', amount: 300 });
  assert.equal(db.prepare('SELECT amount_minor FROM monthly_budgets WHERE month = ?').get('2027-04').amount_minor, 30000);
  await run(u, 'set_monthly_budget', { month: '2027-04', category: 'Zebra food', currency: 'RON', amount: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM monthly_budgets WHERE month = ?').get('2027-04').n, 0, 'zero removes the line');
  const tx = (await u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 1250, currency: 'EUR', date: '2027-04-02', description: 'Vet' })).json;
  const vp = await propose(u, 'void_transaction', { transaction_id: tx.id });
  assert.match(vp.p.description, /Void expense "Vet" of 12.50 EUR/);
  await approve(u, vp.p);
  assert.ok(db.prepare('SELECT voided_at FROM transactions WHERE id = ?').get(tx.id).voided_at);
  // a plain member cannot change budgets, even through the assistant
  const owner = await signUp(srv.base, 'Par3Owner');
  const sw = (await owner.c.post('/api/workspaces', { name: 'Team' })).json;
  const member = await signUp(srv.base, 'Par3Member');
  const inv = (await owner.c.post(`/api/workspaces/${sw.id}/invitations`, { email: member.email, role: 'member' })).json;
  await member.c.post('/api/invitations/accept', { token: inv.token });
  member.c.useWorkspace(sw.id); owner.c.useWorkspace(sw.id);
  await owner.c.post('/api/finance/categories', { name: 'Food' });
  const r = await propose(member, 'set_monthly_budget', { month: '2027-04', category: 'Food', currency: 'EUR', amount: 100 });
  assert.match(r.dropped[0].reason, /owner or admin/);
});

test('copy_to_workspace through the assistant, automations on/off and run now, foreign ids and permissions', async () => {
  const { u, p } = await world('Par4');
  const shared = (await u.c.post('/api/workspaces', { name: 'Family' })).json;
  const res = await run(u, 'copy_to_workspace', { entity: 'project', id: p.id, workspace: 'family' });
  assert.equal(res.result.target_workspace_id, shared.id); assert.equal(res.result.copied.tasks, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND name = ?').get(shared.id, p.name).n, 1);
  assert.ok(db.prepare("SELECT 1 FROM projects WHERE id = ? AND workspace_id != ?").get(p.id, shared.id), 'original stays');
  assert.equal((await propose(u, 'copy_to_workspace', { entity: 'project', id: p.id, workspace: 'No such' })).dropped.length, 1);
  assert.equal((await propose(u, 'copy_to_workspace', { entity: 'project', id: p.id, workspace: u.personalId })).dropped.length, 1, 'same workspace');
  const au = (await u.c.post('/api/automations', { name: 'Daily', trigger: { type: 'schedule', frequency: 'daily', time: '07:00', timezone: 'UTC' }, steps: [{ type: 'notify', args: { title: 'Hi' } }] })).json;
  await run(u, 'update_automation', { automation_id: au.id, enabled: false });
  assert.equal(db.prepare('SELECT enabled FROM automations WHERE id = ?').get(au.id).enabled, 0);
  const ran = await run(u, 'run_automation', { automation_id: au.id });
  assert.equal(ran.result.status, 'ok');
  // someone else's objects are invisible
  const other = await signUp(srv.base, 'Par4Other');
  const op = (await other.c.post('/api/projects', { name: 'Theirs' })).json;
  for (const [type, args] of [['delete_project', { project_id: op.id }], ['update_project', { project_id: op.id, name: 'x' }], ['copy_to_workspace', { entity: 'project', id: op.id, workspace: 'Family' }]]) {
    assert.equal((await propose(u, type, args)).dropped.length, 1, type);
  }
  // viewers cannot propose changes at all (the chat itself is blocked), and destructive types are never auto-approvable
  assert.equal((await u.c.put('/api/ai/assistant/settings', { auto_approve: ['delete_task'] })).status, 400);
  assert.equal((await u.c.put('/api/ai/assistant/settings', { auto_approve: ['move_task', 'log_habit'] })).status, 200);
});
