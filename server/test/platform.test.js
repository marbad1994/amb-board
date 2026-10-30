// Analysis skills, reports, extra write skills, suggestions and MCP. The AI provider is MOCKED (scripted).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp, client } from './helpers.js';

let srv, fake;
let analyzeSpending, analyzeWorkload, projectHealth, findGaps, crossReference; // imported after the server so the temp database is used
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
      res.end(JSON.stringify({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }], usage: {} }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  srv = await startServer();
  process.env.DEEPSEEK_API_KEY = 'k';
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  ({ analyzeSpending, analyzeWorkload, projectHealth, findGaps, crossReference } = await import('../src/ai/analysis.js'));
});
after(() => srv.close() || fake.close());
const reset = (s = []) => { requests.length = 0; script = s; };

const iso = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const today = iso(0);
const ws = async (u) => (await import('../src/db.js')).db.prepare('SELECT workspace_id AS w FROM workspace_members WHERE user_id = ?').get(u.user.id).w;

async function world(label) {
  const u = await signUp(srv.base, label);
  const p = (await u.c.post('/api/projects', { name: `${label} project` })).json;
  const col = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const card = (await u.c.post(`/api/cards/columns/${col.id}/cards`, { title: `${label} task`, due_date: '2020-01-01' })).json;
  const ask = (message, extra = {}) => u.c.post('/api/ai/assistant/chat', { message, ...extra });
  return { u, p, col, card, ask, w: await ws(u) };
}

