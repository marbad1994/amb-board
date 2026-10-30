import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('S1 register creates account, secure session cookie, and personal workspace with 12 life areas', async () => {
  const c = client(srv.base);
  const res = await c.post('/api/auth/register', { email: 'Marcus@Example.com', name: 'Marcus', password: 'correct-horse-battery' });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.email, 'marcus@example.com');
  assert.equal(res.json.workspaces.length, 1);
  assert.equal(res.json.workspaces[0].kind, 'personal');
  assert.equal(res.json.workspaces[0].role, 'owner');
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const areas = await c.get('/api/life-areas');
  assert.equal(areas.status, 200);
  assert.equal(areas.json.length, 12);
  assert.equal(areas.json[0].name, 'Health & Wellness');
  assert.equal(areas.json[11].name, 'Community & Contribution');
});

test('S1 password is stored as a scrypt hash, never plaintext', async () => {
  const { db } = await import('../src/db.js');
  const row = db.prepare("SELECT password_hash FROM users WHERE email = 'marcus@example.com'").get();
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('correct-horse'));
  const sessions = db.prepare('SELECT id FROM sessions').all();
  assert.ok(sessions.every((s) => /^[0-9a-f]{64}$/.test(s.id)), 'session ids are sha256 hashes');
});

test('S1 registration validation and duplicate email', async () => {
  const c = client(srv.base);
  assert.equal((await c.post('/api/auth/register', { email: 'nope', name: 'x', password: 'correct-horse-battery' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { email: 'a@example.com', name: 'x', password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { email: 'a@example.com', name: '', password: 'correct-horse-battery' })).status, 400);
  const dup = await c.post('/api/auth/register', { email: 'MARCUS@example.com', name: 'Dup', password: 'correct-horse-battery' });
  assert.equal(dup.status, 409);
});

test('S1 login, me, logout invalidates the session server-side', async () => {
  const c = client(srv.base);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  const bad = await c.post('/api/auth/login', { email: 'marcus@example.com', password: 'wrong-password-here' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'invalid email or password');
  const unknown = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password-here' });
  assert.equal(unknown.json.error, bad.json.error, 'no account enumeration');
  const ok = await c.post('/api/auth/login', { email: 'marcus@example.com', password: 'correct-horse-battery' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 200);
  const stolen = c.cookie;
  assert.equal((await c.post('/api/auth/logout')).status, 204);
  const replay = client(srv.base);
  replay.setCookie(stolen);
  assert.equal((await replay.get('/api/auth/me')).status, 401, 'old token is dead after logout');
});

test('S1 logout-all and password change revoke other sessions', async () => {
  const a = await signUp(srv.base, 'Revoke');
  const second = client(srv.base);
  await second.post('/api/auth/login', { email: a.email, password: 'correct-horse-battery' });
  assert.equal((await second.get('/api/auth/me')).status, 200);
  const wrong = await a.c.post('/api/auth/password', { currentPassword: 'nope-nope-nope', newPassword: 'another-long-password' });
  assert.equal(wrong.status, 403);
  assert.equal((await a.c.post('/api/auth/password', { currentPassword: 'correct-horse-battery', newPassword: 'another-long-password' })).status, 204);
  assert.equal((await second.get('/api/auth/me')).status, 401, 'other session revoked');
  assert.equal((await a.c.get('/api/auth/me')).status, 200, 'current session kept');
  assert.equal((await a.c.post('/api/auth/logout-all')).status, 204);
  assert.equal((await a.c.get('/api/auth/me')).status, 401);
});

test('S20 login throttling: 5 failures lock the account for correct password too', async () => {
  const u = await signUp(srv.base, 'Throttle');
  const c = client(srv.base);
  for (let i = 0; i < 5; i++) {
    assert.equal((await c.post('/api/auth/login', { email: u.email, password: 'wrong-password-here' })).status, 401);
  }
  assert.equal((await c.post('/api/auth/login', { email: u.email, password: 'wrong-password-here' })).status, 429);
  assert.equal((await c.post('/api/auth/login', { email: u.email, password: 'correct-horse-battery' })).status, 429);
});

test('unauthenticated access is rejected on every data route', async () => {
  const c = client(srv.base);
  for (const p of ['/api/projects', '/api/ideas', '/api/life-areas', '/api/dashboard', '/api/workspaces']) {
    assert.equal((await c.get(p)).status, 401, p);
  }
  assert.equal((await c.get('/api/health')).status, 200);
});

test('security headers and cross-origin write blocking', async () => {
  const u = await signUp(srv.base, 'Hdr');
  const res = await u.c.get('/api/projects');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-powered-by'), null);
  const evil = await u.c.post('/api/projects', { name: 'x' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const same = await u.c.post('/api/projects', { name: 'x' }, { origin: srv.base });
  assert.equal(same.status, 201);
});

test('migrations are idempotent', async () => {
  const { db } = await import('../src/db.js');
  const { migrate } = await import('../src/migrations.js');
  migrate(db);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 6);
});
