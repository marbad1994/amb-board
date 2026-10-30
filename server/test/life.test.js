import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp } from './helpers.js';
import { dailyStreak, weeklyStreak, weekStart } from '../src/habits/streak.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const iso = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const today = iso(0);

test('streak maths: daily (today pending does not break), gaps, longest; weekly targets', () => {
  assert.deepEqual(dailyStreak(['2027-01-08', '2027-01-09', '2027-01-10'], '2027-01-10'), { current: 3, longest: 3 });
  assert.deepEqual(dailyStreak(['2027-01-08', '2027-01-09'], '2027-01-10'), { current: 2, longest: 2 }, 'today not done yet: streak intact');
  assert.deepEqual(dailyStreak(['2027-01-07', '2027-01-08'], '2027-01-10'), { current: 0, longest: 2 }, 'missed yesterday: streak broken');
  assert.deepEqual(dailyStreak(['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-05', '2027-01-06'], '2027-01-06'), { current: 2, longest: 3 });
  assert.deepEqual(dailyStreak([], '2027-01-10'), { current: 0, longest: 0 });
  assert.equal(weekStart('2027-01-10'), '2027-01-04', 'weeks start on Monday (10 Jan 2027 is a Sunday)');
  // 3x/week target: weeks of 4 Jan and 11 Jan met, current week (18 Jan) in progress with 1
  const dates = ['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-11', '2027-01-12', '2027-01-13', '2027-01-18'];
  assert.deepEqual(weeklyStreak(dates, 3, '2027-01-19'), { current: 2, longest: 2 });
  assert.deepEqual(weeklyStreak([...dates, '2027-01-19', '2027-01-20'], 3, '2027-01-20'), { current: 3, longest: 3 }, 'current week counts once met');
  assert.deepEqual(weeklyStreak(['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-18', '2027-01-19', '2027-01-20'], 3, '2027-01-21'), { current: 1, longest: 1 }, 'skipped week resets');
});

test('goals: milestones drive progress; linked projects are the fallback; links navigable both ways', async () => {
  const u = await signUp(srv.base, 'Goal');
  const area = (await u.c.get('/api/life-areas')).json[7];
  assert.equal((await u.c.post('/api/goals', { title: '' })).status, 400);
  assert.equal((await u.c.post('/api/goals', { title: 'x', target_date: '2027-02-30' })).status, 400);
  assert.equal((await u.c.post('/api/goals', { title: 'x', lifeAreaId: 'bogus' })).status, 400);
  const g = (await u.c.post('/api/goals', { title: 'Run a marathon', lifeAreaId: area.id, target_date: '2027-10-01' })).json;
  assert.equal(g.progress, 0); assert.equal(g.progress_source, 'none');

  const p = (await u.c.post('/api/projects', { name: 'Training plan' })).json;
  const col = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const c1 = (await u.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'a' })).json;
  await u.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'b' });
  await u.c.patch(`/api/cards/${c1.id}`, { status: 'done' });
  let linked = (await u.c.put(`/api/goals/${g.id}/projects/${p.id}`)).json;
  assert.equal(linked.progress, 50); assert.equal(linked.progress_source, 'projects');
  assert.deepEqual((await u.c.get(`/api/projects/${p.id}/goals`)).json.map((x) => x.id), [g.id], 'navigable from the project side');

  let m = (await u.c.post(`/api/goals/${g.id}/milestones`, { title: '10k', due_date: '2027-03-01' })).json;
  m = (await u.c.post(`/api/goals/${g.id}/milestones`, { title: 'Half marathon', due_date: '2027-06-01' })).json;
  assert.equal(m.progress, 0); assert.equal(m.progress_source, 'milestones', 'milestones take precedence');
  m = (await u.c.patch(`/api/goals/${g.id}/milestones/${m.milestones[0].id}`, { done: true })).json;
  assert.equal(m.progress, 50);
  assert.ok(m.milestones[0].completed_at);
  assert.equal((await u.c.post(`/api/goals/${g.id}/milestones`, { title: 'bad', due_date: 'soon' })).status, 400);

  // milestone appears on the calendar
  const cal = (await u.c.get('/api/calendar?from=2027-03-01&to=2027-03-31')).json.items.find((i) => i.kind === 'milestone');
  assert.equal(cal.title, '10k (Run a marathon)'); assert.equal(cal.done, true);

  assert.equal((await u.c.patch(`/api/goals/${g.id}`, { status: 'achieved' })).json.status, 'achieved');
  assert.equal((await u.c.get('/api/goals')).json.length, 1);
  await u.c.patch(`/api/goals/${g.id}`, { status: 'archived' });
  assert.equal((await u.c.get('/api/goals')).json.length, 0, 'archived hidden by default');
  assert.equal((await u.c.get('/api/goals?status=archived')).json.length, 1);
});

