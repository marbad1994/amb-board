// Workspace awareness, setup plans, automations (scheduler + event flows). The AI provider is MOCKED (scripted).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp } from './helpers.js';

let srv, fake, db, runDue, nextRunAt;
const requests = [];
let script = [];

before(async () => {
  fake = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      requests.push(body.messages);
      const next = script.shift() ?? { type: 'final', answer: 'default', proposals: [] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(next) } }], usage: {} }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  srv = await startServer();
  process.env.DEEPSEEK_API_KEY = 'k';
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  ({ db } = await import('../src/db.js'));
  ({ runDue } = await import('../src/automations/engine.js'));
  ({ nextRunAt } = await import('../src/automations/spec.js'));
});
after(() => srv.close() || fake.close());
const reset = (s = []) => { requests.length = 0; script = s; };
const wsOf = (u) => db.prepare('SELECT workspace_id AS w FROM workspace_members WHERE user_id = ?').get(u.user.id).w;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('the assistant sees the whole workspace (with ids) in every request, but never journal text', async () => {
  const u = await signUp(srv.base, 'Aware');
  const p = (await u.c.post('/api/projects', { name: 'Kitchen refit' })).json;
  await u.c.post('/api/goals', { title: 'Run a marathon' });
  await u.c.post('/api/notes', { title: 'Shared plan', body: 'x', privacy: 'workspace' });
  await u.c.post('/api/notes', { kind: 'journal', title: 'Secret diary', body: 'private words', entry_date: '2027-01-01' });
  reset([{ type: 'final', answer: 'ok', proposals: [] }]);
  assert.equal((await u.c.post('/api/ai/assistant/chat', { message: 'what do I have?' })).status, 200);
  const sent = requests[0][1].content;
  assert.ok(sent.includes('Kitchen refit') && sent.includes(p.id), 'project and its id');
  assert.ok(sent.includes('Run a marathon') && sent.includes('Shared plan'));
  assert.ok(!sent.includes('Secret diary') && !sent.includes('private words'), 'journal never sent');
  const sys = requests[0][0].content;
  assert.match(sys, /setup_plan/); assert.match(sys, /create_automation/);
});

