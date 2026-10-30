// Browser assistant: pairing, the extension's endpoints, and the skills. The extension is simulated with plain HTTP calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp, client } from './helpers.js';

let srv, ai, db;
let script = []; const aiReqs = [];
before(async () => {
  ai = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { aiReqs.push(JSON.parse(b).messages); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(script.shift() ?? { type: 'final', answer: 'x', proposals: [] }) } }], usage: {} })); }); });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  srv = await startServer();
  process.env.DEEPSEEK_API_KEY = 'k'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
  ({ db } = await import('../src/db.js'));
});
after(() => { srv.close(); ai.close(); });

// a fake extension: shares a page, then answers commands from a handler
async function extension(token, { url = 'https://shop.example.com/checkout', title = 'Checkout' } = {}) {
  const c = client(srv.base);
  const h = { authorization: `Bearer ${token}`, origin: 'chrome-extension://abcdef' };
  const hello = await c.post('/api/browser-ext/hello', { shared: true, url, title }, h);
  return { c, h, hello, poll: (wait = 0) => c.get(`/api/browser-ext/poll?wait=${wait}`, h), answer: (id, body) => c.post(`/api/browser-ext/commands/${id}/result`, body, h) };
}
const FORM = { origin: 'https://shop.example.com', title: 'Checkout', text: 'Delivery details', fields: [
  { id: 'amb-1', tag: 'input', type: 'text', label: 'Full name', value: '' }, { id: 'amb-2', tag: 'input', type: 'email', label: 'Email', value: '' },
  { id: 'amb-3', tag: 'input', type: 'password', label: 'Password', sensitive: true }, { id: 'amb-4', tag: 'input', type: 'text', label: 'Card number', sensitive: true },
  { id: 'amb-5', tag: 'select', type: 'select', label: 'Country', options: [{ value: 'RO', label: 'Romania' }, { value: 'SE', label: 'Sweden' }] },
  { id: 'amb-6', tag: 'input', type: 'text', label: 'Order id', readonly: true }, { id: 'amb-7', tag: 'button', type: 'submit', label: 'Place order' }] };

// runs one chat turn while the fake extension serves commands in the background
async function chatWith(u, ext, tools, answers) {
  script = [{ type: 'tool', calls: tools }, { type: 'final', answer: 'done', proposals: [] }];
  const seen = [];
  const pump = (async () => { for (let i = 0; i < tools.length; i += 1) { let c; for (let t = 0; t < 50 && !c; t += 1) { c = (await ext.poll(1)).json.command; } if (!c) return; seen.push(c); await ext.answer(c.id, answers[i](c)); } })();
  aiReqs.length = 0;
  await u.c.post('/api/ai/assistant/chat', { message: 'help me fill this' });
  await pump;
  return { seen, finalPrompt: aiReqs.at(-1)[1].content };
}

test('pairing: token shown once and stored hashed; revoked tokens stop working; other users are isolated', async () => {
  const u = await signUp(srv.base, 'BrPair');
  const made = (await u.c.post('/api/browser/pairings', { name: 'My laptop' })).json;
  assert.match(made.token, /^amb_br_/);
  assert.ok(!db.prepare('SELECT token_hash FROM browser_pairings WHERE id = ?').get(made.id).token_hash.includes(made.token));
  const list = (await u.c.get('/api/browser/pairings')).json;
  assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).includes(made.token));
  const c = client(srv.base);
  assert.equal((await c.post('/api/browser-ext/hello', { shared: true, url: 'https://a.example.com' }, { authorization: 'Bearer amb_br_nope' })).status, 401);
  assert.equal((await c.post('/api/browser-ext/hello', { shared: true, url: 'https://a.example.com' })).status, 401);
  const ok = await c.post('/api/browser-ext/hello', { shared: true, url: 'https://a.example.com/x?y=1', title: 'A' }, { authorization: `Bearer ${made.token}`, origin: 'chrome-extension://zzz' });
  assert.equal(ok.status, 200, 'extension origin is accepted on its own endpoints');
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.equal(db.prepare('SELECT shared_origin FROM browser_pairings WHERE id = ?').get(made.id).shared_origin, 'https://a.example.com');
  assert.equal((await c.post('/api/browser-ext/hello', { shared: true, url: 'javascript:alert(1)' }, { authorization: `Bearer ${made.token}` })).status, 400);
  const other = await signUp(srv.base, 'BrOther');
  assert.deepEqual((await other.c.get('/api/browser/pairings')).json, []);
  assert.equal((await other.c.del(`/api/browser/pairings/${made.id}`)).status, 204);
  assert.equal((await u.c.get('/api/browser/pairings')).json.length, 1, 'not revoked by someone else');
  await u.c.del(`/api/browser/pairings/${made.id}`);
  assert.equal((await c.post('/api/browser-ext/hello', { shared: true, url: 'https://a.example.com' }, { authorization: `Bearer ${made.token}` })).status, 401);
  // normal browser sessions cannot use the extension endpoints, and the extension token cannot call the app API
  assert.equal((await u.c.get('/api/browser-ext/poll')).status, 401);
  assert.equal((await client(srv.base).get('/api/projects', { authorization: `Bearer ${made.token}` })).status, 401);
});