test('S17/S18 goals are isolated; viewers read only; cannot link foreign projects', async () => {
  const a = await signUp(srv.base, 'GoalA'); const b = await signUp(srv.base, 'GoalB');
  const g = (await a.c.post('/api/goals', { title: 'secret goal' })).json;
  const pb = (await b.c.post('/api/projects', { name: 'B' })).json;
  assert.deepEqual((await b.c.get('/api/goals')).json, []);
  for (const [verb, path, body] of [['get', `/api/goals/${g.id}`], ['patch', `/api/goals/${g.id}`, { title: 'x' }], ['del', `/api/goals/${g.id}`],
    ['post', `/api/goals/${g.id}/milestones`, { title: 'x' }], ['put', `/api/goals/${g.id}/projects/${pb.id}`]]) {
    assert.equal((await (body ? b.c[verb](path, body) : b.c[verb](path))).status, 404, `${verb} ${path}`);
  }
  assert.equal((await a.c.put(`/api/goals/${g.id}/projects/${pb.id}`)).status, 404, 'cannot link another workspace\'s project');
  assert.equal((await b.c.post('/api/habits', { title: 'h', goalId: g.id })).status, 400, 'cannot link a foreign goal');
});

test('S16 habits: check-in is idempotent, streaks computed, future dates rejected, habits are personal', async () => {
  const owner = await signUp(srv.base, 'HabOwner');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json;
  owner.c.useWorkspace(ws.id);
  const other = await signUp(srv.base, 'HabOther');
  const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: other.email, role: 'member' });
  await other.c.post('/api/invitations/accept', { token: inv.json.token });
  other.c.useWorkspace(ws.id);

  assert.equal((await owner.c.post('/api/habits', { title: '' })).status, 400);
  assert.equal((await owner.c.post('/api/habits', { title: 'x', frequency: 'hourly' })).status, 400);
  assert.equal((await owner.c.post('/api/habits', { title: 'x', frequency: 'weekly', target_per_week: 9 })).status, 400);
  const h = (await owner.c.post('/api/habits', { title: 'Meditate' })).json;
  for (const d of [iso(-2), iso(-1), iso(-1), today]) await owner.c.put(`/api/habits/${h.id}/entries/${d}`, { done: true });
  let cur = (await owner.c.get('/api/habits')).json[0];
  assert.equal(cur.streak.current, 3);
  assert.equal(cur.done_today, true);
  assert.equal(cur.recent.length, 3, 'duplicate check-in did not create a second entry');
  cur = (await owner.c.put(`/api/habits/${h.id}/entries/${today}`, { done: false })).json;
  assert.equal(cur.streak.current, 2, 'undo today: still 2 because today is pending');
  assert.equal((await owner.c.put(`/api/habits/${h.id}/entries/${iso(5)}`, { done: true })).status, 400);
  assert.equal((await owner.c.put(`/api/habits/${h.id}/entries/2027-02-30`, { done: true })).status, 400);

  // personal: same workspace, other member sees nothing and cannot touch it
  assert.deepEqual((await other.c.get('/api/habits')).json, []);
  assert.equal((await other.c.put(`/api/habits/${h.id}/entries/${today}`, { done: true })).status, 404);
  assert.equal((await other.c.patch(`/api/habits/${h.id}`, { title: 'x' })).status, 404);

  const w = (await owner.c.post('/api/habits', { title: 'Gym', frequency: 'weekly', target_per_week: 2 })).json;
  assert.equal(w.target_per_week, 2);
  await owner.c.patch(`/api/habits/${w.id}`, { archived: true });
  assert.equal((await owner.c.get('/api/habits')).json.length, 1, 'archived habits hidden');
});

