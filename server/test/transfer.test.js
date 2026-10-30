// Copy to another workspace.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp } from './helpers.js';

let srv, db;
before(async () => { srv = await startServer(); ({ db } = await import('../src/db.js')); });
after(() => srv.close());

async function pair(label) {
  const u = await signUp(srv.base, label);
  const shared = (await u.c.post('/api/workspaces', { name: `${label} shared` })).json;
  return { u, shared };
}

test('a project is copied whole (columns with status and limit, tasks, subtasks, comments); the original is untouched', async () => {
  const { u, shared } = await pair('Copy');
  const p = (await u.c.post('/api/projects', { name: 'Kitchen', description: 'Refit', priority: 'high' })).json;
  const [backlog, progress] = (await u.c.get(`/api/projects/${p.id}/columns`)).json;
  await u.c.patch(`/api/projects/columns/${progress.id}`, { card_limit: 3 });
  const card = (await u.c.post(`/api/cards/columns/${backlog.id}/cards`, { title: 'Order tiles', due_date: '2027-02-01', priority: 'high' })).json;
  await u.c.post(`/api/cards/${card.id}/subtasks`, { title: 'Measure' });
  await u.c.post(`/api/cards/${card.id}/comments`, { author: 'x', text: 'Check the colour' });
  const res = await u.c.post('/api/transfer', { entity: 'project', id: p.id, target_workspace_id: shared.id });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual(res.json.copied, { columns: 3, tasks: 1, subtasks: 1, comments: 1 });
  assert.equal(res.json.target.name, 'Copy shared');
  const np = db.prepare('SELECT * FROM projects WHERE id = ?').get(res.json.id);
  assert.equal(np.workspace_id, shared.id); assert.equal(np.name, 'Kitchen'); assert.equal(np.priority, 'high');
  const cols = db.prepare('SELECT name, status, card_limit FROM columns WHERE project_id = ? ORDER BY position').all(np.id);
  assert.deepEqual(cols.map((c) => [c.name, c.status, c.card_limit]), [['Backlog', 'todo', null], ['In Progress', 'doing', 3], ['Done', 'done', null]]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards WHERE column_id IN (SELECT id FROM columns WHERE project_id = ?)').get(p.id).n, 1, 'original still has its task');
  assert.notEqual(db.prepare('SELECT id FROM cards WHERE title = ? AND column_id IN (SELECT id FROM columns WHERE project_id = ?)').get('Order tiles', np.id).id, card.id);
  const audit = db.prepare("SELECT workspace_id FROM audit_log WHERE action IN ('workspace.copy_out', 'workspace.copy_in') ORDER BY created_at").all().map((a) => a.workspace_id);
  assert.equal(new Set(audit).size, 2, 'recorded in both workspaces');
});

test('goal, note and idea copy; journal entries and other people\'s private notes never do', async () => {
  const { u, shared } = await pair('Copy2');
  const g = (await u.c.post('/api/goals', { title: 'Marathon' })).json;
  await u.c.post(`/api/goals/${g.id}/milestones`, { title: '10k' });
  const gr = await u.c.post('/api/transfer', { entity: 'goal', id: g.id, target_workspace_id: shared.id });
  assert.equal(gr.status, 201); assert.equal(gr.json.copied.milestones, 1);
  const note = (await u.c.post('/api/notes', { title: 'Plan', body: 'b', privacy: 'workspace' })).json;
  assert.equal((await u.c.post('/api/transfer', { entity: 'note', id: note.id, target_workspace_id: shared.id })).status, 201);
  const j = (await u.c.post('/api/notes', { kind: 'journal', title: 'Diary', body: 'secret', entry_date: '2027-01-01' })).json;
  assert.equal((await u.c.post('/api/transfer', { entity: 'note', id: j.id, target_workspace_id: shared.id })).status, 404, 'journal is never copied');
  const idea = (await u.c.post('/api/ideas', { author: 'me', text: 'Balcony garden' })).json;
  assert.equal((await u.c.post('/api/transfer', { entity: 'idea', id: idea.id, target_workspace_id: shared.id })).status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idea_notes WHERE workspace_id = ? AND text = ?').get(shared.id, 'Balcony garden').n, 1);
});

test('permissions: needs write access in both workspaces, membership in the target, and an object from the active workspace', async () => {
  const { u, shared } = await pair('Perm');
  const p = (await u.c.post('/api/projects', { name: 'P' })).json;
  const stranger = await signUp(srv.base, 'Stranger');
  const sp = (await stranger.c.post('/api/projects', { name: 'Theirs' })).json;
  assert.equal((await u.c.post('/api/transfer', { entity: 'project', id: p.id, target_workspace_id: (await stranger.c.get('/api/workspaces')).json[0].id })).status, 404, 'not a member of the target');
  assert.equal((await u.c.post('/api/transfer', { entity: 'project', id: sp.id, target_workspace_id: shared.id })).status, 404, "someone else's project");
  assert.equal((await u.c.post('/api/transfer', { entity: 'project', id: p.id, target_workspace_id: u.personalId })).status, 400, 'same workspace');
  assert.equal((await u.c.post('/api/transfer', { entity: 'plan', id: p.id, target_workspace_id: shared.id })).status, 400);
  // a member demoted to viewer in the target cannot copy into it
  const inv = (await u.c.post(`/api/workspaces/${shared.id}/invitations`, { email: stranger.email, role: 'member' })).json;
  await stranger.c.post('/api/invitations/accept', { token: inv.token });
  db.prepare('UPDATE workspace_members SET role = ? WHERE user_id = ? AND workspace_id = ?').run('viewer', stranger.user.id, shared.id);
  assert.equal((await stranger.c.post('/api/transfer', { entity: 'project', id: sp.id, target_workspace_id: shared.id })).status, 403);
});
