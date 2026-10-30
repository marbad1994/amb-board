import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp } from './helpers.js';

let srv, fake;
const prompts = [];

before(async () => {
  fake = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const m = JSON.parse(b).messages;
      prompts.push(m);
      const sys = m[0].content;
      const out = sys.includes('"accomplishments"') ? { headline: 'Weekly ok', accomplishments: ['x'], suggestions: ['y'] }
        : sys.includes('"pending_decisions"') ? { headline: 'Monthly ok', completed: [], next_steps: ['z'] } : { headline: 'other' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  srv = await startServer();
  process.env.DEEPSEEK_API_KEY = 'k';
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
});
after(() => srv.close() || fake.close());

const iso = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const today = iso(0);
const month = today.slice(0, 7);

async function world(label) {
  const u = await signUp(srv.base, label);
  const cats = (await u.c.get('/api/finance/categories')).json;
  const cat = (n) => cats.find((c) => c.name === n).id;
  const tx = (b) => u.c.post('/api/finance/transactions', { type: 'expense', currency: 'EUR', date: today, ...b });
  return { u, cat, tx };
}

test('monthly category budgets vs actual: parent covers sub-categories, refunds reduce, planned/voided/other currency excluded, statuses', async () => {
  const { u, cat, tx } = await world('MBud');
  const sub = (await u.c.post('/api/finance/categories', { name: 'Netflix', parentId: cat('Subscriptions') })).json;
  assert.equal((await u.c.put('/api/finance/budget', { month, categoryId: cat('Food'), currency: 'EUR', amount_minor: 50_000 })).status, 200);
  await u.c.put('/api/finance/budget', { month, categoryId: cat('Subscriptions'), currency: 'EUR', amount_minor: 3_000 });

  await tx({ amount_minor: 20_000, categoryId: cat('Food') });
  await tx({ amount_minor: 5_000, type: 'refund', categoryId: cat('Food') });
  await tx({ amount_minor: 99_999, categoryId: cat('Food'), status: 'planned' });
  await tx({ amount_minor: 700_000, categoryId: cat('Food'), currency: 'RON' });
  const voided = (await tx({ amount_minor: 40_000, categoryId: cat('Food') })).json;
  await u.c.del(`/api/finance/transactions/${voided.id}`);
  await tx({ amount_minor: 2_500, categoryId: sub.id });   // child of Subscriptions
  await tx({ amount_minor: 1_000, categoryId: sub.id });
  await tx({ amount_minor: 7_777, categoryId: cat('Pets') }); // not budgeted

  const b = (await u.c.get(`/api/finance/budget?month=${month}`)).json;
  const food = b.rows.find((r) => r.category === 'Food');
  assert.equal(food.actual_minor, 15_000, 'expense minus refund; planned, voided and RON excluded');
  assert.equal(food.remaining_minor, 35_000);
  assert.equal(food.used_pct, 30);
  assert.equal(food.status, 'ok');
  const subs = b.rows.find((r) => r.category === 'Subscriptions');
  assert.equal(subs.actual_minor, 3_500, 'sub-category spending counts toward the parent');
  assert.equal(subs.status, 'over');
  assert.deepEqual(b.unbudgeted.find((x) => x.currency === 'EUR').categories, [{ name: 'Pets', total_minor: 7_777 }]);
  assert.deepEqual(b.unbudgeted.find((x) => x.currency === 'RON').total_minor, 700_000, 'other currency reported separately');
  assert.equal(b.totals[0].budget_minor, 53_000);
  assert.equal(b.totals[0].actual_minor, 18_500);

  assert.equal((await u.c.put('/api/finance/budget', { month: '2027-13', categoryId: cat('Food'), currency: 'EUR', amount_minor: 1 })).status, 400);
  assert.equal((await u.c.put('/api/finance/budget', { month, categoryId: 'bogus', currency: 'EUR', amount_minor: 1 })).status, 400);
  assert.equal((await u.c.put('/api/finance/budget', { month, categoryId: cat('Food'), currency: 'EUR', amount_minor: -1 })).status, 400);
  const after = (await u.c.del(`/api/finance/budget?month=${month}&categoryId=${cat('Food')}&currency=EUR`)).json;
  assert.equal(after.rows.length, 1);
});

test('monthly budgets: owner/admin only to set; members read; workspaces isolated', async () => {
  const owner = await signUp(srv.base, 'MBOwner');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json;
  owner.c.useWorkspace(ws.id);
  const member = await signUp(srv.base, 'MBMember');
  const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: member.email, role: 'member' });
  await member.c.post('/api/invitations/accept', { token: inv.json.token });
  member.c.useWorkspace(ws.id);
  const food = (await owner.c.get('/api/finance/categories')).json.find((c) => c.name === 'Food').id;
  assert.equal((await member.c.put('/api/finance/budget', { month, categoryId: food, currency: 'EUR', amount_minor: 100 })).status, 403);
  assert.equal((await owner.c.put('/api/finance/budget', { month, categoryId: food, currency: 'EUR', amount_minor: 100 })).status, 200);
  assert.equal((await member.c.get(`/api/finance/budget?month=${month}`)).json.rows.length, 1);
  const stranger = await signUp(srv.base, 'MBStranger');
  assert.equal((await stranger.c.get(`/api/finance/budget?month=${month}`)).json.rows.length, 0);
  assert.equal((await stranger.c.put('/api/finance/budget', { month, categoryId: food, currency: 'EUR', amount_minor: 1 })).status, 400, 'foreign category is invalid');
});