test('challenges: progress from the linked habit over a date window; only your own habits', async () => {
  const u = await signUp(srv.base, 'Chal'); const o = await signUp(srv.base, 'ChalO');
  const h = (await u.c.post('/api/habits', { title: 'Read' })).json;
  const ho = (await o.c.post('/api/habits', { title: 'theirs' })).json;
  assert.equal((await u.c.post('/api/challenges', {})).status, 404);
  const mk = (b) => u.c.post('/api/habits/challenges', { title: '7 days', habitId: h.id, start_date: iso(-3), end_date: iso(3), ...b });
  assert.equal((await mk({ habitId: ho.id })).status, 400, 'cannot use someone else\'s habit');
  assert.equal((await mk({ end_date: iso(-9) })).status, 400);
  assert.equal((await mk({ end_date: iso(500) })).status, 400);
  const c = (await mk({})).json;
  assert.equal(c.total_days, 7); assert.equal(c.completed_days, 0); assert.equal(c.state, 'running');
  for (const d of [iso(-3), iso(-2), today, iso(-20)]) await u.c.put(`/api/habits/${h.id}/entries/${d}`, { done: true });
  const list = (await u.c.get('/api/habits/challenges/all')).json;
  assert.equal(list[0].completed_days, 3, 'only entries inside the window count');
  assert.equal(list[0].progress, 43);
  assert.deepEqual((await o.c.get('/api/habits/challenges/all')).json, []);
});

test('S17 notes and journal privacy: journal always private; private notes author-only; only author edits', async () => {
  const owner = await signUp(srv.base, 'NoteOwner');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json;
  owner.c.useWorkspace(ws.id);
  const member = await signUp(srv.base, 'NoteMember');
  const viewer = await signUp(srv.base, 'NoteViewer');
  for (const [u, role] of [[member, 'member'], [viewer, 'viewer']]) {
    const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: u.email, role });
    await u.c.post('/api/invitations/accept', { token: inv.json.token });
    u.c.useWorkspace(ws.id);
  }
  const shared = (await owner.c.post('/api/notes', { title: 'Shopping', body: 'milk' })).json;
  const priv = (await owner.c.post('/api/notes', { title: 'Private idea', body: 'surprise party', privacy: 'private' })).json;
  const jr = (await owner.c.post('/api/notes', { kind: 'journal', body: 'dear diary SECRET-JOURNAL', privacy: 'workspace' })).json;
  assert.equal(jr.privacy, 'private', 'client cannot make a journal entry shared');
  assert.equal(jr.entry_date, today);

  for (const reader of [member, viewer]) {
    const list = (await reader.c.get('/api/notes')).json;
    assert.deepEqual(list.map((n) => n.id), [shared.id], 'readers see only the workspace note');
    assert.equal((await reader.c.get(`/api/notes/${priv.id}`)).status, 404);
    assert.equal((await reader.c.get(`/api/notes/${jr.id}`)).status, 404);
    assert.equal((await reader.c.get('/api/notes?q=SECRET-JOURNAL')).json.length, 0, 'search cannot reach private text');
    assert.equal((await reader.c.get('/api/notes?kind=journal')).json.length, 0);
  }
  // even a workspace owner/admin who is not the author cannot read someone else's journal
  const memberJournal = (await member.c.post('/api/notes', { kind: 'journal', body: 'member diary' })).json;
  assert.equal((await owner.c.get(`/api/notes/${memberJournal.id}`)).status, 404);
  assert.equal((await owner.c.get('/api/notes?kind=journal')).json.length, 1);

  assert.equal((await member.c.patch(`/api/notes/${shared.id}`, { body: 'hacked' })).status, 403, 'visible but not editable by others');
  assert.equal((await member.c.del(`/api/notes/${shared.id}`)).status, 403);
  assert.equal((await member.c.patch(`/api/notes/${priv.id}`, { body: 'x' })).status, 404);
  assert.equal((await viewer.c.post('/api/notes', { title: 'x' })).status, 403, 'viewers cannot write');
  assert.equal((await owner.c.patch(`/api/notes/${jr.id}`, { privacy: 'workspace' })).json.privacy, 'private');
  assert.equal((await owner.c.patch(`/api/notes/${priv.id}`, { privacy: 'workspace' })).json.privacy, 'workspace', 'author may share a note');
  const seen = (await member.c.get('/api/notes')).json;
  assert.deepEqual(seen.map((n) => n.kind).sort(), ['journal', 'note', 'note'], 'two workspace notes plus the member\'s OWN journal; the owner\'s journal stays hidden');
  assert.ok(seen.filter((n) => n.kind === 'journal').every((n) => n.mine));
});

