// Ways to authenticate a connected MCP server: none, bearer, custom header and OAuth 2.0 (PKCE, refresh). Outside services are fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { startServer, signUp } from './helpers.js';

let srv, mcp, idp, db, secrets, client; const seen = []; const grants = [];
const MCP = { jsonrpc: '2.0' };
before(async () => {
  mcp = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const m = JSON.parse(b || '{}'); res.setHeader('content-type', 'application/json');
    seen.push({ auth: req.headers.authorization, key: req.headers['x-api-key'], method: m.method });
    if (req.headers.authorization === 'Bearer revoked') { res.statusCode = 401; return res.end('{}'); }
    if (m.id === undefined) return res.end('{}');
    if (m.method === 'initialize') return res.end(JSON.stringify({ ...MCP, id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }));
    res.end(JSON.stringify({ ...MCP, id: m.id, result: { tools: [{ name: 'list_events', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] } }));
  }); });
  idp = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const f = Object.fromEntries(new URLSearchParams(b)); grants.push(f); res.setHeader('content-type', 'application/json');
    if (f.grant_type === 'authorization_code' && f.code !== 'good') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' })); }
    if (f.grant_type === 'refresh_token' && f.refresh_token !== 'rt1') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })); }
    res.end(JSON.stringify({ access_token: f.grant_type === 'refresh_token' ? 'at2' : 'at1', refresh_token: 'rt1', expires_in: 3600 }));
  }); });
  await Promise.all([mcp, idp].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  srv = await startServer();
  process.env.MCP_ALLOW_PRIVATE = 'true';
  ({ db } = await import('../src/db.js')); secrets = await import('../src/secrets.js'); client = await import('../src/ai/mcpClient.js');
});
after(() => { srv.close(); mcp.close(); idp.close(); });

const url = () => `http://127.0.0.1:${mcp.address().port}/mcp`;
const oauth = (extra = {}) => ({ client_id: 'cid', client_secret: 'csecret', auth_url: `http://127.0.0.1:${idp.address().port}/auth`, token_url: `http://127.0.0.1:${idp.address().port}/token`, scopes: 'cal.read, cal.write', auth_params: { access_type: 'offline', prompt: 'consent', evil: 'x' }, ...extra });
const callback = (u, qs) => fetch(`${srv.base}/api/oauth/mcp/callback?${new URLSearchParams(qs)}`, { headers: { cookie: u.c.cookie }, redirect: 'manual' });
const where = (r) => new URL(r.headers.get('location'), 'http://x');

test('options list the presets, the transport and the address to register with a provider', async () => {
  const u = await signUp(srv.base, 'McpOpt');
  const o = (await u.c.get('/api/ai/assistant/connections/options')).json;
  assert.deepEqual(o.auth_types, ['none', 'bearer', 'header', 'oauth']);
  assert.equal(o.transports[0].name, 'Streamable HTTP');
  const g = o.presets.find((p) => p.id === 'google-calendar');
  assert.equal(g.url, 'https://calendarmcp.googleapis.com/mcp/v1'); assert.equal(g.server_name, 'calendar'); assert.equal(g.auth_type, 'oauth');
  assert.match(o.redirect_uri, /\/api\/oauth\/mcp\/callback$/);
});

test('none, bearer and custom header are sent as chosen; bad choices are refused; secrets never come back', async () => {
  const u = await signUp(srv.base, 'McpSimple');
  const add = (b) => u.c.post('/api/ai/assistant/connections', { url: url(), ...b });
  assert.equal((await add({ name: 'open', auth_type: 'none' })).status, 201);
  assert.equal((await add({ name: 'b1', auth_type: 'bearer' })).status, 400, 'bearer needs a token');
  assert.equal((await add({ name: 'h1', auth_type: 'header', header_name: 'Authorization', token: 'x' })).status, 400, 'reserved header');
  assert.equal((await add({ name: 'h2', auth_type: 'header', header_name: 'X Api\r\nKey', token: 'x' })).status, 400);
  assert.equal((await add({ name: 'h3', auth_type: 'header', header_name: 'X-Api-Key' })).status, 400, 'value required');
  assert.equal((await add({ name: 'tr', transport: 'sse' })).status, 400);
  seen.length = 0;
  const b = await add({ name: 'bear', auth_type: 'bearer', token: 'tok-123' }); assert.equal(b.status, 201); assert.equal(b.json.tools, 1);
  assert.ok(seen.every((s) => s.auth === 'Bearer tok-123'));
  seen.length = 0;
  const h = await add({ name: 'keyed', auth_type: 'header', header_name: 'X-Api-Key', token: 'key-999' }); assert.equal(h.json.tools, 1);
  assert.ok(seen.length && seen.every((s) => s.key === 'key-999' && !s.auth));
  const legacy = await add({ name: 'old', token: 'tok-old' }); assert.equal(legacy.json.auth_type, 'bearer', 'a token alone still means bearer');
  const list = await u.c.get('/api/ai/assistant/connections');
  assert.ok(!list.text.includes('tok-123') && !list.text.includes('key-999'));
  assert.equal(list.json.find((c) => c.name === 'keyed').header_name, 'X-Api-Key');
});