test('analysis: spending vs prior average with unusual flag; workload; project health; gaps (all deterministic)', async () => {
  const { u, p, w } = await world('Ana');
  const cats = (await u.c.get('/api/finance/categories')).json;
  const food = cats.find((c) => c.name === 'Food').id;
  const mk = (b) => u.c.post('/api/finance/transactions', { type: 'expense', currency: 'EUR', ...b });
  const back = (n) => { const d = new Date(`${today.slice(0, 7)}-15T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
  for (const n of [1, 2, 3]) await mk({ amount_minor: 30_000, date: back(n), categoryId: food });
  await mk({ amount_minor: 60_000, date: today, categoryId: food });
  await mk({ amount_minor: 1_000, date: today });                       // uncategorised
  await mk({ amount_minor: 9_999_00, date: today, currency: 'RON' });   // never mixed with EUR
  const a = analyzeSpending(w, {}, today);
  const eur = a.currencies.find((c) => c.currency === 'EUR');
  const f = eur.categories.find((c) => c.category === 'Food');
  assert.deepEqual([f.current_minor, f.prior_monthly_average_minor, f.change_pct, f.unusual], [60_000, 30_000, 100, true]);
  assert.deepEqual(eur.unusual, ['Food']);
  assert.equal(a.uncategorised_expenses_last_30_days, 2, 'EUR 10.00 and RON 9999.00 both lack a category');
  assert.equal(a.currencies.find((c) => c.currency === 'RON').categories[0].current_minor, 999_900);
  assert.equal(a.top_expenses_this_month[0].currency, 'RON');

  await u.c.post('/api/calendar/events', { title: 'a', start_local: `${iso(2)}T09:00`, timezone: 'UTC' });
  await u.c.post('/api/calendar/events', { title: 'b', start_local: `${iso(2)}T11:00`, timezone: 'UTC' });
  await u.c.post('/api/calendar/events', { title: 'c', start_local: `${iso(2)}T15:00`, timezone: 'UTC' });
  await u.c.patch(`/api/projects/${p.id}`, { target_date: iso(2) });
  const wl = analyzeWorkload(w, { days: 7 }, today);
  assert.equal(wl.days.length, 7);
  assert.deepEqual(wl.heavy_days, [iso(2)]);
  assert.equal(wl.days[2].appointments, 3);
  assert.equal(wl.overdue_now, 1);
  assert.equal(wl.busiest_days[0], iso(2));

  const h = projectHealth(w, {}, today)[0];
  assert.equal(h.name, 'Ana project');
  assert.ok(h.reasons.some((r) => /overdue/.test(r)));
  assert.ok(['medium', 'high'].includes(h.risk));
  const gaps = findGaps(w, {}, today);
  assert.equal(gaps.projects_without_budget_but_with_spending, 0);
  assert.equal(gaps.uncategorised_expenses_last_90_days, 2);
  assert.equal(gaps.current_month_without_category_budget, true);
});

test('cross_reference links everything about a project/goal/task, hides private notes, and refuses foreign ids', async () => {
  const a = await world('Xref'); const b = await world('XrefB');
  const goal = (await a.u.c.post('/api/goals', { title: 'Home goal' })).json;
  await a.u.c.put(`/api/goals/${goal.id}/projects/${a.p.id}`);
  await a.u.c.post('/api/notes', { title: 'Shared note', body: 'x', projectId: a.p.id });
  await a.u.c.post('/api/notes', { title: 'Private note', body: 'x', projectId: a.p.id, privacy: 'private' });
  await a.u.c.post('/api/calendar/events', { title: 'Site visit', start_local: '2027-01-01T10:00', timezone: 'UTC', projectId: a.p.id });
  await a.u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 500, currency: 'EUR', date: today, projectId: a.p.id, description: 'Paint' });
  const r = crossReference(a.w, { entity: 'project', id: a.p.id }, a.u.user.id);
  assert.equal(r.tasks.length, 1); assert.equal(r.goals[0].title, 'Home goal'); assert.equal(r.events[0].title, 'Site visit');
  assert.equal(r.transactions[0].description, 'Paint');
  assert.deepEqual(r.notes.map((n) => n.title), ['Shared note'].concat(['Private note']), 'the author sees their own private note');
  const other = crossReference(a.w, { entity: 'project', id: a.p.id }, b.u.user.id);
  assert.deepEqual(other.notes.map((n) => n.title), ['Shared note'], 'another user does not');
  assert.equal(crossReference(b.w, { entity: 'project', id: a.p.id }, b.u.user.id).error, 'project not found');
  assert.equal(crossReference(b.w, { entity: 'goal', id: goal.id }, b.u.user.id).error, 'goal not found');
  assert.equal(crossReference(b.w, { entity: 'task', id: a.card.id }, b.u.user.id).error, 'task not found');
  assert.equal(crossReference(a.w, { entity: 'task', id: a.card.id }, a.u.user.id).project.name, 'Xref project');
});

test('reports: standalone HTML (no scripts, no external resources), figures from the app, escaping, privacy', async () => {
  const { u, p, col } = await world('Rep');
  await u.c.patch(`/api/projects/${p.id}`, { name: 'Reno <script>alert(1)</script> & "co"', target_date: iso(30), start_date: iso(-30) });
  await u.c.put(`/api/projects/${p.id}/budget`, { currency: 'EUR', approved_minor: 1_000_000 });
  await u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 250_000, currency: 'EUR', date: today, projectId: p.id, description: '<img src=x onerror=alert(1)>Sofa' });
  await u.c.post('/api/notes', { kind: 'journal', body: 'JOURNAL-CANARY-7741' });
  await u.c.post('/api/notes', { title: 'PRIV-NOTE-CANARY-7741', body: 'x', privacy: 'private' });
  const h = (await u.c.post('/api/habits', { title: 'Meditate' })).json;
  await u.c.put(`/api/habits/${h.id}/entries/${today}`, { done: true });

  for (const kind of ['overview', 'monthly_finance', 'workload']) {
    const r = await u.c.post('/api/reports', { kind });
    assert.equal(r.status, 201, `${kind}: ${r.text}`);
    const doc = (await u.c.get(`/api/reports/${r.json.id}`)).json.html;
    assert.match(doc, /^<!doctype html>/);
    assert.ok(!/<script/i.test(doc), `${kind}: no script tags`);
    assert.ok(!/(src|href)\s*=\s*["']?https?:/i.test(doc) && !/@import|url\(/i.test(doc), `${kind}: nothing loaded from outside`);
    assert.match(doc, /Content-Security-Policy" content="default-src 'none'/);
    assert.ok(!/CANARY/.test(doc), `${kind}: journal and private notes never included`);
    assert.ok(/<svg/.test(doc) || kind === 'overview', `${kind}: charts are inline SVG`);
  }
  const ps = await u.c.post('/api/reports', { kind: 'project_status', project_id: p.id });
  const html = (await u.c.get(`/api/reports/${ps.json.id}`)).json.html;
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x'), 'hostile names and descriptions are escaped');
  assert.match(html, /Reno &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;co&quot;/);
  assert.match(html, /€10,000\.00/); assert.match(html, /€2,500\.00/); assert.match(html, /€7,500\.00/, 'approved, spent and remaining come from the finance code');
  assert.match(html, /<svg[^>]*role="img"/);
  assert.equal((await u.c.post('/api/reports', { kind: 'project_status', project_id: 'nope' })).status, 404);

  const custom = await u.c.post('/api/reports', { sections: ['kpis', 'goals', 'habits', 'savings_debts', 'trend', 'spending_analysis', 'budget_vs_actual', 'finance_month', 'events', 'overdue_tasks', 'projects'], title: 'My <b>custom</b> report' });
  assert.equal(custom.status, 201);
  assert.equal(custom.json.title, 'My <b>custom</b> report', 'title stored as text');
  const chtml = (await u.c.get(`/api/reports/${custom.json.id}`)).json.html;
  assert.match(chtml, /<title>My &lt;b&gt;custom&lt;\/b&gt; report<\/title>/);
  assert.match(chtml, /Meditate/);
  assert.equal((await u.c.post('/api/reports', { kind: 'nonsense' })).status, 400);
  assert.equal((await u.c.post('/api/reports', { sections: ['kpis', 'drop_table'] })).status, 400);
  assert.equal((await u.c.post('/api/reports', { kind: 'monthly_finance', month: '2027-13' })).status, 400);

  const dl = await u.c.get(`/api/reports/${custom.json.id}/download`);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="My-bcustomb-report\.html"$/);
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await u.c.get('/api/reports')).json.items.length, 5);
  assert.equal(col.name, 'Backlog');
});

test('reports: private to their creator (even in a shared workspace), isolated across workspaces, writers only', async () => {
  const owner = await signUp(srv.base, 'RepOwner');
  const wsx = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json;
  owner.c.useWorkspace(wsx.id);
  const viewer = await signUp(srv.base, 'RepViewer');
  const inv = await owner.c.post(`/api/workspaces/${wsx.id}/invitations`, { email: viewer.email, role: 'viewer' });
  await viewer.c.post('/api/invitations/accept', { token: inv.json.token }); viewer.c.useWorkspace(wsx.id);
  await owner.c.post('/api/projects', { name: 'OwnerSecretProject' });
  const r = (await owner.c.post('/api/reports', { kind: 'overview' })).json;
  assert.equal((await viewer.c.post('/api/reports', { kind: 'overview' })).status, 403);
  assert.equal((await viewer.c.get(`/api/reports/${r.id}`)).status, 404);
  assert.equal((await viewer.c.get(`/api/reports/${r.id}/download`)).status, 404);
  assert.equal((await viewer.c.del(`/api/reports/${r.id}`)).status, 403, 'viewers cannot write at all');
  assert.deepEqual((await viewer.c.get('/api/reports')).json.items, []);
  const stranger = await signUp(srv.base, 'RepStranger');
  await stranger.c.post('/api/projects', { name: 'Strange' });
  const sr = (await stranger.c.post('/api/reports', { kind: 'overview' })).json;
  const html = (await stranger.c.get(`/api/reports/${sr.id}`)).json.html;
  assert.ok(!html.includes('OwnerSecretProject'), 'a report only contains its own workspace');
  assert.equal((await owner.c.del(`/api/reports/${r.id}`)).status, 204);
});

test('report commentary: written by the AI, clearly labelled, optional, and failure does not break the report', async () => {
  const { u, p } = await world('RepAi');
  reset([{ commentary: 'Spending is on track. <b>Nice</b>' }]);
  const r = (await u.c.post('/api/reports', { kind: 'project_status', project_id: p.id, narrative: true })).json;
  assert.equal(r.narrative, true);
  const html = (await u.c.get(`/api/reports/${r.id}`)).json.html;
  assert.match(html, /<h2>AI commentary<\/h2><p>Spending is on track\. &lt;b&gt;Nice&lt;\/b&gt;<\/p>/);
  assert.match(html, /figures themselves are calculated by the application/);
  assert.ok(/<data>/.test(requests[0][1].content) && !/RepAi project.*password/.test(requests[0][1].content));
  reset(['not json']);
  const r2 = (await u.c.post('/api/reports', { kind: 'project_status', project_id: p.id, narrative: true })).json;
  assert.equal(r2.narrative, false);
  assert.ok(!(await u.c.get(`/api/reports/${r2.id}`)).json.html.includes('AI commentary'));
  reset([]);
  assert.equal((await u.c.post('/api/reports', { kind: 'overview' })).status, 201);
  assert.equal(requests.length, 0, 'no provider call unless narrative is requested');
});

test('assistant: current_view context is verified, analysis and report skills run, the report artifact is returned', async () => {
  const a = await world('Ctx'); const b = await world('CtxB');
  reset([{ type: 'tool', calls: [{ tool: 'project_health', args: {} }, { tool: 'generate_report', args: { kind: 'project_status', project_id: a.p.id, title: 'Status for Ctx' } }] },
    { type: 'final', answer: 'Report is ready under Reports.', proposals: [] }]);
  const res = await a.ask('Make me a report on this project', { context: { page: 'project', id: a.p.id } });
  assert.equal(res.status, 200, res.text);
  const first = requests[0][1].content;
  assert.match(first, /"current_view":\{"page":"project","project":\{"id":"[^"]+","name":"Ctx project","status":"todo"\}\}/);
  assert.equal(res.json.message.artifacts.length, 1);
  assert.equal(res.json.message.artifacts[0].type, 'report');
  const rep = (await a.u.c.get(`/api/reports/${res.json.message.artifacts[0].id}`)).json;
  assert.equal(rep.title, 'Status for Ctx');
  assert.ok(requests[1][1].content.includes('"risk"'), 'analysis result reached the model');
  const conv = (await a.u.c.get(`/api/ai/assistant/conversations/${res.json.conversationId}`)).json;
  assert.equal(conv.messages[1].artifacts[0].id, rep.id, 'artifacts persist with the conversation');

  reset([{ type: 'final', answer: 'ok' }]);
  await b.ask('hi', { context: { page: 'project', id: a.p.id } });
  assert.ok(!requests[0][1].content.includes('Ctx project'), 'a foreign project id in the context is ignored');
  assert.match(requests[0][1].content, /"current_view":\{"page":"project"\}/);
  reset([{ type: 'final', answer: 'ok' }]);
  await b.ask('hi', { context: { page: '<script>' } });
  assert.match(requests[0][1].content, /"current_view":\{"page":"unknown"\}/);
  assert.match(requests[0][0].content, /generate_report/); assert.match(requests[0][0].content, /create_transaction/);
});

test('write skills: every new action is a pending proposal; approval executes it; invalid or foreign targets are dropped', async () => {
  const a = await world('Wr'); const b = await world('WrB');
  const goal = (await a.u.c.post('/api/goals', { title: 'Fit' })).json;
  const tx = (await a.u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 4200, currency: 'EUR', date: today, description: 'Lunch' })).json;
  await a.u.c.patch(`/api/cards/${a.card.id}`, { recurrence: 'weekly' });
  const area = (await a.u.c.get('/api/life-areas')).json[0];
  reset([{ type: 'final', answer: 'Plan ready', proposals: [
    { type: 'update_task', args: { task_id: a.card.id, status: 'done', priority: 'high', owner: 'Marcus', labels: ['urgent'] } },
    { type: 'add_subtask', args: { task_id: a.card.id, title: 'Call supplier' } },
    { type: 'add_comment', args: { task_id: a.card.id, text: 'Checked with the contractor' } },
    { type: 'create_transaction', args: { type: 'expense', amount: 25.5, currency: 'EUR', date: today, description: 'Taxi', category: 'transport', project_id: a.p.id } },
    { type: 'categorize_transaction', args: { transaction_id: tx.id, category: 'Food' } }] },
  { type: 'final', answer: 'More', proposals: [
    { type: 'create_goal', args: { title: 'Learn Romanian', target_date: '2027-12-01', life_area_id: area.id } },
    { type: 'add_milestone', args: { goal_id: goal.id, title: '5 km run', due_date: '2027-03-01' } },
    { type: 'create_note', args: { title: 'Ideas', body: 'from the assistant' } },
    { type: 'create_habit', args: { title: 'Stretch', frequency: 'weekly', target_per_week: 4 } }] }]);
  const r1 = (await a.ask('do things')).json.message.proposals;
  const r2 = (await a.ask('more things')).json.message.proposals;
  assert.equal(r1.length, 5); assert.equal(r2.length, 4);
  assert.match(r1[0].description, /status: to do -> done; priority: medium -> high/);
  assert.match(r1[3].description, /^Record expense of 25\.50 EUR on .*: "Taxi" \(Transport\), project "Wr project"$/);
  // nothing happened yet
  assert.equal((await a.u.c.get(`/api/cards/${a.card.id}`)).json.status, 'todo');
  assert.equal((await a.u.c.get('/api/finance/transactions')).json.total, 1);
  assert.equal((await a.u.c.get('/api/goals')).json.length, 1);
  assert.equal((await a.u.c.get('/api/notes')).json.length, 0);
  assert.equal((await a.u.c.get('/api/habits')).json.length, 0);

  for (const p of [...r1, ...r2]) assert.equal((await a.u.c.post(`/api/ai/assistant/proposals/${p.id}/approve`)).status, 200, p.description);
  const card = (await a.u.c.get(`/api/cards/${a.card.id}`)).json;
  assert.equal(card.status, 'done'); assert.equal(card.priority, 'high'); assert.equal(card.owner, 'Marcus'); assert.deepEqual(card.labels, ['urgent']);
  assert.ok(card.completed_at);
  assert.equal(card.subtasks[0].title, 'Call supplier'); assert.equal(card.comments[0].author, a.u.user.name);
  const cards = (await a.u.c.get(`/api/projects/${a.p.id}/columns`)).json[0].cards;
  assert.equal(cards.length, 2, 'completing a recurring task through a proposal spawns the next occurrence');
  const txs = (await a.u.c.get('/api/finance/transactions')).json.items;
  assert.equal(txs.find((t) => t.description === 'Taxi').amount_minor, 2550);
  assert.equal(txs.find((t) => t.description === 'Taxi').category_name, 'Transport');
  assert.equal(txs.find((t) => t.description === 'Lunch').category_name, 'Food');
  assert.equal((await a.u.c.get('/api/goals')).json.find((g) => g.title === 'Fit').milestones[0].title, '5 km run');
  assert.equal((await a.u.c.get('/api/notes')).json[0].privacy, 'workspace');
  assert.equal((await b.u.c.get('/api/notes')).json.length, 0);
  assert.equal((await a.u.c.get('/api/habits')).json[0].target_per_week, 4);

  reset([{ type: 'final', answer: 'x', proposals: [
    { type: 'update_task', args: { task_id: b.card.id, status: 'done' } },
    { type: 'update_task', args: { task_id: a.card.id } },
    { type: 'update_task', args: { task_id: a.card.id, status: 'finished' } },
    { type: 'create_transaction', args: { type: 'transfer', amount: 5, currency: 'EUR' } },
    { type: 'create_transaction', args: { type: 'expense', amount: 1.234, currency: 'EUR' } }] },
  { type: 'final', answer: 'x', proposals: [
    { type: 'create_transaction', args: { type: 'expense', amount: 5, currency: 'EUR', category: 'Nonexistent' } },
    { type: 'create_transaction', args: { type: 'expense', amount: -5, currency: 'EUR' } },
    { type: 'categorize_transaction', args: { transaction_id: tx.id, category: 'Nope' } },
    { type: 'add_comment', args: { task_id: b.card.id, text: 'foreign' } },
    { type: 'add_milestone', args: { goal_id: 'bogus', title: 'x' } }] }]);
  const bad1 = (await a.ask('bad')).json; const bad2 = (await a.ask('bad2')).json;
  assert.equal(bad1.message.proposals.length + bad2.message.proposals.length, 0);
  assert.equal(bad1.dropped.length, 5); assert.equal(bad2.dropped.length, 5);
  assert.equal((await b.u.c.get(`/api/cards/${b.card.id}`)).json.status, 'todo');
});

test('suggestions: proactive, explainable, context-aware, dismissible, role-aware, workspace-scoped', async () => {
  const empty = await signUp(srv.base, 'SugEmpty');
  let s = (await empty.c.get('/api/ai/assistant/suggestions')).json.suggestions;
  assert.equal(s[0].key, 'first-project'); assert.equal(s[0].action.type, 'ask');

  const { u, p, col } = await world('Sug');
  const mk = (title, extra) => u.c.post(`/api/cards/columns/${col.id}/cards`, { title, ...extra });
  for (let i = 0; i < 5; i++) await mk(`undated ${i}`);
  await u.c.put(`/api/projects/${p.id}/budget`, { currency: 'EUR', approved_minor: 1000 });
  await u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 1500, currency: 'EUR', date: today, projectId: p.id });
  const habit = (await u.c.post('/api/habits', { title: 'Stretch' })).json;
  s = (await u.c.get('/api/ai/assistant/suggestions')).json.suggestions;
  const keys = s.map((x) => x.key);
  assert.ok(keys.includes('overdue-tasks')); assert.ok(keys.some((k) => k.startsWith('budget:')));
  assert.ok(keys.includes('habits-today'));
  assert.ok(s.every((x) => x.why && x.title && x.action && typeof x.priority === 'number'), 'every suggestion explains itself');
  assert.ok(s.length <= 6);
  assert.deepEqual(s.map((x) => x.priority), [...s.map((x) => x.priority)].sort((a, b) => b - a));
  const budget = s.find((x) => x.key.startsWith('budget:'));
  assert.match(budget.action.prompt, /Do not change the budget/);

  const ctx = (await u.c.get(`/api/ai/assistant/suggestions?context=project:${p.id}`)).json.suggestions;
  assert.ok(ctx.some((x) => x.key === `ctx:undated:${p.id}`), 'page context adds project-specific suggestions');
  assert.ok(!s.some((x) => x.key.startsWith('ctx:')));

  assert.equal((await u.c.post('/api/ai/assistant/suggestions/dismiss', { key: 'overdue-tasks', days: 7 })).status, 204);
  assert.ok(!(await u.c.get('/api/ai/assistant/suggestions')).json.suggestions.some((x) => x.key === 'overdue-tasks'));
  assert.equal((await u.c.post('/api/ai/assistant/suggestions/dismiss', {})).status, 400);
  await u.c.put(`/api/habits/${habit.id}/entries/${today}`, { done: true });
  assert.ok(!(await u.c.get('/api/ai/assistant/suggestions')).json.suggestions.some((x) => x.key === 'habits-today'), 'resolved suggestions disappear on their own');

  // viewers do not get "ask the assistant to change things" prompts; others never see this workspace's data
  const owner = await signUp(srv.base, 'SugOwner');
  const wsx = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json; owner.c.useWorkspace(wsx.id);
  const viewer = await signUp(srv.base, 'SugViewer');
  const inv = await owner.c.post(`/api/workspaces/${wsx.id}/invitations`, { email: viewer.email, role: 'viewer' });
  await viewer.c.post('/api/invitations/accept', { token: inv.json.token }); viewer.c.useWorkspace(wsx.id);
  const vs = (await viewer.c.get('/api/ai/assistant/suggestions')).json.suggestions;
  assert.ok(vs.every((x) => x.action.type === 'link'), 'viewers only get navigation suggestions');
  const stranger = await signUp(srv.base, 'SugStranger');
  assert.ok(!JSON.stringify((await stranger.c.get('/api/ai/assistant/suggestions')).json).includes('Sug project'));
});

test('skills catalogue lists every read/analysis/report skill and every approval-gated write skill', async () => {
  const u = await signUp(srv.base, 'Cat');
  const c = (await u.c.get('/api/ai/assistant/skills')).json;
  const names = c.read.map((s) => s.name);
  for (const n of ['list_tasks', 'get_project', 'analyze_spending', 'analyze_workload', 'project_health', 'find_gaps', 'cross_reference', 'generate_report', 'month_budget']) assert.ok(names.includes(n), n);
  assert.equal(c.read.find((s) => s.name === 'generate_report').kind, 'report');
  assert.ok(c.write.every((w) => w.requires_approval === true && w.arguments));
  assert.ok(c.write.length >= 13);
  for (const forbidden of ['set_budget', 'change_role', 'create_journal_entry', 'send_email', 'create_token', 'invite_member']) assert.ok(!c.write.some((w) => w.name === forbidden), forbidden);
});

// ---------------------------------------------------------------- MCP
const rpc = (token, method, params, id = 1) => fetch(`${srv.base}/api/mcp`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
}).then(async (r) => ({ status: r.status, json: r.status === 204 ? null : await r.json() }));
const call = (token, name, args) => rpc(token, 'tools/call', { name, arguments: args }).then((r) => ({ ...r, data: r.json?.result ? JSON.parse(r.json.result.content[0].text) : null }));

test('MCP: tokens are shown once and stored hashed; unauthenticated, wrong and revoked tokens are refused', async () => {
  const u = await signUp(srv.base, 'McpTok');
  assert.equal((await u.c.post('/api/tokens', { name: '' })).status, 400);
  const t = (await u.c.post('/api/tokens', { name: 'Claude Desktop' })).json;
  assert.match(t.token, /^amb_pat_/);
  const { db } = await import('../src/db.js');
  const row = db.prepare('SELECT token_hash, prefix FROM api_tokens WHERE id = ?').get(t.id);
  assert.notEqual(row.token_hash, t.token); assert.equal(row.prefix, t.token.slice(0, 12));
  const list = (await u.c.get('/api/tokens')).json;
  assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).includes(t.token), 'the secret is never listed');

  assert.equal((await rpc(null, 'initialize', {})).status, 401);
  assert.equal((await rpc('amb_pat_wrongwrongwrongwrongwrong', 'initialize', {})).status, 401);
  assert.equal((await rpc('not-a-token', 'initialize', {})).status, 401);
  const init = await rpc(t.token, 'initialize', {});
  assert.equal(init.json.result.serverInfo.name, 'amb-board');
  assert.ok(init.json.result.capabilities.tools);
  assert.equal((await rpc(t.token, 'ping', {})).status, 200);
  assert.ok((await u.c.get('/api/tokens')).json[0].last_used_at);
  assert.equal((await u.c.del(`/api/tokens/${t.id}`)).status, 204);
  assert.equal((await rpc(t.token, 'initialize', {})).status, 401, 'revoked');
  assert.equal((await rpc(t.token, 'bogus', {})).status, 401);
  const bad = await rpc((await u.c.post('/api/tokens', { name: 'x' })).json.token, 'no/such/method', {});
  assert.equal(bad.json.error.code, -32601);
  for (let i = 0; i < 9; i++) await u.c.post('/api/tokens', { name: `t${i}` });
  assert.equal((await u.c.post('/api/tokens', { name: 'too many' })).status, 400);
  const stranger = await signUp(srv.base, 'McpTokO');
  assert.deepEqual((await stranger.c.get('/api/tokens')).json, []);
});

test('MCP: tools/list exposes the same skills; read/analysis/report skills run scoped to the token workspace; writes only create proposals', async () => {
  const a = await world('Mcp'); const b = await world('McpB');
  const token = (await a.u.c.post('/api/tokens', { name: 'cli' })).json.token;
  const list = (await rpc(token, 'tools/list', {})).json.result.tools.map((t) => t.name);
  for (const n of ['list_tasks', 'analyze_spending', 'generate_report', 'cross_reference', 'propose_create_task', 'propose_update_task', 'propose_create_transaction']) assert.ok(list.includes(n), n);
  assert.ok(!list.some((n) => /delete|budget_set|set_budget|role|email/.test(n)), 'no dangerous tools exist');

  const tasks = await call(token, 'list_tasks', { view: 'overdue' });
  assert.deepEqual(tasks.data.map((t) => t.title), ['Mcp task']);
  assert.equal((await call(token, 'get_project', { project_id: b.p.id })).data.error, 'project not found', 'only the token workspace');
  assert.equal((await call(token, 'cross_reference', { entity: 'task', id: b.card.id })).data.error, 'task not found');
  const health = await call(token, 'project_health', {});
  assert.equal(health.data[0].name, 'Mcp project');
  const rep = await call(token, 'generate_report', { kind: 'overview', title: 'Via MCP' });
  assert.ok(rep.data.report_id);
  assert.equal((await a.u.c.get(`/api/reports/${rep.data.report_id}`)).json.title, 'Via MCP');
  assert.equal((await b.u.c.get(`/api/reports/${rep.data.report_id}`)).status, 404);
  assert.equal((await call(token, 'delete_project', { id: a.p.id })).data.error, 'unknown tool');

  const before = (await a.u.c.get(`/api/projects/${a.p.id}/columns`)).json[0].cards.length;
  const prop = await call(token, 'propose_create_task', { project_id: a.p.id, title: 'From MCP', due_date: '2027-04-01' });
  assert.equal(prop.data.status, 'pending_approval');
  assert.equal((await a.u.c.get(`/api/projects/${a.p.id}/columns`)).json[0].cards.length, before, 'nothing changed yet');
  const bad = await call(token, 'propose_create_task', { project_id: b.p.id, title: 'x' });
  assert.equal(bad.json.result.isError, true); assert.equal(bad.data.error, 'unknown project');
  assert.equal((await call(token, 'propose_set_budget', { project_id: a.p.id })).data.error, 'unknown tool');

  const convs = (await a.u.c.get('/api/ai/assistant/conversations')).json;
  const conv = (await a.u.c.get(`/api/ai/assistant/conversations/${convs.find((c) => c.title === 'External assistant (MCP)').id}`)).json;
  const pid = conv.messages[0].proposals[0].id;
  assert.match(conv.messages[0].proposals[0].description, /Create task "From MCP"/);
  assert.equal((await b.u.c.post(`/api/ai/assistant/proposals/${pid}/approve`)).status, 404, 'only the token owner can approve');
  assert.equal((await a.u.c.post(`/api/ai/assistant/proposals/${pid}/approve`)).status, 200);
  assert.equal((await a.u.c.get(`/api/projects/${a.p.id}/columns`)).json[0].cards.length, before + 1);
});

test('MCP: a token is bound to its workspace and its owner\'s CURRENT role (demotion, removal, viewers)', async () => {
  const owner = await signUp(srv.base, 'McpOwner');
  const wsx = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json; owner.c.useWorkspace(wsx.id);
  const member = await signUp(srv.base, 'McpMember');
  const inv = await owner.c.post(`/api/workspaces/${wsx.id}/invitations`, { email: member.email, role: 'member' });
  await member.c.post('/api/invitations/accept', { token: inv.json.token }); member.c.useWorkspace(wsx.id);
  const p = (await owner.c.post('/api/projects', { name: 'SharedMcp' })).json;
  const token = (await member.c.post('/api/tokens', { name: 'shared' })).json.token;           // bound to the shared workspace
  const personalToken = (await member.c.post('/api/tokens', { name: 'mine' }, { 'x-workspace-id': member.personalId })).json.token;
  assert.equal((await call(token, 'list_projects', {})).data[0].name, 'SharedMcp');
  assert.deepEqual((await call(personalToken, 'list_projects', {})).data, [], 'a personal-workspace token cannot see the shared workspace');
  await owner.c.patch(`/api/workspaces/${wsx.id}/members/${member.user.id}`, { role: 'viewer' });
  const denied = await call(token, 'propose_create_task', { project_id: p.id, title: 'x' });
  assert.match(denied.data.error, /viewers cannot propose/);
  assert.equal((await call(token, 'list_projects', {})).data[0].name, 'SharedMcp', 'viewers may still read');
  await owner.c.del(`/api/workspaces/${wsx.id}/members/${member.user.id}`);
  assert.equal((await rpc(token, 'tools/list', {})).status, 401, 'removed from the workspace: the token stops working');
  assert.equal((await rpc(personalToken, 'tools/list', {})).status, 200);
});
