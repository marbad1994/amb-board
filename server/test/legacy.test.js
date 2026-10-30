import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp } from './helpers.js';

// Own file = own process = own database, so the first account here is genuinely the first.
let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('legacy pre-auth data is adopted only by the first account (D4)', async () => {
  const first = srv;
  const { db } = await import('../src/db.js');
  db.prepare("INSERT INTO projects (id, name, color, created_at) VALUES ('legacy1', 'Old board', '#fff', '2024-01-01')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position, created_at) VALUES ('legacyc', 'legacy1', 'Backlog', 0, '2024-01-01')").run();
  db.prepare("INSERT INTO idea_notes (id, text, created_at, updated_at) VALUES ('legacyi', 'old idea', '2024-01-01', '2024-01-01')").run();
  const one = await signUp(first.base, 'First');
  const two = await signUp(first.base, 'Second');
  const mine = (await one.c.get('/api/projects')).json;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].name, 'Old board');
  assert.equal((await one.c.get('/api/ideas')).json[0].text, 'old idea');
  assert.deepEqual((await two.c.get('/api/projects')).json, []);
  assert.deepEqual((await two.c.get('/api/ideas')).json, []);
});