test('oauth: authorize with PKCE, finish in the callback, use the token, refresh it, and fail clearly when it cannot be renewed', async () => {
  const u = await signUp(srv.base, 'McpOauth'); const other = await signUp(srv.base, 'McpOauthOther');
  const add = (o) => u.c.post('/api/ai/assistant/connections', { name: 'calendar', url: url(), auth_type: 'oauth', oauth: o });
  assert.equal((await add(oauth({ client_id: '' }))).status, 400);
  assert.equal((await add(oauth({ token_url: 'ftp://x' }))).status, 400);
  const made = await add(oauth()); assert.equal(made.status, 201, made.text);
  assert.equal(made.json.needs_authorization, true); assert.equal(made.json.oauth.authorized, false);
  assert.ok(!made.text.includes('csecret'));
  const early = await u.c.post(`/api/ai/assistant/connections/${made.json.id}/test`); assert.equal(early.status, 502); assert.match(early.json.error, /needs your authorization/);

  assert.equal((await other.c.post(`/api/ai/assistant/connections/${made.json.id}/authorize`)).status, 404);
  const a = new URL((await u.c.post(`/api/ai/assistant/connections/${made.json.id}/authorize`)).json.url);
  const q = a.searchParams;
  assert.equal(q.get('response_type'), 'code'); assert.equal(q.get('client_id'), 'cid'); assert.equal(q.get('scope'), 'cal.read cal.write');
  assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('access_type'), 'offline'); assert.equal(q.get('evil'), null, 'only known extra parameters pass');
  assert.match(q.get('redirect_uri'), /\/api\/oauth\/mcp\/callback$/);

  assert.equal(where(await callback(u, { code: 'good', state: 'wrong' })).searchParams.get('oauth'), 'error');
  assert.equal(where(await callback(other, { code: 'good', state: q.get('state') })).searchParams.get('oauth'), 'error', 'someone else cannot finish it');
  const denied = where(await callback(u, { error: 'access_denied', error_description: 'No thanks' }));
  assert.equal(denied.searchParams.get('oauth'), 'error'); assert.equal(denied.searchParams.get('message'), 'No thanks');
  grants.length = 0;
  const done = where(await callback(u, { code: 'good', state: q.get('state') }));
  assert.equal(done.pathname, '/settings'); assert.equal(done.searchParams.get('tab'), 'assistant'); assert.equal(done.searchParams.get('oauth'), 'ok');
  const g = grants.at(-1);
  assert.equal(g.grant_type, 'authorization_code'); assert.equal(g.client_secret, 'csecret'); assert.equal(g.redirect_uri, q.get('redirect_uri'));
  assert.equal(createHash('sha256').update(g.code_verifier).digest('base64url'), q.get('code_challenge'), 'the verifier matches the challenge');
  assert.equal(where(await callback(u, { code: 'good', state: q.get('state') })).searchParams.get('oauth'), 'error', 'a state works once');

  seen.length = 0;
  const ok = await u.c.post(`/api/ai/assistant/connections/${made.json.id}/test`); assert.equal(ok.status, 200); assert.equal(ok.json.tools[0].name, 'list_events');
  assert.ok(seen.every((s) => s.auth === 'Bearer at1'));
  assert.equal((await u.c.get('/api/ai/assistant/connections')).json[0].oauth.authorized, true);
  assert.ok(!(await u.c.get('/api/ai/assistant/connections')).text.includes('at1'));

  // the token is about to expire: it is renewed with the refresh token before the next call
  const expire = (patch) => { const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(made.json.id); const meta = JSON.parse(secrets.decryptSecret(row.auth_meta_enc)); db.prepare('UPDATE mcp_servers SET auth_meta_enc = ? WHERE id = ?').run(secrets.encryptSecret(JSON.stringify({ ...meta, expires_at: new Date(Date.now() - 1000).toISOString(), ...patch })), made.json.id); };
  client.forgetServer(made.json.id); expire({}); seen.length = 0; grants.length = 0;
  assert.equal((await u.c.post(`/api/ai/assistant/connections/${made.json.id}/test`)).status, 200);
  assert.equal(grants[0].grant_type, 'refresh_token'); assert.ok(seen.every((s) => s.auth === 'Bearer at2'));
  client.forgetServer(made.json.id); expire({ refresh_token: 'rt-revoked' });
  const bad = await u.c.post(`/api/ai/assistant/connections/${made.json.id}/test`); assert.equal(bad.status, 502); assert.match(bad.json.error, /press Authorize again/);
  client.forgetServer(made.json.id); expire({ refresh_token: '' });
  assert.match((await u.c.post(`/api/ai/assistant/connections/${made.json.id}/test`)).json.error, /expired/);
});

test('a server that rejects the credentials is reported as such, and old connections keep working after the migration', async () => {
  const u = await signUp(srv.base, 'McpReject');
  const r = await u.c.post('/api/ai/assistant/connections', { name: 'rev', url: url(), auth_type: 'bearer', token: 'revoked' });
  assert.match(r.json.warning, /refused the sign-in \(401\)/);
  // a row written the old way (token in auth_enc, no auth_type given) is still a bearer connection
  const ws = db.prepare('SELECT workspace_id AS w FROM mcp_servers WHERE name = ?').get('rev').w; const uid = db.prepare('SELECT user_id AS u FROM mcp_servers WHERE name = ?').get('rev').u;
  db.prepare('INSERT INTO mcp_servers (id, workspace_id, user_id, name, url, auth_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy1', ws, uid, 'legacy', url(), secrets.encryptSecret('tok-legacy'), new Date().toISOString());
  seen.length = 0; assert.equal((await u.c.post('/api/ai/assistant/connections/legacy1/test')).status, 200);
  assert.ok(seen.every((s) => s.auth === 'Bearer tok-legacy'));
});