test('notes: validation, links to own project/goal, search, cross-workspace isolation', async () => {
  const a = await signUp(srv.base, 'NoteA'); const b = await signUp(srv.base, 'NoteB');
  const p = (await a.c.post('/api/projects', { name: 'Kitchen' })).json;
  const g = (await a.c.post('/api/goals', { title: 'Home' })).json;
  assert.equal((await a.c.post('/api/notes', {})).status, 400);
  assert.equal((await a.c.post('/api/notes', { kind: 'journal', entry_date: '2027-02-30' })).status, 400);
  const pb = (await b.c.post('/api/projects', { name: 'theirs' })).json;
  assert.equal((await a.c.post('/api/notes', { title: 'x', projectId: pb.id })).status, 400);
  const n = (await a.c.post('/api/notes', { title: 'Paint colours', body: 'Matt white, 100% wool', projectId: p.id, goalId: g.id })).json;
  assert.equal(n.project_name, 'Kitchen'); assert.equal(n.goal_title, 'Home');
  assert.equal((await a.c.get(`/api/notes?project=${p.id}`)).json.length, 1);
  assert.equal((await a.c.get('/api/notes?q=matt')).json.length, 1);
  assert.equal((await a.c.get('/api/notes?q=%25%25')).json.length, 0, '%% is literal text, not a wildcard');
  assert.equal((await a.c.get('/api/notes?q=100%25')).json.length, 1, 'a literal % in the text still matches');
  assert.deepEqual((await b.c.get('/api/notes')).json, []);
  assert.equal((await b.c.get(`/api/notes/${n.id}`)).status, 404);
  assert.equal((await b.c.patch(`/api/notes/${n.id}`, { body: 'x' })).status, 404);
});

test('S19 private journal text never reaches AI inputs (search tool, daily facts)', async () => {
  const u = await signUp(srv.base, 'JrnAi');
  await u.c.post('/api/notes', { kind: 'journal', body: 'JOURNAL-CANARY-9931' });
  await u.c.post('/api/notes', { title: 'NOTE-CANARY-9931', body: 'x' });
  const { db } = await import('../src/db.js');
  const { runTool } = await import('../src/ai/tools.js');
  const { dailyFacts } = await import('../src/ai/facts.js');
  const ws = db.prepare('SELECT workspace_id AS w FROM workspace_members WHERE user_id = ?').get(u.user.id).w;
  assert.ok(!JSON.stringify(runTool('search', { q: 'CANARY' }, ws)).includes('CANARY'));
  assert.ok(!JSON.stringify(dailyFacts(ws, u.user)).includes('CANARY'));
});

