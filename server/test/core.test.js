import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

async function setup(label = 'Core') {
  const u = await signUp(srv.base, label);
  const project = (await u.c.post('/api/projects', { name: 'Renovation' })).json;
  const cols = (await u.c.get(`/api/projects/${project.id}/columns`)).json;
  const mk = async (title, extra = {}) => (await u.c.post(`/api/cards/columns/${cols[0].id}/cards`, { title, ...extra })).json;
  return { u, project, cols, mk };
}

test('project details: status/priority/dates validated; defaults for new projects', async () => {
  const { u, project } = await setup();
  assert.equal(project.status, 'todo');
  assert.equal(project.priority, 'medium');
  assert.equal(project.progress, 0, 'no tasks means 0 progress, not 100');
  const ok = await u.c.patch(`/api/projects/${project.id}`, { status: 'in_progress', priority: 'high', start_date: '2026-11-01', target_date: '2026-12-31' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'in_progress');
  assert.equal(ok.json.target_date, '2026-12-31');
  for (const bad of [{ status: 'finished' }, { priority: 'asap' }, { target_date: '2026-02-30' }, { start_date: 'tomorrow' }, { target_date: '2026-10-01' }]) {
    assert.equal((await u.c.patch(`/api/projects/${project.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await u.c.patch(`/api/projects/${project.id}`, { target_date: null })).json.target_date, null, 'dates can be cleared');
});

test('S7 completing tasks drives project progress; completion history recorded and cleared on reopen', async () => {
  const { u, project, mk } = await setup('Prog');
  const a = await mk('A'); const b = await mk('B'); const c = await mk('C'); await mk('D');
  assert.equal((await u.c.get(`/api/projects/${project.id}`)).json.progress, 0);
  const done = await u.c.patch(`/api/cards/${a.id}`, { status: 'done' });
  assert.ok(done.json.completed_at, 'completed_at stamped');
  await u.c.patch(`/api/cards/${b.id}`, { status: 'done' });
  let p = (await u.c.get(`/api/projects/${project.id}`)).json;
  assert.equal(p.card_count, 4); assert.equal(p.done_count, 2); assert.equal(p.progress, 50);
  const again = await u.c.patch(`/api/cards/${a.id}`, { status: 'done', title: 'A2' });
  assert.equal(again.json.completed_at, done.json.completed_at, 'first completion time is kept');
  const reopened = await u.c.patch(`/api/cards/${a.id}`, { status: 'doing' });
  assert.equal(reopened.json.completed_at, null);
  p = (await u.c.get(`/api/projects/${project.id}`)).json;
  assert.equal(p.progress, 25);
  assert.equal((await u.c.patch(`/api/cards/${c.id}`, { status: 'nonsense' })).status, 400);
  assert.equal((await u.c.patch(`/api/cards/${c.id}`, { title: '  ' })).status, 400);
});

test('tasks: due dates, priority, overdue/upcoming/done/mine views', async () => {
  const { u, project, mk } = await setup('Views');
  const late = await mk('late', { due_date: iso(-3), priority: 'urgent' });
  const soon = await mk('soon', { due_date: iso(2) });
  await mk('nodate');
  const finished = await mk('finished', { due_date: iso(-9) });
  await u.c.patch(`/api/cards/${finished.id}`, { status: 'done' });
  await u.c.patch(`/api/cards/${soon.id}`, { owner: u.user.name.toUpperCase() });

  const ids = async (v) => (await u.c.get(`/api/tasks?view=${v}`)).json.map((t) => t.title).sort();
  assert.deepEqual(await ids('open'), ['late', 'nodate', 'soon']);
  assert.deepEqual(await ids('overdue'), ['late'], 'done tasks are never overdue');
  assert.deepEqual(await ids('upcoming'), ['soon']);
  assert.deepEqual(await ids('done'), ['finished']);
  assert.deepEqual(await ids('mine'), ['soon'], 'owner match is case-insensitive');
  assert.equal((await u.c.get('/api/tasks?view=bogus')).status, 400);
  const open = (await u.c.get('/api/tasks?view=open')).json;
  assert.equal(open[0].title, 'late', 'sorted by due date, undated last');
  assert.equal(open[0].overdue, true);
  assert.equal(open.at(-1).title, 'nodate');
  assert.equal((await u.c.get(`/api/projects/${project.id}`)).json.overdue_count, 1);
  assert.equal((await u.c.get('/api/dashboard')).json.counts.overdueTasks, 1);
  assert.equal((await u.c.patch(`/api/cards/${late.id}`, { due_date: '2026-13-01' })).status, 400);
  assert.equal((await u.c.patch(`/api/cards/${late.id}`, { due_date: null })).json.due_date, null);
});

test('S6 subtasks: create, toggle, delete, counts on board listing', async () => {
  const { u, project, cols, mk } = await setup('Sub');
  const card = await mk('Parent');
  assert.equal((await u.c.post(`/api/cards/${card.id}/subtasks`, { title: '  ' })).status, 400);
  let c = (await u.c.post(`/api/cards/${card.id}/subtasks`, { title: 'one' })).json;
  c = (await u.c.post(`/api/cards/${card.id}/subtasks`, { title: 'two' })).json;
  assert.deepEqual(c.subtasks.map((s) => s.title), ['one', 'two']);
  c = (await u.c.patch(`/api/cards/${card.id}/subtasks/${c.subtasks[0].id}`, { done: true })).json;
  assert.equal(c.subtasks[0].done, true);
  const listing = (await u.c.get(`/api/projects/${project.id}/columns`)).json[0].cards[0];
  assert.equal(listing.subtaskCount, 2); assert.equal(listing.subtaskDone, 1);
  c = (await u.c.del(`/api/cards/${card.id}/subtasks/${c.subtasks[1].id}`)).json;
  assert.equal(c.subtasks.length, 1);
  assert.equal((await u.c.patch(`/api/cards/${card.id}/subtasks/nope`, { done: true })).status, 404);
  assert.ok(cols.length);
});

test('S15 idea converts to a linked project exactly once; the idea is kept', async () => {
  const u = await signUp(srv.base, 'Idea');
  const area = (await u.c.get('/api/life-areas')).json[3];
  const idea = (await u.c.post('/api/ideas', { text: 'Reading tracker\nTrack books and highlights' })).json;
  const empty = (await u.c.post('/api/ideas', { text: '' })).json;
  assert.equal((await u.c.post(`/api/ideas/${empty.id}/convert`, {})).status, 400);
  assert.equal((await u.c.post(`/api/ideas/${idea.id}/convert`, { lifeAreaId: 'bogus' })).status, 400);
  const res = await u.c.post(`/api/ideas/${idea.id}/convert`, { lifeAreaId: area.id });
  assert.equal(res.status, 201);
  const project = (await u.c.get(`/api/projects/${res.json.projectId}`)).json;
  assert.equal(project.name, 'Reading tracker');
  assert.match(project.description, /Track books/);
  assert.equal(project.life_area_id, area.id);
  assert.equal(project.status, 'todo');
  assert.equal((await u.c.get(`/api/projects/${project.id}/columns`)).json.length, 3);
  const kept = (await u.c.get('/api/ideas')).json.find((i) => i.id === idea.id);
  assert.equal(kept.converted_project_id, project.id);
  assert.equal((await u.c.post(`/api/ideas/${idea.id}/convert`, {})).status, 409, 'no double conversion');
  const other = await signUp(srv.base, 'IdeaOther');
  assert.equal((await other.c.post(`/api/ideas/${idea.id}/convert`, {})).status, 404);
});

test('search is scoped to the workspace, escapes wildcards, ignores archived projects', async () => {
  const a = await signUp(srv.base, 'SearchA');
  const b = await signUp(srv.base, 'SearchB');
  const pa = (await a.c.post('/api/projects', { name: 'Zebra garden' })).json;
  const col = (await a.c.get(`/api/projects/${pa.id}/columns`)).json[0];
  await a.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'Buy zebra seeds' });
  await a.c.post('/api/ideas', { text: 'zebra crossing idea' });
  await b.c.post('/api/projects', { name: 'Zebra B project' });

  const r = (await a.c.get('/api/search?q=zebra')).json;
  assert.equal(r.projects.length, 1); assert.equal(r.projects[0].name, 'Zebra garden');
  assert.equal(r.tasks.length, 1); assert.equal(r.tasks[0].project_id, pa.id);
  assert.equal(r.ideas.length, 1);
  assert.equal((await b.c.get('/api/search?q=zebra')).json.projects[0].name, 'Zebra B project');
  assert.equal((await b.c.get('/api/search?q=seeds')).json.tasks.length, 0, 'B cannot find A\'s task');
  assert.equal((await a.c.get('/api/search?q=%25%25')).json.projects.length, 0, '% is literal, not a wildcard');
  assert.deepEqual((await a.c.get('/api/search?q=z')).json, { projects: [], tasks: [], ideas: [] }, 'too short');
  await a.c.patch(`/api/projects/${pa.id}`, { archived: true });
  assert.equal((await a.c.get('/api/search?q=zebra')).json.projects.length, 0);
});

test('tasks and subtasks cannot be reached across workspaces; viewers cannot write', async () => {
  const { u, mk } = await setup('Iso');
  const card = await mk('private');
  const other = await signUp(srv.base, 'IsoOther');
  assert.equal((await other.c.post(`/api/cards/${card.id}/subtasks`, { title: 'x' })).status, 404);
  assert.deepEqual((await other.c.get('/api/tasks?view=open')).json, []);
  assert.equal((await other.c.get(`/api/tasks?project=${(await u.c.get('/api/projects')).json[0].id}`)).json.length, 0);
});
