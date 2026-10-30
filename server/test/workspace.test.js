import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

async function sharedWorkspaceWith(roleByUser) {
  const owner = await signUp(srv.base, 'Owner');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Family' })).json;
  const people = {};
  for (const [label, role] of Object.entries(roleByUser)) {
    const u = await signUp(srv.base, label);
    const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: u.email, role });
    assert.equal(inv.status, 201, inv.text);
    const acc = await u.c.post('/api/invitations/accept', { token: inv.json.token });
    assert.equal(acc.status, 200, acc.text);
    u.c.useWorkspace(ws.id);
    people[label] = u;
  }
  owner.c.useWorkspace(ws.id);
  return { owner, ws, people };
}

test('S3 invite collaborator with limited permissions; roles enforced on the server', async () => {
  const { owner, ws, people } = await sharedWorkspaceWith({ Viewer: 'viewer', Member: 'member', Admin: 'admin' });
  const members = await owner.c.get(`/api/workspaces/${ws.id}/members`);
  assert.equal(members.json.length, 4);

  // owner creates a project
  const proj = await owner.c.post('/api/projects', { name: 'Shared project' });
  assert.equal(proj.status, 201);

  // viewer: read yes, write no
  const v = people.Viewer.c;
  assert.equal((await v.get('/api/projects')).json.length, 1);
  assert.equal((await v.post('/api/projects', { name: 'nope' })).status, 403);
  assert.equal((await v.patch(`/api/projects/${proj.json.id}`, { name: 'hacked' })).status, 403);
  assert.equal((await v.del(`/api/projects/${proj.json.id}`)).status, 403);
  assert.equal((await v.post('/api/life-areas', { name: 'nope' })).status, 403);

  // member: content write yes, life-area management no, members management no
  const m = people.Member.c;
  assert.equal((await m.post('/api/projects', { name: 'Member project' })).status, 201);
  assert.equal((await m.post('/api/life-areas', { name: 'nope' })).status, 403);
  assert.equal((await m.post(`/api/workspaces/${ws.id}/invitations`, { email: 'x@example.com', role: 'member' })).status, 403);

  // admin: life areas yes, granting admin no
  const a = people.Admin.c;
  assert.equal((await a.post('/api/life-areas', { name: 'Admin area' })).status, 201);
  assert.equal((await a.post(`/api/workspaces/${ws.id}/invitations`, { email: 'y@example.com', role: 'admin' })).status, 403);
  assert.equal((await a.post(`/api/workspaces/${ws.id}/invitations`, { email: 'y@example.com', role: 'member' })).status, 201);
});

test('S3 invitation tokens: wrong account, reuse, revoke and personal workspaces', async () => {
  const owner = await signUp(srv.base, 'Inviter');
  const ws = (await owner.c.post('/api/workspaces', { name: 'Team' })).json;
  const guest = await signUp(srv.base, 'Guest');
  const other = await signUp(srv.base, 'Other');
  const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: guest.email, role: 'member' });
  assert.equal((await other.c.post('/api/invitations/accept', { token: inv.json.token })).status, 400, 'wrong email cannot use token');
  assert.equal((await guest.c.post('/api/invitations/accept', { token: 'garbage' })).status, 400);
  assert.equal((await guest.c.post('/api/invitations/accept', { token: inv.json.token })).status, 200);
  assert.equal((await guest.c.post('/api/invitations/accept', { token: inv.json.token })).status, 400, 'single use');

  const inv2 = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: other.email, role: 'viewer' });
  await owner.c.del(`/api/workspaces/${ws.id}/invitations/${inv2.json.id}`);
  assert.equal((await other.c.post('/api/invitations/accept', { token: inv2.json.token })).status, 400, 'revoked');

  const personal = await owner.c.post(`/api/workspaces/${owner.personalId}/invitations`, { email: other.email, role: 'member' });
  assert.equal(personal.status, 400, 'personal workspaces are single-user');
  const stored = (await import('../src/db.js')).db.prepare('SELECT token_hash FROM invitations WHERE id = ?').get(inv.json.id);
  assert.notEqual(stored.token_hash, inv.json.token, 'only a hash of the token is stored');
});