test('S25-adjacent documents: allow-list, magic bytes, size limit, privacy, authenticated download, safe headers', async () => {
  const a = await signUp(srv.base, 'DocA'); const b = await signUp(srv.base, 'DocB');
  const up = (u, name, bytes, extra = {}) => {
    const f = new FormData();
    f.append('file', new Blob([bytes]), name);
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    return u.c.post('/api/documents', f);
  };
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('x'.repeat(50))]);
  const p = (await a.c.post('/api/projects', { name: 'Docs project' })).json;
  const ok = await up(a, 'lease.pdf', pdf, { projectId: p.id });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.mime_type, 'application/pdf'); assert.equal(ok.json.project_name, 'Docs project');

  assert.equal((await up(a, 'evil.html', '<script>alert(1)</script>')).status, 415, 'html not allowed');
  assert.equal((await up(a, 'evil.svg', '<svg onload=alert(1)>')).status, 415);
  assert.equal((await up(a, 'fake.pdf', 'this is not a pdf')).status, 415, 'content must match type');
  assert.equal((await up(a, 'fake.png', Buffer.from([1, 2, 3, 4]))).status, 415);
  assert.equal((await up(a, 'bin.txt', Buffer.from([65, 0, 66]))).status, 415, 'binary disguised as text');
  assert.equal((await up(a, 'empty.txt', '')).status, 415);
  assert.equal((await up(a, 'noext', 'abc')).status, 415);
  assert.equal((await up(a, 'a.txt', 'hello', { projectId: 'bogus' })).status, 400);
  const big = await up(a, 'big.txt', Buffer.alloc(10 * 1024 * 1024 + 10, 97));
  assert.equal(big.status, 413);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
  const img = (await up(a, '../../etc/passwd.png', png)).json;
  assert.equal(img.name, 'passwd.png', 'path components stripped');

  const dl = await a.c.get(`/api/documents/${ok.json.id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.match((await a.c.get(`/api/documents/${img.id}/download`)).headers.get('content-disposition'), /^inline/);
  assert.equal((await b.c.get(`/api/documents/${ok.json.id}/download`)).status, 404, 'other workspace');
  assert.deepEqual((await b.c.get('/api/documents')).json, []);
  assert.equal((await b.c.del(`/api/documents/${ok.json.id}`)).status, 404);
  assert.equal((await new (class { constructor() {} })() && (await client404(srv.base, ok.json.id))), 401, 'download needs a session');

  const list = (await a.c.get(`/api/documents?project=${p.id}`)).json;
  assert.equal(list.length, 1);
  assert.equal((await a.c.del(`/api/documents/${ok.json.id}`)).status, 204);
  assert.equal((await a.c.get(`/api/documents/${ok.json.id}/download`)).status, 404);
});

async function client404(base, id) { return (await fetch(`${base}/api/documents/${id}/download`)).status; }

test('documents in shared workspaces: private ones are uploader-only; viewers read workspace docs, cannot upload; admin can delete', async () => {
  const owner = await signUp(srv.base, 'DocOwner');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Fam' })).json;
  owner.c.useWorkspace(ws.id);
  const member = await signUp(srv.base, 'DocMember'); const viewer = await signUp(srv.base, 'DocViewer');
  for (const [u, role] of [[member, 'member'], [viewer, 'viewer']]) {
    const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: u.email, role });
    await u.c.post('/api/invitations/accept', { token: inv.json.token });
    u.c.useWorkspace(ws.id);
  }
  const up = (u, name, privacy) => { const f = new FormData(); f.append('file', new Blob(['hello']), name); f.append('privacy', privacy); return u.c.post('/api/documents', f); };
  const open = (await up(member, 'shared.txt', 'workspace')).json;
  const secret = (await up(member, 'private.txt', 'private')).json;
  assert.deepEqual((await viewer.c.get('/api/documents')).json.map((d) => d.id), [open.id]);
  assert.deepEqual((await owner.c.get('/api/documents')).json.map((d) => d.id), [open.id], 'not even the owner sees a private upload');
  assert.equal((await owner.c.get(`/api/documents/${secret.id}/download`)).status, 404);
  assert.equal((await viewer.c.get(`/api/documents/${open.id}/download`)).status, 200);
  assert.equal((await up(viewer, 'x.txt', 'workspace')).status, 403);
  assert.equal((await viewer.c.del(`/api/documents/${open.id}`)).status, 403);
  assert.equal((await owner.c.del(`/api/documents/${open.id}`)).status, 204, 'admin/owner can remove a workspace document');
});

test('My Day: today\'s tasks, overdue, events, due habits, milestones and budget alerts from real records', async () => {
  const u = await signUp(srv.base, 'Day');
  const p = (await u.c.post('/api/projects', { name: 'Reno' })).json;
  await u.c.patch(`/api/projects/${p.id}`, { priority: 'urgent' });
  const col = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0];
  const mk = async (title, extra) => (await u.c.post(`/api/cards/columns/${col.id}/cards`, { title, ...extra })).json;
  await mk('due today', { due_date: today }); await mk('late', { due_date: iso(-4) }); await mk('later', { due_date: iso(9) });
  const doing = await mk('in flight', {}); await u.c.patch(`/api/cards/${doing.id}`, { status: 'doing' });
  await u.c.post('/api/calendar/events', { title: 'Dentist', start_local: `${today}T15:00`, timezone: 'UTC' });
  const h = (await u.c.post('/api/habits', { title: 'Stretch' })).json;
  const w = (await u.c.post('/api/habits', { title: 'Gym', frequency: 'weekly', target_per_week: 1 })).json;
  await u.c.put(`/api/habits/${w.id}/entries/${today}`, { done: true });
  const g = (await u.c.post('/api/goals', { title: 'Fit' })).json;
  await u.c.post(`/api/goals/${g.id}/milestones`, { title: 'First 5k', due_date: iso(3) });
  await u.c.put(`/api/projects/${p.id}/budget`, { currency: 'EUR', approved_minor: 1000 });
  await u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 1500, currency: 'EUR', date: today, projectId: p.id });

  const d = (await u.c.get('/api/my-day')).json;
  assert.equal(d.today, today);
  assert.deepEqual(d.due_today.map((t) => t.title), ['due today']);
  assert.deepEqual(d.overdue.map((t) => t.title), ['late']);
  assert.deepEqual(d.in_progress.map((t) => t.title), ['in flight']);
  assert.deepEqual(d.events.map((e) => e.title), ['Dentist']);
  assert.deepEqual(d.habits.map((x) => [x.title, x.done_today]), [['Stretch', false], ['Gym', true]]);
  assert.equal(d.milestones_soon[0].title, 'First 5k');
  assert.equal(d.important_projects[0].name, 'Reno');
  assert.equal(d.budget_alerts[0].status, 'over');
  assert.ok(h.id);
  const other = await signUp(srv.base, 'DayOther');
  const o = (await other.c.get('/api/my-day')).json;
  assert.deepEqual([o.due_today, o.overdue, o.events, o.habits, o.budget_alerts], [[], [], [], [], []]);
});
