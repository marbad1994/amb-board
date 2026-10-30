import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const today = new Date().toISOString().slice(0, 10);
async function setup(label) {
  const u = await signUp(srv.base, label);
  const project = (await u.c.post('/api/projects', { name: 'Apartment Renovation' })).json;
  const cats = (await u.c.get('/api/finance/categories')).json;
  const furniture = cats.find((c) => c.name === 'Furniture').id;
  const tx = (body) => u.c.post('/api/finance/transactions', { type: 'expense', currency: 'EUR', date: today, projectId: project.id, ...body });
  const metrics = async () => (await u.c.get(`/api/projects/${project.id}/finance`)).json.budget;
  const budget = (approved_minor, extra = {}) => u.c.put(`/api/projects/${project.id}/budget`, { currency: 'EUR', approved_minor, ...extra });
  return { u, project, furniture, tx, metrics, budget };
}

test('S8-S10 Example B: expense linked to a project updates actual, remaining and dashboards', async () => {
  const { u, furniture, tx, metrics, budget } = await setup('FinB');
  assert.equal((await metrics()).has_budget, false);
  assert.equal((await budget(1_200_000)).status, 200);
  const created = await tx({ amount_minor: 250_000, categoryId: furniture, description: 'Sofa' });
  assert.equal(created.status, 201);
  assert.equal(created.json.project_name, 'Apartment Renovation');
  const m = await metrics();
  assert.equal(m.actual_minor, 250_000);
  assert.equal(m.remaining_minor, 950_000);
  assert.equal(m.used_pct, 20.8);
  assert.equal(m.status, 'ok');
  const summary = (await u.c.get(`/api/finance/summary?month=${today.slice(0, 7)}`)).json;
  const eur = summary.currencies.find((c) => c.currency === 'EUR');
  assert.equal(eur.expenses_minor, 250_000);
  assert.equal(eur.net_cashflow_minor, -250_000);
  assert.deepEqual(eur.categories, [{ name: 'Furniture', total_minor: 250_000 }]);
  assert.equal((await u.c.get('/api/dashboard')).json.budgetAlerts.length, 0);
});

test('Example D: forecast uses planned commitments; overrun reported; approved budget is never changed automatically', async () => {
  const { u, tx, metrics, budget } = await setup('FinD');
  await budget(1_000_000);
  await tx({ amount_minor: 700_000 });
  await tx({ amount_minor: 400_000, status: 'planned', description: 'committed' });
  const m = await metrics();
  assert.equal(m.actual_minor, 700_000);
  assert.equal(m.remaining_minor, 300_000);
  assert.equal(m.planned_minor, 400_000);
  assert.equal(m.forecast_minor, 1_100_000);
  assert.equal(m.forecast_overrun_minor, 100_000);
  assert.equal(m.status, 'forecast_over');
  assert.equal(m.approved_minor, 1_000_000, 'approved budget untouched');
  const alerts = (await u.c.get('/api/dashboard')).json.budgetAlerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].status, 'forecast_over');
});