test('savings goals and emergency fund: balances, overdraw blocked, progress, months of expenses covered', async () => {
  const { u, tx } = await world('Sav');
  assert.equal((await u.c.post('/api/finance/savings', { name: '', currency: 'EUR', target_minor: 100 })).status, 400);
  assert.equal((await u.c.post('/api/finance/savings', { name: 'x', currency: 'EURO', target_minor: 100 })).status, 400);
  assert.equal((await u.c.post('/api/finance/savings', { name: 'x', currency: 'EUR', target_minor: 0 })).status, 400);
  const trip = (await u.c.post('/api/finance/savings', { name: 'Holiday', currency: 'EUR', target_minor: 200_000, target_date: '2027-07-01' })).json;
  assert.equal(trip.balance_minor, 0); assert.equal(trip.progress, 0);
  await u.c.post(`/api/finance/savings/${trip.id}/entries`, { kind: 'deposit', amount_minor: 50_000 });
  let g = (await u.c.post(`/api/finance/savings/${trip.id}/entries`, { kind: 'deposit', amount_minor: 30_000 })).json;
  assert.equal(g.balance_minor, 80_000); assert.equal(g.progress, 40); assert.equal(g.remaining_minor, 120_000);
  assert.equal((await u.c.post(`/api/finance/savings/${trip.id}/entries`, { kind: 'withdrawal', amount_minor: 80_001 })).status, 400, 'cannot withdraw more than the balance');
  g = (await u.c.post(`/api/finance/savings/${trip.id}/entries`, { kind: 'withdrawal', amount_minor: 70_000 })).json;
  assert.equal(g.balance_minor, 10_000);
  assert.equal((await u.c.del(`/api/finance/savings/${trip.id}/entries/${g.entries.find((e) => e.kind === 'deposit' && e.amount_minor === 50_000).id}`)).status, 400, 'deleting that deposit would go negative');
  assert.equal((await u.c.post(`/api/finance/savings/${trip.id}/entries`, { kind: 'gift', amount_minor: 1 })).status, 400);

  // emergency fund: months covered = balance / average spending of the last 3 COMPLETE months (same currency)
  const first = `${month}-01`;
  const back = (n) => { const d = new Date(`${first}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
  for (const n of [1, 2, 3]) await tx({ amount_minor: 90_000, date: back(n) });
  await tx({ amount_minor: 500_000, date: back(5) });                       // too old, ignored
  await tx({ amount_minor: 900_000, date: back(1), currency: 'RON' });       // other currency, ignored
  const ef = (await u.c.post('/api/finance/savings', { name: 'Emergency fund', currency: 'EUR', target_minor: 540_000, is_emergency_fund: true })).json;
  const after = (await u.c.post(`/api/finance/savings/${ef.id}/entries`, { kind: 'deposit', amount_minor: 180_000 })).json;
  assert.equal(after.avg_monthly_expenses_minor, 90_000);
  assert.equal(after.months_covered, 2);
  const list = (await u.c.get('/api/finance/savings')).json;
  assert.equal(list[0].is_emergency_fund, true, 'emergency fund listed first');
  await u.c.patch(`/api/finance/savings/${trip.id}`, { archived: true });
  assert.equal((await u.c.get('/api/finance/savings')).json.length, 1);
  const other = await signUp(srv.base, 'SavOther');
  assert.deepEqual((await other.c.get('/api/finance/savings')).json, []);
  assert.equal((await other.c.post(`/api/finance/savings/${ef.id}/entries`, { kind: 'deposit', amount_minor: 1 })).status, 404);
});

test('debts: payments reduce the remaining balance, overpayment and bad input rejected, isolation', async () => {
  const { u } = await world('Debt');
  assert.equal((await u.c.post('/api/finance/debts', { name: 'Loan', currency: 'EUR', original_minor: 0 })).status, 400);
  assert.equal((await u.c.post('/api/finance/debts', { name: 'Loan', currency: 'EUR', original_minor: 1000, interest_rate_pct: 5000 })).status, 400);
  const d = (await u.c.post('/api/finance/debts', { name: 'Car loan', currency: 'EUR', original_minor: 1_000_000, interest_rate_pct: 4.5, min_payment_minor: 25_000 })).json;
  assert.equal(d.remaining_minor, 1_000_000); assert.equal(d.interest_rate_pct, 4.5);
  let r = (await u.c.post(`/api/finance/debts/${d.id}/payments`, { amount_minor: 250_000 })).json;
  assert.equal(r.remaining_minor, 750_000); assert.equal(r.paid_pct, 25);
  assert.equal((await u.c.post(`/api/finance/debts/${d.id}/payments`, { amount_minor: 750_001 })).status, 400, 'overpayment');
  r = (await u.c.post(`/api/finance/debts/${d.id}/payments`, { amount_minor: 750_000 })).json;
  assert.equal(r.remaining_minor, 0); assert.equal(r.paid_pct, 100);
  r = (await u.c.del(`/api/finance/debts/${d.id}/payments/${r.payments[0].id}`)).json;
  assert.equal(r.remaining_minor, 750_000, 'removing a payment restores the balance');
  const other = await signUp(srv.base, 'DebtOther');
  assert.deepEqual((await other.c.get('/api/finance/debts')).json, []);
  assert.equal((await other.c.post(`/api/finance/debts/${d.id}/payments`, { amount_minor: 1 })).status, 404);
  await u.c.patch(`/api/finance/debts/${d.id}`, { archived: true });
  assert.equal((await u.c.get('/api/finance/debts')).json.length, 0);
});

test('S-reminders: event reminder fires once inside its window, respects preferences and time zones', async () => {
  const { generateForWorkspace } = await import('../src/notifications/generate.js');
  const a = await signUp(srv.base, 'RemA');
  const ev = await a.c.post('/api/calendar/events', { title: 'Dentist', start_local: '2027-05-10T09:00', timezone: 'UTC', reminder_minutes: 30 });
  assert.equal(ev.status, 201); assert.equal(ev.json.reminder_minutes, 30);
  assert.equal((await a.c.post('/api/calendar/events', { title: 'x', start_local: '2027-05-10T09:00', timezone: 'UTC', reminder_minutes: -5 })).status, 400);
  assert.equal((await a.c.post('/api/calendar/events', { title: 'x', start_local: '2027-05-10T09:00', timezone: 'UTC', reminder_minutes: 'soon' })).status, 400);
  const count = () => a.c.get('/api/notifications').then((r) => r.json);

  assert.equal(generateForWorkspace(a.personalId, new Date('2027-05-10T08:20:00Z')), 0, 'too early');
  assert.equal(generateForWorkspace(a.personalId, new Date('2027-05-10T08:35:00Z')), 1);
  assert.equal(generateForWorkspace(a.personalId, new Date('2027-05-10T08:40:00Z')), 0, 'no duplicate on the next tick');
  assert.equal(generateForWorkspace(a.personalId, new Date('2027-05-10T08:35:00Z')), 0, 'idempotent');
  const n = await count();
  assert.equal(n.unread, 1);
  assert.equal(n.items[0].title, 'Dentist starts in 30 min');
  assert.equal(generateForWorkspace(a.personalId, new Date('2027-05-10T09:30:00Z')), 0, 'past the grace period nothing fires late');

  // time zone: 09:00 in Bucharest (UTC+3 in May) is 06:00Z, so the reminder window is 05:30Z
  await a.c.post('/api/calendar/events', { title: 'Call', start_local: '2027-05-11T09:00', timezone: 'Europe/Bucharest', reminder_minutes: 0 });
  assert.equal(generateForWorkspace(a.personalId, new Date('2027-05-11T05:59:00Z')), 0);
  assert.equal(generateForWorkspace(a.personalId, new Date('2027-05-11T06:01:00Z')), 1);
  assert.equal((await count()).items[0].title, 'Call starts now');

  // preferences: switch event reminders off, the next event notification is skipped
  assert.deepEqual((await a.c.put('/api/notifications/preferences', { event_reminders: false })).json, { event_reminders: false, task_due: true, budget_alerts: true, email: false, email_available: false });
  await a.c.post('/api/calendar/events', { title: 'Muted', start_local: '2027-05-12T09:00', timezone: 'UTC', reminder_minutes: 15 });
  assert.equal(generateForWorkspace(a.personalId, new Date('2027-05-12T08:50:00Z')), 0);
  assert.equal((await a.c.get('/api/notifications/preferences')).json.event_reminders, false);
});

test('notifications: task due/overdue once each, budget alert once per status; read state; privacy between users', async () => {
  const { generateForWorkspace } = await import('../src/notifications/generate.js');
  const owner = await signUp(srv.base, 'NotOwner');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json;
  owner.c.useWorkspace(ws.id);
  const viewer = await signUp(srv.base, 'NotViewer');
  const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: viewer.email, role: 'viewer' });
  await viewer.c.post('/api/invitations/accept', { token: inv.json.token });
  viewer.c.useWorkspace(ws.id);
  const stranger = await signUp(srv.base, 'NotStranger');

  const p = (await owner.c.post('/api/projects', { name: 'Reno' })).json;
  const col = (await owner.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const mk = async (title, due) => (await owner.c.post(`/api/cards/columns/${col.id}/cards`, { title, due_date: due })).json;
  await mk('due today', today); await mk('overdue', iso(-2)); await mk('ancient', iso(-30)); await mk('future', iso(5));
  assert.equal(generateForWorkspace(ws.id), 4, '2 tasks x 2 members; ancient and future ignored');
  assert.equal(generateForWorkspace(ws.id), 0, 'second run creates nothing');

  await owner.c.put(`/api/projects/${p.id}/budget`, { currency: 'EUR', approved_minor: 1000 });
  await owner.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 900, currency: 'EUR', date: today, projectId: p.id });
  assert.equal(generateForWorkspace(ws.id), 2, 'warning (90% >= 80%)');
  await owner.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 200, currency: 'EUR', date: today, projectId: p.id });
  assert.equal(generateForWorkspace(ws.id), 2, 'status changed to over: notify again');
  assert.equal(generateForWorkspace(ws.id), 0);

  const v = (await viewer.c.get('/api/notifications')).json;
  assert.equal(v.items.length, 4); assert.equal(v.unread, 4);
  assert.ok(v.items.some((n) => n.title === 'Reno is over budget'));
  assert.equal((await stranger.c.get('/api/notifications')).json.items.length, 0);
  assert.equal((await stranger.c.post(`/api/notifications/${v.items[0].id}/read`)).json.unread, 0, 'cannot touch someone else\'s notification');
  assert.equal((await viewer.c.get('/api/notifications')).json.unread, 4);

  // viewers may mark their own notifications read (it is not a content write)
  let r = (await viewer.c.post(`/api/notifications/${v.items[0].id}/read`)).json;
  assert.equal(r.unread, 3);
  r = (await viewer.c.post('/api/notifications/read-all')).json;
  assert.equal(r.unread, 0);
  assert.equal((await owner.c.get('/api/notifications')).json.unread, 4, 'owner\'s own state unaffected');
  assert.equal((await viewer.c.post('/api/notifications/refresh')).status, 200);
  // workspace scoping: the owner's personal workspace has none of these
  const personal = (await owner.c.get('/api/notifications', { 'x-workspace-id': owner.personalId })).json;
  assert.equal(personal.items.length, 0);
});

test('S13 weekly and monthly reviews: grounded facts, per-user cache, no cross-user habits, no journal or notes, no mixed currencies', async () => {
  prompts.length = 0;
  const a = await signUp(srv.base, 'RevA'); const b = await signUp(srv.base, 'RevB');
  const p = (await a.c.post('/api/projects', { name: 'Review project' })).json;
  const col = (await a.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const c1 = (await a.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'Finished thing' })).json;
  await a.c.patch(`/api/cards/${c1.id}`, { status: 'done' });
  await a.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'Open thing', due_date: today });
  await a.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 1234, currency: 'EUR', date: today });
  await a.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 999, currency: 'RON', date: today });
  const h = (await a.c.post('/api/habits', { title: 'AHABIT-A-ONLY' })).json;
  await b.c.post('/api/habits', { title: 'BHABIT-B-ONLY' });
  await a.c.put(`/api/habits/${h.id}/entries/${today}`, { done: true });
  await a.c.post('/api/notes', { kind: 'journal', body: 'JOURNAL-CANARY-5521' });
  await a.c.post('/api/notes', { title: 'NOTE-CANARY-5521', body: 'x' });

  const w = await a.c.post('/api/ai/review/weekly', {});
  assert.equal(w.status, 200);
  assert.equal(w.json.summary.content.headline, 'Weekly ok');
  const f = w.json.summary.facts;
  assert.deepEqual(f.completed_tasks.map((t) => t.title), ['Finished thing']);
  assert.deepEqual(f.incomplete_tasks_due_in_period.map((t) => t.title), ['Open thing']);
  assert.deepEqual(f.finance_posted.map((x) => [x.currency, x.expenses_minor]).sort(), [['EUR', 1234], ['RON', 999]], 'currencies kept apart');
  assert.deepEqual(f.habits.map((x) => [x.title, x.completions]), [['AHABIT-A-ONLY', 1]]);
  assert.equal(f.period.kind, 'weekly');
  const everything = JSON.stringify(prompts);
  assert.ok(!/CANARY/.test(everything), 'journal and notes never reach the model');
  assert.ok(!/BHABIT/.test(everything), 'another user\'s habit never reaches the model');

  const calls = prompts.length;
  assert.equal((await a.c.post('/api/ai/review/weekly', {})).json.summary.cached, true);
  assert.equal(prompts.length, calls, 'unchanged facts: no new provider call');
  const wb = await b.c.post('/api/ai/review/weekly', {});
  assert.equal(wb.json.summary.facts.habits[0].title, 'BHABIT-B-ONLY');
  assert.ok(!JSON.stringify(wb.json.summary.facts).includes('AHABIT'), 'per-user review');

  const m = await a.c.post('/api/ai/review/monthly', {});
  assert.equal(m.json.summary.content.headline, 'Monthly ok');
  assert.ok(Array.isArray(m.json.summary.facts.budget_performance.rows));
  assert.ok('finance_previous_month' in m.json.summary.facts);
  const old = await a.c.post(`/api/ai/review/weekly?date=2020-01-08`, {});
  assert.equal(old.json.summary.facts.period.start, '2020-01-06', 'any past week by date (Monday start)');
  assert.deepEqual(old.json.summary.facts.completed_tasks, []);
  assert.equal((await a.c.get('/api/ai/review/yearly')).status, 404);
  assert.equal((await a.c.get('/api/ai/review/weekly?date=nope')).status, 400);
});

test('assistant read tools expose month budgets, savings and debts from the caller\'s workspace only', async () => {
  const { runTool } = await import('../src/ai/tools.js');
  const { db } = await import('../src/db.js');
  const { u, cat } = await world('ToolFin');
  await u.c.put('/api/finance/budget', { month, categoryId: cat('Food'), currency: 'EUR', amount_minor: 4200 });
  await u.c.post('/api/finance/savings', { name: 'ToolFin fund', currency: 'EUR', target_minor: 5000 });
  const ws = db.prepare('SELECT workspace_id AS w FROM workspace_members WHERE user_id = ?').get(u.user.id).w;
  assert.equal(runTool('month_budget', { month }, ws).rows[0].budget_minor, 4200);
  assert.equal(runTool('list_savings_and_debts', {}, ws).savings[0].name, 'ToolFin fund');
  const other = await signUp(srv.base, 'ToolFinO');
  const ows = db.prepare('SELECT workspace_id AS w FROM workspace_members WHERE user_id = ?').get(other.user.id).w;
  assert.equal(runTool('month_budget', { month }, ows).rows.length, 0);
  assert.deepEqual(runTool('list_savings_and_debts', {}, ows), { savings: [], debts: [] });
});
