// The dashboard arrangement: rules fallback, AI choice validated, live adjustment, caching, refresh limit, per-person plans.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp } from './helpers.js';

let srv, ai; let calls = 0; let reply = null;
before(async () => {
  ai = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    calls += 1; res.setHeader('content-type', 'application/json');
    if (reply === 'fail') { res.statusCode = 500; return res.end('{}'); }
    res.end(JSON.stringify({ choices: [{ message: { content: typeof reply === 'function' ? reply(JSON.parse(b)) : reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }); });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  srv = await startServer();
});
after(() => { srv.close(); ai.close(); });

const iso = (d) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
const byId = (plan) => Object.fromEntries(plan.widgets.map((w) => [w.id, w]));
async function workspace(name) {
  const u = await signUp(srv.base, name);
  const p = (await u.c.post('/api/projects', { name: 'Home' })).json;
  const col = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const mk = (title, extra = {}) => u.c.post(`/api/cards/columns/${col.id}/cards`, { title, ...extra });
  return { u, p, mk };
}
const aiOn = () => Object.assign(process.env, { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: `http://127.0.0.1:${ai.address().port}` });
const aiOff = () => { delete process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_BASE_URL; };

test('rules: a new workspace starts with the first project; overdue work takes the room; quiet widgets are compact; nothing disappears', async () => {
  aiOff();
  const empty = await signUp(srv.base, 'DashEmpty');
  const e = (await empty.c.get('/api/dashboard/plan')).json;
  assert.equal(e.source, 'rules'); assert.equal(e.ai_available, false);
  assert.equal(e.widgets.length, 12); assert.deepEqual(e.widgets.map((w) => w.id).sort(), ['activity', 'areas', 'attention', 'briefing', 'challenges', 'events', 'goals', 'habits', 'ideas', 'money', 'projects', 'today']);
  assert.equal(byId(e).projects.size, 'hero'); assert.match(byId(e).projects.reason, /start here/i);
  assert.equal(byId(e).attention.size, 'compact');

  const { u, mk } = await workspace('DashBusy');
  await mk('late one', { due_date: iso(-9) }); await mk('late two', { due_date: iso(-2) }); await mk('today', { due_date: iso(0) });
  const d = (await u.c.get('/api/dashboard')).json;
  assert.equal(d.counts.overdueTasks, 2); assert.equal(d.counts.dueToday, 1);
  assert.equal(d.overdueList[0].title, 'late one'); assert.equal(d.dueTodayList[0].title, 'today');
  const b = (await u.c.get('/api/dashboard/plan')).json;
  assert.equal(b.widgets[0].id, 'attention'); assert.equal(b.widgets[0].size, 'hero');
  assert.match(b.widgets[0].reason, /2 tasks overdue/);
  assert.equal(b.widgets.filter((w) => w.size === 'hero').length, 2, 'at most two heroes');
  assert.equal(byId(b).money.size, 'compact'); assert.equal(byId(b).events.size, 'compact');
  assert.match(b.headline, /2 tasks overdue and 1 due today/);
  assert.equal(byId(b).briefing.size, 'compact'); assert.match(byId(b).briefing.reason, /not set up/, 'no AI on the server: the briefing does not take room');
});

test('ai: the model decides, its answer is validated, numbers must come from the data, empty widgets stay compact', async () => {
  aiOn(); calls = 0;
  const { u, mk } = await workspace('DashAi');
  await mk('late', { due_date: iso(-4) });
  reply = JSON.stringify({ headline: 'You have 2 tasks overdue and 99 due today.', widgets: [
    { id: 'projects', size: 'hero', reason: 'Fresh start' },
    { id: 'events', size: 'hero', reason: 'Nothing here but I want it big' },
    { id: 'attention', size: 'hero', reason: '1 task overdue, 77 days old' },
    { id: 'nonsense', size: 'hero', reason: 'x' }, { id: 'attention', size: 'compact', reason: 'dup' },
    { id: 'activity', size: 'enormous', reason: 'odd size' },
  ] });
  const p = (await u.c.get('/api/dashboard/plan')).json;
  assert.equal(calls, 1); assert.equal(p.source, 'ai');
  assert.deepEqual(p.widgets.slice(0, 3).map((w) => w.id), ['projects', 'events', 'attention'], 'the model\'s order is kept');
  assert.equal(p.widgets.length, 12, 'unknown and duplicate ids dropped, missing widgets added');
  const m = byId(p);
  assert.equal(m.events.size, 'compact', 'no events: cannot be bigger than compact');
  assert.equal(m.projects.size, 'hero'); assert.equal(m.attention.size, 'hero');
  assert.equal(m.projects.reason, 'Fresh start');
  assert.match(m.attention.reason, /1 task overdue, the oldest since/, 'a reason with numbers not in the data is replaced by the plain one');
  assert.doesNotMatch(p.headline, /99/); assert.match(p.headline, /overdue/);
  assert.ok(['hero', 'normal', 'compact'].includes(m.activity.size));
  // cached for the day: no second model call, and the prompt carried data only as data
  await u.c.get('/api/dashboard/plan'); assert.equal(calls, 1);
});

test('ai: reasons that only use real numbers are kept; heroes are capped; unreadable output and outages fall back to rules', async () => {
  aiOn();
  const { u, mk } = await workspace('DashCap');
  await mk('a', { due_date: iso(-1) }); await mk('b', { due_date: iso(0) });
  reply = JSON.stringify({ headline: 'Quiet start with 1 overdue.', widgets: ['attention', 'today', 'projects', 'briefing'].map((id) => ({ id, size: 'hero', reason: id === 'attention' ? '1 overdue task' : 'Matters today' })) });
  const p = (await u.c.get('/api/dashboard/plan')).json;
  assert.equal(p.widgets.filter((w) => w.size === 'hero').length, 2);
  assert.equal(byId(p).attention.reason, '1 overdue task'); assert.equal(p.headline, 'Quiet start with 1 overdue.');

  const second = await workspace('DashJunk'); reply = 'not json at all';
  const j = (await second.u.c.get('/api/dashboard/plan')).json;
  assert.equal(j.source, 'rules'); assert.equal(j.widgets.length, 12);
  const third = await workspace('DashDown'); reply = 'fail';
  assert.equal((await third.u.c.get('/api/dashboard/plan')).json.source, 'rules');
});

test('live adjustment: a plan made earlier today shrinks widgets that emptied and grows ones that gained content', async () => {
  aiOn();
  const { u, mk } = await workspace('DashLive');
  reply = JSON.stringify({ headline: 'Nothing to do.', widgets: WIDGETS_ALL.map((id) => ({ id, size: id === 'projects' ? 'hero' : 'normal', reason: 'Fine' })) });
  const first = (await u.c.get('/api/dashboard/plan')).json;
  assert.equal(byId(first).attention.size, 'compact', 'empty at the time');
  await mk('suddenly late', { due_date: iso(-1) });
  const later = (await u.c.get('/api/dashboard/plan')).json;
  assert.equal(later.source, 'ai'); assert.equal(later.adjusted, true);
  assert.notEqual(byId(later).attention.size, 'compact', 'a new overdue task is not hidden by an older plan');
  assert.match(byId(later).attention.reason, /1 task overdue/);
});
const WIDGETS_ALL = ['today', 'attention', 'events', 'habits', 'goals', 'challenges', 'money', 'ideas', 'briefing', 'projects', 'areas', 'activity'];

test('refresh: five rearrangements a day, per person, viewers only get the rules', async () => {
  aiOn(); reply = JSON.stringify({ headline: 'Calm.', widgets: WIDGETS_ALL.map((id) => ({ id, size: 'normal', reason: 'ok' })) });
  const { u } = await workspace('DashRefresh');
  const first = (await u.c.get('/api/dashboard/plan')).json; assert.equal(first.refreshes_left, 5);
  let last;
  for (let i = 0; i < 5; i += 1) { last = await u.c.post('/api/dashboard/plan/refresh'); assert.equal(last.status, 200); }
  assert.equal(last.json.refreshes_left, 0);
  const over = await u.c.post('/api/dashboard/plan/refresh'); assert.equal(over.status, 429); assert.match(over.json.error, /5 times a day/);
  const other = await signUp(srv.base, 'DashOther'); assert.equal((await other.c.get('/api/dashboard/plan')).json.refreshes_left, 5, 'limits and plans are per person');
  assert.equal((await u.c.get('/api/dashboard/plan')).json.refreshes_left, 0, 'reading never costs a refresh');
});

test('the whole life: habits, goals, challenges, ideas and money show up in the data and shape the arrangement', async () => {
  aiOff();
  const { u } = await workspace('DashLife');
  const empty = (await u.c.get('/api/dashboard')).json;
  assert.deepEqual([empty.habits, empty.challenges, empty.goals, empty.money], [[], [], [], null]); assert.equal(empty.ideas.total, 0);
  const h = (await u.c.post('/api/habits', { title: 'Walk' })).json;
  for (const d of [-3, -2, -1]) await u.c.put(`/api/habits/${h.id}/entries/${iso(d)}`, { done: true });
  const ch = await u.c.post('/api/habits/challenges', { title: 'Walk 6 days', habitId: h.id, start_date: iso(-3), end_date: iso(2) }); assert.equal(ch.status, 201, ch.text);
  assert.equal((await u.c.post('/api/goals', { title: 'Run a 10k', target_date: iso(12) })).status, 201);
  await u.c.post('/api/ideas', { text: 'Build a bird feeder' });
  await u.c.post('/api/finance/transactions', { type: 'expense', currency: 'EUR', date: iso(0), amount_minor: 4200, status: 'posted', description: 'Groceries' });
  const d = (await u.c.get('/api/dashboard')).json;
  assert.equal(d.habits[0].title, 'Walk'); assert.equal(d.habits[0].done_today, false); assert.equal(d.habits[0].streak, 3);
  assert.equal(d.challenges[0].title, 'Walk 6 days'); assert.equal(d.challenges[0].completed_days, 3); assert.equal(d.challenges[0].days_left, 2);
  assert.equal(d.goals[0].title, 'Run a 10k'); assert.equal(d.goals[0].days_left, 12);
  assert.equal(d.ideas.total, 1); assert.equal(d.ideas.latest[0].text, 'Build a bird feeder');
  assert.equal(d.money.currency, 'EUR'); assert.equal(d.money.spent_minor, 4200);
  const p = (await u.c.get('/api/dashboard/plan')).json; const m = byId(p);
  assert.notEqual(m.habits.size, 'compact'); assert.match(m.habits.reason, /streak/);
  assert.notEqual(m.challenges.size, 'compact'); assert.match(m.challenges.reason, /ending within 3 days/);
  assert.notEqual(m.goals.size, 'compact'); assert.match(m.goals.reason, /due within 30 days/);
  assert.notEqual(m.money.size, 'compact'); assert.notEqual(m.ideas.size, 'compact');
  await u.c.put(`/api/habits/${h.id}/entries/${iso(0)}`, { done: true });
  assert.match(byId((await u.c.get('/api/dashboard/plan')).json).habits.reason, /Every habit is done today/, 'ticking a habit changes the reason at once');
  const other = await signUp(srv.base, 'DashLifeOther');
  assert.deepEqual((await other.c.get('/api/dashboard')).json.habits, [], 'habits are personal');
});