test('refunds reduce spending; transfers, income, voided and planned rows never count as actual; alert thresholds', async () => {
  const { u, tx, metrics, budget, project } = await setup('FinR');
  await budget(100_000, { alert_pct: 50 });
  await tx({ amount_minor: 60_000 });
  assert.equal((await metrics()).status, 'warning', '60% >= 50% threshold');
  await tx({ amount_minor: 10_000, type: 'refund' });
  assert.equal((await metrics()).actual_minor, 50_000);
  await tx({ amount_minor: 99_999, type: 'income' });
  const voided = (await tx({ amount_minor: 40_000 })).json;
  assert.equal((await metrics()).actual_minor, 90_000);
  assert.equal((await u.c.del(`/api/finance/transactions/${voided.id}`)).status, 204);
  assert.equal((await metrics()).actual_minor, 50_000, 'voided transaction excluded');
  const a1 = (await u.c.post('/api/finance/accounts', { name: 'Main', currency: 'EUR' })).json;
  const a2 = (await u.c.post('/api/finance/accounts', { name: 'Savings', currency: 'EUR', kind: 'savings' })).json;
  const bad = await u.c.post('/api/finance/transactions', { type: 'transfer', amount_minor: 5_000, currency: 'EUR', date: today, projectId: project.id, accountId: a1.id, toAccountId: a2.id });
  assert.equal(bad.status, 400, 'transfers cannot belong to a project');
  assert.equal((await u.c.post('/api/finance/transactions', { type: 'transfer', amount_minor: 5_000, currency: 'EUR', date: today, accountId: a1.id, toAccountId: a1.id })).status, 400);
  assert.equal((await u.c.post('/api/finance/transactions', { type: 'transfer', amount_minor: 5_000, currency: 'EUR', date: today, accountId: a1.id, toAccountId: a2.id })).status, 201);
  const eur = (await u.c.get(`/api/finance/summary?month=${today.slice(0, 7)}`)).json.currencies[0];
  assert.equal(eur.expenses_minor, 50_000, 'transfer is not an expense');
  assert.equal(eur.income_minor, 99_999);
  await tx({ amount_minor: 60_000 });
  assert.equal((await metrics()).status, 'over');
});

test('S22 currencies are never silently added together', async () => {
  const { u, tx, metrics, budget } = await setup('FinFx');
  await budget(1_000_000);
  await tx({ amount_minor: 100_000 });
  await tx({ amount_minor: 5_000_000, currency: 'RON' });
  const m = await metrics();
  assert.equal(m.actual_minor, 100_000, 'RON is not folded into the EUR budget');
  assert.deepEqual(m.other_currencies, [{ currency: 'RON', actual_minor: 5_000_000, planned_minor: 0 }]);
  const cur = (await u.c.get(`/api/finance/summary?month=${today.slice(0, 7)}`)).json.currencies;
  assert.deepEqual(cur.map((c) => [c.currency, c.expenses_minor]).sort(), [['EUR', 100_000], ['RON', 5_000_000]]);
});

test('S21 duplicate external events do not create duplicate transactions', async () => {
  const { u, tx, metrics } = await setup('FinDup');
  const a = await tx({ amount_minor: 12_345, externalRef: 'bank:evt-1' });
  const b = await tx({ amount_minor: 12_345, externalRef: 'bank:evt-1' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);
  assert.equal(b.json.id, a.json.id);
  assert.equal((await metrics()).by_currency[0].actual_minor, 12_345);
  assert.equal((await u.c.get('/api/finance/transactions')).json.total, 1);
  // refs are scoped per workspace: another user may reuse the same string
  const other = await signUp(srv.base, 'FinDupOther');
  assert.equal((await other.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 1, currency: 'EUR', date: today, externalRef: 'bank:evt-1' })).status, 201);
});

test('validation: amounts, currencies, dates, foreign project/category', async () => {
  const { u, tx, project } = await setup('FinVal');
  for (const bad of [{ amount_minor: 0 }, { amount_minor: -5 }, { amount_minor: 12.5 }, { amount_minor: '100' }, { currency: 'EURO' }, { date: '2026-02-30' }, { type: 'gift' }, { status: 'maybe' }]) {
    assert.equal((await tx({ amount_minor: 100, ...bad })).status, 400, JSON.stringify(bad));
  }
  const other = await signUp(srv.base, 'FinValOther');
  const foreignProject = (await other.c.post('/api/projects', { name: 'theirs' })).json;
  const foreignCat = (await other.c.get('/api/finance/categories')).json[0];
  assert.equal((await tx({ amount_minor: 100, projectId: foreignProject.id })).status, 400);
  assert.equal((await tx({ amount_minor: 100, categoryId: foreignCat.id })).status, 400);
  assert.equal((await u.c.put(`/api/projects/${project.id}/budget`, { currency: 'EUR', approved_minor: -1 })).status, 400);
  assert.equal((await u.c.put(`/api/projects/${project.id}/budget`, { currency: 'eur!', approved_minor: 100 })).status, 400);
});