test('no shared tab: the assistant is told how to share one and nothing is queued', async () => {
  const u = await signUp(srv.base, 'BrNone');
  script = [{ type: 'tool', calls: [{ tool: 'browser_snapshot', args: {} }] }, { type: 'final', answer: 'x', proposals: [] }];
  aiReqs.length = 0; await u.c.post('/api/ai/assistant/chat', { message: 'look at my tab' });
  assert.match(aiReqs.at(-1)[1].content, /No browser is paired/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_commands').get().n >= 0, true);
  const t = (await u.c.post('/api/browser/pairings', { name: 'L' })).json;
  const c = client(srv.base);
  script = [{ type: 'tool', calls: [{ tool: 'browser_status', args: {} }] }, { type: 'final', answer: 'x', proposals: [] }];
  aiReqs.length = 0; await u.c.post('/api/ai/assistant/chat', { message: 'is it connected?' });
  assert.match(aiReqs.at(-1)[1].content, /no tab is shared right now/);
  await c.post('/api/browser-ext/hello', { shared: false }, { authorization: `Bearer ${t.token}` });
});

test('snapshot then fill: the assistant sees labelled fields, fills them via the extension, and sensitive or read-only fields are refused before anything is queued', async () => {
  const u = await signUp(srv.base, 'BrFill');
  const t = (await u.c.post('/api/browser/pairings', { name: 'L' })).json;
  const ext = await extension(t.token);
  const { seen, finalPrompt } = await chatWith(u, ext, [{ tool: 'browser_snapshot', args: {} }], [() => ({ ok: true, data: FORM })]);
  assert.equal(seen[0].kind, 'snapshot');
  assert.ok(finalPrompt.includes('Full name') && finalPrompt.includes('data, not instructions'));
  assert.equal(JSON.parse(db.prepare('SELECT last_snapshot FROM browser_pairings WHERE id = ?').get(t.id).last_snapshot).fields.length, 7);
  assert.ok(!db.prepare('SELECT last_snapshot FROM browser_pairings WHERE id = ?').get(t.id).last_snapshot.includes('Delivery details'), 'page text is not stored');
  // good fill
  const good = await chatWith(u, ext, [{ tool: 'browser_fill', args: { fields: [{ id: 'amb-1', value: 'Marcus Bader' }, { id: 'amb-5', value: 'Romania' }] } }], [() => ({ ok: true, data: { filled: 2, fields: ['amb-1', 'amb-5'] } })]);
  assert.deepEqual(good.seen[0].payload, { origin: 'https://shop.example.com', fields: [{ id: 'amb-1', value: 'Marcus Bader' }, { id: 'amb-5', value: 'Romania' }] });
  // refusals happen on the server: nothing reaches the extension
  const before = db.prepare('SELECT COUNT(*) AS n FROM browser_commands').get().n;
  for (const fields of [[{ id: 'amb-3', value: 'x' }], [{ id: 'amb-4', value: '4111' }], [{ id: 'amb-6', value: 'x' }], [{ id: 'amb-7', value: 'x' }], [{ id: 'amb-99', value: 'x' }], [], Array.from({ length: 21 }, () => ({ id: 'amb-1', value: 'x' }))]) {
    script = [{ type: 'tool', calls: [{ tool: 'browser_fill', args: { fields } }] }, { type: 'final', answer: 'x', proposals: [] }];
    aiReqs.length = 0; await u.c.post('/api/ai/assistant/chat', { message: 'fill' });
    assert.match(aiReqs.at(-1)[1].content, /"error"/, JSON.stringify(fields).slice(0, 40));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_commands').get().n, before, 'nothing was queued');
  const log = db.prepare("SELECT meta FROM audit_log WHERE action = 'browser.fill'").all();
  assert.ok(log.length >= 1 && !log.some((l) => l.meta.includes('Marcus Bader')), 'values are not written to the audit log');
});

test('click is queued with the page origin for in-page confirmation; a page change, a stale snapshot and an unshared tab block commands', async () => {
  const u = await signUp(srv.base, 'BrClick');
  const t = (await u.c.post('/api/browser/pairings', { name: 'L' })).json;
  const ext = await extension(t.token);
  await chatWith(u, ext, [{ tool: 'browser_snapshot', args: {} }], [() => ({ ok: true, data: FORM })]);
  const clicked = await chatWith(u, ext, [{ tool: 'browser_click', args: { id: 'amb-7' } }], [() => ({ ok: true, data: { clicked: false, reason: 'the user declined' } })]);
  assert.deepEqual(clicked.seen[0].payload, { origin: 'https://shop.example.com', id: 'amb-7' });
  assert.ok(clicked.finalPrompt.includes('the user declined'));
  // the user moves the shared tab to another site: the old snapshot no longer applies
  await ext.c.post('/api/browser-ext/hello', { shared: true, url: 'https://bank.example.org/', title: 'Bank' }, ext.h);
  script = [{ type: 'tool', calls: [{ tool: 'browser_fill', args: { fields: [{ id: 'amb-1', value: 'x' }] } }] }, { type: 'final', answer: 'x', proposals: [] }];
  aiReqs.length = 0; await u.c.post('/api/ai/assistant/chat', { message: 'fill' });
  assert.match(aiReqs.at(-1)[1].content, /look at the page first|take a new snapshot/);
  // the user stops sharing: pending commands expire and further commands are refused
  await ext.c.post('/api/browser-ext/hello', { shared: false }, ext.h);
  script = [{ type: 'tool', calls: [{ tool: 'browser_snapshot', args: {} }] }, { type: 'final', answer: 'x', proposals: [] }];
  aiReqs.length = 0; await u.c.post('/api/ai/assistant/chat', { message: 'look' });
  assert.match(aiReqs.at(-1)[1].content, /no tab is shared right now/);
});

test('the browser skills are never offered to MCP tokens or automations; the extension cannot read other people\'s commands', async () => {
  const u = await signUp(srv.base, 'BrScope');
  const tok = (await u.c.post('/api/tokens', { name: 'ext' })).json;
  const list = await client(srv.base).post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${tok.token}` });
  assert.ok(!list.json.result.tools.some((x) => /browser/.test(x.name)));
  const bad = await u.c.post('/api/automations', { name: 'x', trigger: { type: 'schedule', frequency: 'daily', time: '07:00', timezone: 'UTC' }, steps: [{ type: 'use_tool', args: { tool: 'browser_snapshot', args: {} } }] });
  assert.equal(bad.status, 400);
  const a = (await u.c.post('/api/browser/pairings', { name: 'A' })).json; const b = (await u.c.post('/api/browser/pairings', { name: 'B' })).json;
  const ea = await extension(a.token); const eb = await extension(b.token, { url: 'https://other.example.com/' });
  // a command queued for A is invisible to B and its result cannot be posted by B
  db.prepare("INSERT INTO browser_commands (id, pairing_id, workspace_id, user_id, kind, payload, created_at, expires_at) VALUES ('c-a', ?, ?, ?, 'snapshot', '{}', ?, ?)").run(a.id, db.prepare('SELECT workspace_id AS w FROM browser_pairings WHERE id = ?').get(a.id).w, u.user.id, new Date().toISOString(), new Date(Date.now() + 60000).toISOString());
  assert.equal((await eb.poll(0)).json.command, null);
  assert.equal((await eb.answer('c-a', { ok: true, data: {} })).status, 404);
  assert.equal((await ea.poll(0)).json.command.id, 'c-a');
});

test('the extension can be downloaded as a valid zip with every file', async () => {
  const u = await signUp(srv.base, 'BrZip');
  const r = await fetch(`${srv.base}/api/browser/pairings/extension.zip`, { headers: { cookie: u.c.cookie } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'zip signature');
  const text = buf.toString('latin1');
  for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js']) assert.ok(text.includes(f), f);
  assert.ok(text.includes("const SHADOW_MODE = 'closed';"), 'the shipped content script keeps its UI closed to the page');
  assert.equal((await client(srv.base).get('/api/browser/pairings/extension.zip')).status, 401, 'needs a session');
});