test('member role changes and removal respect hierarchy; removed user loses access', async () => {
  const { owner, ws, people } = await sharedWorkspaceWith({ Admin: 'admin', Member: 'member' });
  const memberId = people.Member.user.id;
  const adminId = people.Admin.user.id;
  assert.equal((await people.Admin.c.patch(`/api/workspaces/${ws.id}/members/${memberId}`, { role: 'viewer' })).status, 204);
  assert.equal((await people.Member.c.post('/api/projects', { name: 'x' })).status, 403, 'demoted to viewer');
  assert.equal((await people.Admin.c.patch(`/api/workspaces/${ws.id}/members/${memberId}`, { role: 'admin' })).status, 403);
  assert.equal((await people.Admin.c.del(`/api/workspaces/${ws.id}/members/${owner.user.id}`)).status, 400, 'owner cannot be removed');
  assert.equal((await owner.c.patch(`/api/workspaces/${ws.id}/members/${owner.user.id}`, { role: 'viewer' })).status, 400);
  assert.equal((await owner.c.del(`/api/workspaces/${ws.id}/members/${adminId}`)).status, 204);
  assert.equal((await people.Admin.c.get('/api/projects')).status, 404, 'removed member can no longer use the workspace');
});

test('S17/S18 one workspace and one user cannot reach another\'s data (by id and by listing)', async () => {
  const alice = await signUp(srv.base, 'Alice');
  const bob = await signUp(srv.base, 'Bob');

  const area = (await alice.c.get('/api/life-areas')).json[0];
  const proj = (await alice.c.post('/api/projects', { name: 'Alice secret', lifeAreaId: area.id })).json;
  const cols = (await alice.c.get(`/api/projects/${proj.id}/columns`)).json;
  const card = (await alice.c.post(`/api/cards/columns/${cols[0].id}/cards`, { title: 'Secret card' })).json;
  const idea = (await alice.c.post('/api/ideas', { text: 'secret idea' })).json;
  const form = new FormData();
  form.append('file', new Blob(['top secret'], { type: 'text/plain' }), 'secret.txt');
  const att = (await alice.c.post(`/api/cards/${card.id}/attachments`, form)).json;

  // listings are empty for Bob
  assert.deepEqual((await bob.c.get('/api/projects')).json, []);
  assert.deepEqual((await bob.c.get('/api/ideas')).json, []);
  assert.equal((await bob.c.get('/api/dashboard')).json.counts.activeProjects, 0);

  // direct id access is 404 for every verb
  const probes = [
    ['get', `/api/projects/${proj.id}`], ['patch', `/api/projects/${proj.id}`], ['del', `/api/projects/${proj.id}`],
    ['get', `/api/projects/${proj.id}/columns`], ['post', `/api/projects/${proj.id}/columns`, { name: 'x' }],
    ['patch', `/api/projects/columns/${cols[0].id}`, { name: 'x' }], ['del', `/api/projects/columns/${cols[0].id}`],
    ['get', `/api/cards/${card.id}`], ['patch', `/api/cards/${card.id}`, { title: 'x' }], ['del', `/api/cards/${card.id}`],
    ['post', `/api/cards/${card.id}/comments`, { text: 'x' }], ['post', `/api/cards/${card.id}/move`, { columnId: cols[1].id }],
    ['post', `/api/cards/columns/${cols[0].id}/cards`, { title: 'x' }],
    ['patch', `/api/ideas/${idea.id}`, { text: 'x' }], ['del', `/api/ideas/${idea.id}`],
    ['get', `/api/attachments/${att.id}/download`], ['del', `/api/cards/${card.id}/attachments/${att.id}`],
    ['patch', `/api/life-areas/${area.id}`, { name: 'x' }],
  ];
  for (const [verb, path, body] of probes) {
    const res = await (body ? bob.c[verb](path, body) : bob.c[verb](path));
    assert.equal(res.status, 404, `${verb.toUpperCase()} ${path} -> ${res.status}`);
  }
  const upload = new FormData();
  upload.append('file', new Blob(['x']), 'x.txt');
  assert.equal((await bob.c.post(`/api/cards/${card.id}/attachments`, upload)).status, 404);

  // Bob cannot pivot using Alice's workspace id or her life area
  assert.equal((await bob.c.get('/api/projects', { 'x-workspace-id': alice.personalId })).status, 404);
  assert.equal((await bob.c.post('/api/projects', { name: 'x', lifeAreaId: area.id })).status, 400);
  assert.equal((await bob.c.post('/api/ai/parse-task', { projectId: proj.id, text: 'x' })).status, 404);
  const ownCol = (await bob.c.get(`/api/projects/${(await bob.c.post('/api/projects', { name: 'b' })).json.id}/columns`)).json[0];
  const ownCard = (await bob.c.post(`/api/cards/columns/${ownCol.id}/cards`, { title: 'b' })).json;
  assert.equal((await bob.c.post(`/api/cards/${ownCard.id}/move`, { columnId: cols[0].id })).status, 404, 'cannot move own card into foreign column');

  // Alice's data is untouched
  const still = await alice.c.get(`/api/cards/${card.id}`);
  assert.equal(still.json.title, 'Secret card');
  assert.equal(still.json.comments.length, 0);
});