test('setup_plan: one approval creates a project, tasks, a goal and milestones; the proposal itself creates nothing', async () => {
  const u = await signUp(srv.base, 'Plan');
  const before = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?').get(wsOf(u)).n;
  reset([{ type: 'final', answer: 'Here is a setup.', proposals: [{ type: 'setup_plan', args: { title: 'Move to a new flat', steps: [
    { ref: 'p1', type: 'create_project', args: { name: 'New flat' } },
    { type: 'create_task', args: { project_id: '@p1', title: 'Sign the lease', due_date: iso(7), priority: 'high' } },
    { type: 'create_task', args: { project_id: '@p1', title: 'Book movers' } },
    { ref: 'g1', type: 'create_goal', args: { title: 'Settled by spring' } },
    { type: 'add_milestone', args: { goal_id: '@g1', title: 'Unpack everything', due_date: iso(30) } },
  ] } }] }]);
  const res = (await u.c.post('/api/ai/assistant/chat', { message: 'set up my move' })).json;
  const plan = res.message.proposals[0];
  assert.equal(plan.type, 'setup_plan'); assert.equal(plan.status, 'pending');
  assert.match(plan.description, /1\. Create project "New flat"[\s\S]*2\. Create task "Sign the lease" in project "New flat"/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?').get(wsOf(u)).n, before, 'dry run left nothing behind');
  const ok = await u.c.post(`/api/ai/assistant/proposals/${plan.id}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.result.created.length, 5);
  const proj = db.prepare("SELECT id FROM projects WHERE workspace_id = ? AND name = 'New flat'").get(wsOf(u));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = ?').get(proj.id).n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM goal_milestones m JOIN goals g ON g.id = m.goal_id WHERE g.title = 'Settled by spring'").get().n, 1);
  assert.equal((await u.c.post(`/api/ai/assistant/proposals/${plan.id}/approve`)).status, 409, 'cannot run twice');
});

test('setup_plan is all-or-nothing: one bad step rejects the whole plan at proposal time, and unknown refs fail', async () => {
  const u = await signUp(srv.base, 'PlanBad');
  const before = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?').get(wsOf(u)).n;
  reset([{ type: 'final', answer: 'x', proposals: [
    { type: 'setup_plan', args: { title: 'Bad', steps: [{ ref: 'p', type: 'create_project', args: { name: 'Half' } }, { type: 'create_task', args: { project_id: '@p', title: 't', priority: 'nonsense' } }] } },
    { type: 'setup_plan', args: { title: 'Bad ref', steps: [{ type: 'create_task', args: { project_id: '@nope', title: 't' } }] } },
    { type: 'setup_plan', args: { title: 'Nested', steps: [{ type: 'setup_plan', args: { title: 'x', steps: [] } }] } },
  ] }]);
  const res = (await u.c.post('/api/ai/assistant/chat', { message: 'go' })).json;
  assert.equal(res.message.proposals.length, 0);
  assert.equal(res.dropped.length, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?').get(wsOf(u)).n, before);
});

test('create_automation via the assistant needs approval, then schedules a flow owned by the approver', async () => {
  const u = await signUp(srv.base, 'AutoAI');
  const p = (await u.c.post('/api/projects', { name: 'Home' })).json;
  reset([{ type: 'final', answer: 'I can do that weekly.', proposals: [{ type: 'create_automation', args: { name: 'Monday review',
    trigger: { type: 'schedule', frequency: 'weekly', weekday: 1, time: '08:30', timezone: 'Europe/Bucharest' },
    steps: [{ type: 'create_task', args: { project_id: p.id, title: 'Weekly review {{date}}', due_in_days: 2 } }, { type: 'notify', args: { title: 'Review task created' } }] } }] }]);
  const res = (await u.c.post('/api/ai/assistant/chat', { message: 'review every monday' })).json;
  const prop = res.message.proposals[0];
  assert.equal(prop.type, 'create_automation');
  assert.equal((await u.c.get('/api/automations')).json.length, 0, 'nothing exists before approval');
  assert.equal((await u.c.post(`/api/ai/assistant/proposals/${prop.id}/approve`)).status, 200);
  const list = (await u.c.get('/api/automations')).json;
  assert.equal(list.length, 1); assert.equal(list[0].created_via, 'assistant'); assert.match(list[0].summary, /Every Monday at 08:30/); assert.ok(list[0].next_run_at);
});

test('automation API: validation, permissions and isolation', async () => {
  const u = await signUp(srv.base, 'AutoApi');
  const p = (await u.c.post('/api/projects', { name: 'P' })).json;
  const good = { name: 'Daily', trigger: { type: 'schedule', frequency: 'daily', time: '07:00', timezone: 'UTC' }, steps: [{ type: 'notify', args: { title: 'Hi' } }] };
  for (const bad of [{ ...good, name: '' }, { ...good, trigger: { type: 'schedule', frequency: 'hourly', time: '07:00' } }, { ...good, trigger: { ...good.trigger, time: '25:00' } },
    { ...good, trigger: { ...good.trigger, timezone: 'Mars/Base' } }, { ...good, steps: [] }, { ...good, steps: [{ type: 'delete_everything', args: {} }] },
    { ...good, steps: [{ type: 'create_task', args: { project_id: 'nope', title: 't' } }] }, { ...good, steps: [{ type: 'update_task', args: { status: 'done' } }] },
    { ...good, steps: [{ type: 'notify', args: { title: 'x', link: 'https://evil.example' } }] }, { ...good, steps: Array(11).fill({ type: 'notify', args: { title: 'x' } }) }]) {
    assert.equal((await u.c.post('/api/automations', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  const made = await u.c.post('/api/automations', good);
  assert.equal(made.status, 201);
  const other = await signUp(srv.base, 'AutoOther');
  assert.equal((await other.c.get(`/api/automations/${made.json.id}`)).status, 404, 'foreign workspace cannot see it');
  assert.equal((await other.c.del(`/api/automations/${made.json.id}`)).status, 404);
  const off = await u.c.patch(`/api/automations/${made.json.id}`, { enabled: false });
  assert.equal(off.json.enabled, false); assert.equal(off.json.next_run_at, null);
  assert.equal((await u.c.patch(`/api/automations/${made.json.id}`, { enabled: true })).json.next_run_at !== null, true);
  assert.equal((await u.c.del(`/api/automations/${made.json.id}`)).status, 204);
  void p;
});

test('scheduler: a due flow runs once as its owner, is idempotent, advances, and a long-missed slot is skipped', async () => {
  const u = await signUp(srv.base, 'Sched');
  const w = wsOf(u);
  const p = (await u.c.post('/api/projects', { name: 'Chores' })).json;
  const a = (await u.c.post('/api/automations', { name: 'Morning', trigger: { type: 'schedule', frequency: 'daily', time: '09:00', timezone: 'UTC' },
    steps: [{ type: 'create_task', args: { project_id: p.id, title: 'Plan {{weekday}} ({{date}})', due_in_days: 1, priority: 'high' } }, { type: 'notify', args: { title: 'Plan ready', link: '/tasks' } }] })).json;
  const slot = new Date(a.next_run_at);
  const now = new Date(slot.getTime() + 60_000);
  const runsOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?').get(id).n;
  await runDue(now);
  assert.equal(runsOf(a.id), 1);
  await runDue(now);
  assert.equal(runsOf(a.id), 1, 'the same slot never runs twice');
  const card = db.prepare("SELECT c.title, c.priority, c.creator FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = ?").get(p.id);
  assert.match(card.title, /^Plan \w+day \(\d{4}-\d{2}-\d{2}\)$/); assert.equal(card.priority, 'high'); assert.equal(card.creator, 'Sched');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND kind = 'automation'").get(w).n, 1);
  const after = (await u.c.get(`/api/automations/${a.id}`)).json;
  assert.ok(Date.parse(after.next_run_at) > now.getTime()); assert.equal(after.last_status, 'ok'); assert.equal(after.runs[0].log.length, 2);
  // server was down for 3 days: skipped, not replayed
  db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(new Date(now.getTime() - 3 * 86400_000).toISOString(), a.id);
  await runDue(now);
  assert.equal((await u.c.get(`/api/automations/${a.id}`)).json.runs[0].status, 'skipped');
  // a one-off finishes and switches itself off
  const once = (await u.c.post('/api/automations', { name: 'Once', trigger: { type: 'schedule', frequency: 'once', date: iso(1), time: '10:00', timezone: 'UTC' }, steps: [{ type: 'notify', args: { title: 'One time' } }] })).json;
  await runDue(new Date(Date.parse(once.next_run_at) + 1000));
  const done = (await u.c.get(`/api/automations/${once.id}`)).json;
  assert.equal(done.enabled, false); assert.equal(done.next_run_at, null);
});

test('event flow: completing a high-priority task runs the flow; other tasks do not; run-now is for schedules only', async () => {
  const u = await signUp(srv.base, 'Event');
  const p = (await u.c.post('/api/projects', { name: 'Work' })).json;
  const col = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const flow = (await u.c.post('/api/automations', { name: 'Celebrate', trigger: { type: 'event', event: 'task_done', conditions: { priority: 'high' } },
    steps: [{ type: 'add_comment', args: { text: 'Well done: {{trigger.title}}' } }, { type: 'create_task', args: { project_id: p.id, title: 'Follow up on {{trigger.title}}', due_in_days: 3 } }] })).json;
  const hi = (await u.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'Ship it', priority: 'high' })).json;
  const lo = (await u.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'Tidy desk', priority: 'low' })).json;
  await u.c.patch(`/api/cards/${lo.id}`, { status: 'done' });
  await u.c.patch(`/api/cards/${hi.id}`, { status: 'done' });
  await settle();
  const comments = db.prepare('SELECT text, card_id FROM comments').all().filter((c) => [hi.id, lo.id].includes(c.card_id));
  assert.deepEqual(comments.map((c) => c.text), ['Well done: Ship it']);
  assert.ok(db.prepare("SELECT 1 FROM cards WHERE title = 'Follow up on Ship it'").get());
  assert.equal(db.prepare("SELECT 1 FROM cards WHERE title = 'Follow up on Tidy desk'").get(), undefined);
  // reopening and completing again is a new completion, but the same completion never runs twice
  assert.equal((await u.c.get(`/api/automations/${flow.id}`)).json.runs.length, 1);
  assert.equal((await u.c.post(`/api/automations/${flow.id}/run`)).status, 400);
  // transaction trigger with an amount condition
  const tf = (await u.c.post('/api/automations', { name: 'Big spend', trigger: { type: 'event', event: 'transaction_added', conditions: { type: 'expense', min_amount_minor: 100000 } },
    steps: [{ type: 'notify', args: { title: 'Big expense: {{trigger.amount}} {{trigger.currency}}', link: '/finance' } }] })).json;
  await u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 5000, currency: 'EUR', date: iso(0) });
  await u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 250000, currency: 'EUR', date: iso(0), description: 'Laptop' });
  await settle();
  const notes = db.prepare("SELECT title FROM notifications WHERE kind = 'automation' AND title LIKE 'Big expense%'").all();
  assert.deepEqual(notes.map((n) => n.title), ['Big expense: 2500.00 EUR']);
  void tf;
});

test('run now executes a scheduled flow as its owner; viewers cannot create flows; a demoted owner skips', async () => {
  const owner = await signUp(srv.base, 'RunNow');
  const p = (await owner.c.post('/api/projects', { name: 'R' })).json;
  const f = (await owner.c.post('/api/automations', { name: 'Manual', trigger: { type: 'schedule', frequency: 'daily', time: '06:00', timezone: 'UTC' }, steps: [{ type: 'create_task', args: { project_id: p.id, title: 'Ran now' } }] })).json;
  const r = await owner.c.post(`/api/automations/${f.id}/run`);
  assert.equal(r.status, 200); assert.equal(r.json.status, 'ok');
  assert.ok(db.prepare("SELECT 1 FROM cards WHERE title = 'Ran now'").get());
  // shared workspace: viewer cannot create, and a member who is demoted to viewer no longer runs their flow
  const sw = (await owner.c.post('/api/workspaces', { name: 'Team' })).json;
  const member = await signUp(srv.base, 'Mem');
  const inv = await owner.c.post(`/api/workspaces/${sw.id}/invitations`, { email: member.email, role: 'member' });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  assert.equal((await member.c.post('/api/invitations/accept', { token: inv.json.token })).status, 200);
  member.c.useWorkspace(sw.id); owner.c.useWorkspace(sw.id);
  const sp = (await owner.c.post('/api/projects', { name: 'Shared' })).json;
  const trig = { type: 'schedule', frequency: 'daily', time: '06:00', timezone: 'UTC' };
  const mf = await member.c.post('/api/automations', { name: 'Mine', trigger: trig, steps: [{ type: 'create_task', args: { project_id: sp.id, title: 'Member flow' } }] });
  assert.equal(mf.status, 201);
  assert.equal((await owner.c.get(`/api/automations/${mf.json.id}`)).status, 200, 'visible to workspace members');
  db.prepare('UPDATE workspace_members SET role = ? WHERE user_id = ? AND workspace_id = ?').run('viewer', member.user.id, sw.id);
  assert.equal((await member.c.post('/api/automations', { name: 'x', trigger: trig, steps: [{ type: 'notify', args: { title: 'x' } }] })).status, 403);
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(mf.json.id);
  await runDue(new Date(Date.parse(row.next_run_at) + 1000));
  assert.equal(db.prepare("SELECT 1 FROM cards WHERE title = 'Member flow'").get(), undefined, 'no longer allowed to write');
  assert.equal((await owner.c.get(`/api/automations/${mf.json.id}`)).json.runs[0].status, 'skipped');
});

const iso = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

test('schedule maths: weekly, monthly, weekdays, once, and DST keeps wall-clock time', () => {
  const t = { type: 'schedule', timezone: 'Europe/Bucharest', time: '09:00' };
  assert.equal(nextRunAt({ ...t, frequency: 'weekly', weekday: 1 }, new Date('2027-03-03T12:00:00Z')), '2027-03-08T07:00:00.000Z');
  assert.equal(nextRunAt({ ...t, frequency: 'daily' }, new Date('2027-03-27T12:00:00Z')), '2027-03-28T06:00:00.000Z', 'DST switch: 09:00 local is 06:00 UTC after the change');
  assert.equal(nextRunAt({ ...t, frequency: 'monthly', day: 15 }, new Date('2027-01-20T00:00:00Z')), '2027-02-15T07:00:00.000Z');
  assert.equal(nextRunAt({ ...t, frequency: 'weekdays' }, new Date('2027-03-05T12:00:00Z')), '2027-03-08T07:00:00.000Z', 'Friday afternoon -> Monday');
  assert.equal(nextRunAt({ ...t, frequency: 'once', date: '2020-01-01' }, new Date('2027-01-01T00:00:00Z')), null);
});
