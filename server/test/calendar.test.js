import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const feed = async (u, from, to) => (await u.c.get(`/api/calendar?from=${from}&to=${to}`)).json;

test('S11-S12 project deadline and task due date appear on the calendar and follow changes', async () => {
  const u = await signUp(srv.base, 'CalA');
  const p = (await u.c.post('/api/projects', { name: 'Renovation' })).json;
  await u.c.patch(`/api/projects/${p.id}`, { target_date: '2026-12-15' });
  const col = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const card = (await u.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'Order tiles', due_date: '2026-12-10' })).json;

  let items = (await feed(u, '2026-12-01', '2026-12-31')).items;
  const deadline = items.find((i) => i.kind === 'project_deadline');
  assert.equal(deadline.date, '2026-12-15');
  assert.equal(deadline.project_id, p.id);
  assert.equal(items.find((i) => i.kind === 'task_due').date, '2026-12-10');

  // reschedule the task and the deadline: the calendar reflects it with no sync step
  await u.c.patch(`/api/cards/${card.id}`, { due_date: '2026-12-20' });
  await u.c.patch(`/api/projects/${p.id}`, { target_date: '2026-12-22' });
  items = (await feed(u, '2026-12-01', '2026-12-31')).items;
  assert.equal(items.find((i) => i.kind === 'task_due').date, '2026-12-20');
  assert.equal(items.find((i) => i.kind === 'project_deadline').date, '2026-12-22');

  // completed task is marked done; archived project disappears
  await u.c.patch(`/api/cards/${card.id}`, { status: 'done' });
  assert.equal((await feed(u, '2026-12-01', '2026-12-31')).items.find((i) => i.kind === 'task_due').done, true);
  await u.c.patch(`/api/projects/${p.id}`, { archived: true });
  assert.equal((await feed(u, '2026-12-01', '2026-12-31')).items.length, 0);
});

test('S23 weekly 09:00 Europe/Bucharest keeps wall-clock time across the DST change (UTC instant shifts)', async () => {
  const u = await signUp(srv.base, 'CalDst');
  const ev = await u.c.post('/api/calendar/events', { title: 'Standup', start_local: '2026-10-19T09:00', timezone: 'Europe/Bucharest', recurrence: 'weekly' });
  assert.equal(ev.status, 201);
  const items = (await feed(u, '2026-10-19', '2026-11-09')).items.filter((i) => i.source === 'event');
  assert.deepEqual(items.map((i) => i.date), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
  assert.ok(items.every((i) => i.start_local.endsWith('T09:00')), 'local time never changes');
  assert.deepEqual(items.map((i) => i.start_utc), [
    '2026-10-19T06:00:00.000Z', // EEST, UTC+3 (DST ends 25 Oct 2026)
    '2026-10-26T07:00:00.000Z', // EET, UTC+2
    '2026-11-02T07:00:00.000Z',
    '2026-11-09T07:00:00.000Z',
  ]);
  // same wall time in a different zone/date for spring-forward in New York (8 Mar 2026)
  const ny = await u.c.post('/api/calendar/events', { title: 'NY call', start_local: '2026-03-02T10:30', timezone: 'America/New_York', recurrence: 'weekly' });
  const nyItems = (await feed(u, '2026-03-02', '2026-03-16')).items.filter((i) => i.event_id === ny.json.id);
  assert.deepEqual(nyItems.map((i) => i.start_utc), ['2026-03-02T15:30:00.000Z', '2026-03-09T14:30:00.000Z', '2026-03-16T14:30:00.000Z']);
});

test('recurrence: monthly clamps month end, intervals and until are respected, all-day and multi-day events', async () => {
  const u = await signUp(srv.base, 'CalRec');
  const m = (await u.c.post('/api/calendar/events', { title: 'Rent due', start_local: '2027-01-31T08:00', timezone: 'UTC', recurrence: 'monthly' })).json;
  const dates = (await feed(u, '2027-01-01', '2027-04-01')).items.filter((i) => i.event_id === m.id).map((i) => i.date);
  assert.deepEqual(dates, ['2027-01-31', '2027-02-28', '2027-03-31']);
  const biw = (await u.c.post('/api/calendar/events', { title: 'Bi-weekly', start_local: '2027-01-04T12:00', timezone: 'UTC', recurrence: 'weekly', recurrence_interval: 2, recurrence_until: '2027-02-01' })).json;
  assert.deepEqual((await feed(u, '2027-01-01', '2027-03-01')).items.filter((i) => i.event_id === biw.id).map((i) => i.date), ['2027-01-04', '2027-01-18', '2027-02-01']);
  const trip = (await u.c.post('/api/calendar/events', { title: 'Trip', kind: 'personal', all_day: true, start_local: '2027-05-10', end_local: '2027-05-12', timezone: 'UTC' })).json;
  const tripItems = (await feed(u, '2027-05-11', '2027-05-20')).items.filter((i) => i.event_id === trip.id);
  assert.equal(tripItems.length, 1, 'multi-day event overlapping the window is included');
  assert.equal(tripItems[0].all_day, true);
  assert.equal(tripItems[0].kind, 'personal');
  assert.equal(tripItems[0].start_utc, null);
});

test('event validation and linking to own project/task only', async () => {
  const u = await signUp(srv.base, 'CalVal');
  const other = await signUp(srv.base, 'CalValOther');
  const base = { title: 'x', start_local: '2027-01-01T10:00', timezone: 'Europe/Bucharest' };
  for (const bad of [{ title: '' }, { timezone: 'Mars/Base' }, { start_local: '2027-01-01' }, { start_local: '2027-13-01T10:00' }, { end_local: '2027-01-01T09:00' },
    { recurrence: 'hourly' }, { recurrence_interval: 0 }, { kind: 'meeting' }, { recurrence_until: 'soon' }]) {
    assert.equal((await u.c.post('/api/calendar/events', { ...base, ...bad })).status, 400, JSON.stringify(bad));
  }
  const theirs = (await other.c.post('/api/projects', { name: 'theirs' })).json;
  assert.equal((await u.c.post('/api/calendar/events', { ...base, projectId: theirs.id })).status, 400);
  const mine = (await u.c.post('/api/projects', { name: 'mine' })).json;
  const ok = await u.c.post('/api/calendar/events', { ...base, projectId: mine.id });
  assert.equal(ok.status, 201);
  assert.equal((await feed(u, '2027-01-01', '2027-01-02')).items[0].project_name, 'mine');
  assert.equal((await u.c.get('/api/calendar?from=2027-01-01&to=2027-06-01')).status, 400, 'range capped');
  assert.equal((await u.c.get('/api/calendar?from=bad&to=2027-06-01')).status, 400);
});

test('S17/S18 calendar is isolated; viewers read but cannot create or edit events', async () => {
  const owner = await signUp(srv.base, 'CalOwner');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json;
  owner.c.useWorkspace(ws.id);
  const viewer = await signUp(srv.base, 'CalViewer');
  const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: viewer.email, role: 'viewer' });
  await viewer.c.post('/api/invitations/accept', { token: inv.json.token });
  viewer.c.useWorkspace(ws.id);
  const ev = (await owner.c.post('/api/calendar/events', { title: 'Dentist', start_local: '2027-02-01T10:00', timezone: 'UTC' })).json;
  assert.equal((await feed(viewer, '2027-02-01', '2027-02-01')).items.length, 1);
  assert.equal((await viewer.c.post('/api/calendar/events', { title: 'x', start_local: '2027-02-01T10:00', timezone: 'UTC' })).status, 403);
  assert.equal((await viewer.c.patch(`/api/calendar/events/${ev.id}`, { title: 'hacked' })).status, 403);
  assert.equal((await viewer.c.del(`/api/calendar/events/${ev.id}`)).status, 403);
  const stranger = await signUp(srv.base, 'CalStranger');
  assert.equal((await feed(stranger, '2027-02-01', '2027-02-01')).items.length, 0);
  assert.equal((await stranger.c.patch(`/api/calendar/events/${ev.id}`, { title: 'x' })).status, 404);
  assert.equal((await stranger.c.del(`/api/calendar/events/${ev.id}`)).status, 404);
});