test('S17/S18 finance data is isolated; budget approval needs owner/admin; viewers cannot write', async () => {
  const owner = await signUp(srv.base, 'FinOwner');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Family' })).json;
  owner.c.useWorkspace(ws.id);
  const roles = {};
  for (const role of ['member', 'viewer']) {
    const u = await signUp(srv.base, `Fin${role}`);
    const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: u.email, role });
    await u.c.post('/api/invitations/accept', { token: inv.json.token });
    u.c.useWorkspace(ws.id);
    roles[role] = u;
  }
  const project = (await owner.c.post('/api/projects', { name: 'Shared' })).json;
  assert.equal((await owner.c.put(`/api/projects/${project.id}/budget`, { currency: 'EUR', approved_minor: 5000 })).status, 200);
  assert.equal((await roles.member.c.put(`/api/projects/${project.id}/budget`, { currency: 'EUR', approved_minor: 999999 })).status, 403, 'members cannot change the approved budget');
  const t = await roles.member.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 100, currency: 'EUR', date: today, projectId: project.id });
  assert.equal(t.status, 201, 'members can record spending');
  assert.equal((await roles.viewer.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 100, currency: 'EUR', date: today })).status, 403);
  assert.equal((await roles.viewer.c.get('/api/finance/transactions')).json.total, 1, 'viewers can read');

  const stranger = await signUp(srv.base, 'FinStranger');
  assert.equal((await stranger.c.get('/api/finance/transactions')).json.total, 0);
  assert.equal((await stranger.c.get(`/api/projects/${project.id}/finance`)).status, 404);
  assert.equal((await stranger.c.patch(`/api/finance/transactions/${t.json.id}`, { description: 'x' })).status, 404);
  assert.equal((await stranger.c.del(`/api/finance/transactions/${t.json.id}`)).status, 404);
});

test('recurring subscriptions create planned transactions once, month-end clamped, and re-running is a no-op', async () => {
  const u = await signUp(srv.base, 'FinRec');
  const start = new Date(Date.now() - 70 * 86400_000).toISOString().slice(0, 10);
  const r = await u.c.post('/api/finance/recurring', { description: 'Netflix', amount_minor: 1_299, currency: 'EUR', frequency: 'monthly', start_date: start, is_subscription: true });
  assert.equal(r.status, 201);
  const first = (await u.c.post('/api/finance/recurring/run')).json.created;
  assert.ok(first >= 2 && first <= 3, `created ${first} planned occurrences`);
  assert.equal((await u.c.post('/api/finance/recurring/run')).json.created, 0, 'idempotent');
  const list = (await u.c.get('/api/finance/transactions?status=planned')).json;
  assert.equal(list.total, first);
  assert.ok(list.items.every((t) => t.status === 'planned' && t.source === 'recurring' && t.description === 'Netflix'));
  const next = (await u.c.get('/api/finance/recurring')).json[0].next_date;
  assert.ok(next > today);
  // pure date logic: 31 Jan + monthly stays on month end
  const { nextOccurrence } = await import('../src/finance/money.js');
  assert.equal(nextOccurrence('2027-01-31', 'monthly', '2027-01-31'), '2027-02-28');
  assert.equal(nextOccurrence('2027-02-28', 'monthly', '2027-01-31'), '2027-03-31');
});

test('CSV export neutralises formula injection', async () => {
  const { u, tx } = await setup('FinCsv');
  await tx({ amount_minor: 1_000, description: '=HYPERLINK("http://evil","x")' });
  const res = await u.c.get('/api/finance/transactions/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.text, /'=HYPERLINK/);
  assert.ok(!/,=HYPERLINK/.test(res.text));
  assert.match(res.text.split('\n')[0], /^date,type,status,amount/);
});