test('Example C: a deadline day with several appointments is flagged as scheduling pressure (advice only)', async () => {
  const u = await signUp(srv.base, 'CalPress');
  const p = (await u.c.post('/api/projects', { name: 'Big deadline' })).json;
  await u.c.patch(`/api/projects/${p.id}`, { target_date: '2027-03-10' });
  for (const t of ['09:00', '11:00']) await u.c.post('/api/calendar/events', { title: `Meeting ${t}`, start_local: `2027-03-10T${t}`, timezone: 'UTC' });
  assert.deepEqual((await feed(u, '2027-03-01', '2027-03-31')).pressure, [], 'two meetings is not yet pressure');
  await u.c.post('/api/calendar/events', { title: 'Meeting 15:00', start_local: '2027-03-10T15:00', timezone: 'UTC' });
  const r = await feed(u, '2027-03-01', '2027-03-31');
  assert.deepEqual(r.pressure, [{ date: '2027-03-10', deadlines: 1, events: 3 }]);
  assert.equal(r.items.filter((i) => i.source === 'event').length, 3, 'nothing was moved');
});

test('S16 completing a recurring task creates exactly one next occurrence', async () => {
  const u = await signUp(srv.base, 'CalTask');
  const p = (await u.c.post('/api/projects', { name: 'Chores' })).json;
  const col = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const card = (await u.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'Water plants', due_date: '2027-01-31', priority: 'high' })).json;
  assert.equal((await u.c.patch(`/api/cards/${card.id}`, { recurrence: 'sometimes' })).status, 400);
  await u.c.patch(`/api/cards/${card.id}`, { recurrence: 'monthly' });
  await u.c.patch(`/api/cards/${card.id}`, { status: 'done' });
  await u.c.patch(`/api/cards/${card.id}`, { status: 'todo' });
  await u.c.patch(`/api/cards/${card.id}`, { status: 'done' }); // re-completing must not spawn again
  const cards = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0].cards;
  assert.equal(cards.length, 2);
  const next = cards.find((c) => c.id !== card.id);
  assert.equal(next.title, 'Water plants');
  assert.equal(next.status, 'todo');
  assert.equal(next.due_date, '2027-02-28', 'month-end clamped');
  assert.equal(next.priority, 'high');
  assert.equal(next.recurrence, 'monthly', 'the chain continues');
  const stranger = await signUp(srv.base, 'CalTaskOther');
  assert.equal((await stranger.c.patch(`/api/cards/${next.id}`, { status: 'done' })).status, 404);
});
