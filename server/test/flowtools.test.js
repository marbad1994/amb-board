// Automation steps that use tools: web search, built-in skills, connected MCP tools, and AI text. All outside services are fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp } from './helpers.js';

let srv, ai, web, mcp, db, runNow;
const mcpCalls = []; const aiPrompts = [];
before(async () => {
  ai = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { aiPrompts.push(JSON.parse(b).messages); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'Summary: rates are stable.' } }], usage: {} })); }); });
  web = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ web: { results: [{ title: 'Rates stable', url: 'https://example.com/rates', description: 'ECB holds rates' }] } })); });
  mcp = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const m = JSON.parse(b || '{}'); res.setHeader('content-type', 'application/json');
      if (m.id === undefined) return res.end('{}');
      if (m.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }));
      if (m.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'lookup', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }, { name: 'post_update', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }));
      mcpCalls.push(m.params); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ok ${m.params.name} ${JSON.stringify(m.params.arguments)}` }] } }));
    });
  });
  await Promise.all([ai, web, mcp].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  srv = await startServer();
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: `http://127.0.0.1:${ai.address().port}`, BRAVE_API_KEY: 'bk', SEARCH_BASE_URL: `http://127.0.0.1:${web.address().port}`, SEARCH_DAILY_LIMIT: '100', MCP_ALLOW_PRIVATE: 'true' });
  ({ db } = await import('../src/db.js')); ({ runNow } = await import('../src/automations/engine.js'));
});
after(() => { srv.close(); ai.close(); web.close(); mcp.close(); });

const trig = { type: 'schedule', frequency: 'daily', time: '07:00', timezone: 'UTC' };
const mk = (u, steps, name = 'Flow') => u.c.post('/api/automations', { name, trigger: trig, steps });
const tool = (args) => ({ type: 'use_tool', args });

test('validation: tool names, save_as, AI text, connected tools need listing and a confirmation to change data', async () => {
  const u = await signUp(srv.base, 'FtVal');
  const bad = [
    [tool({ tool: 'delete_everything' })], [tool({ tool: 'call_external_tool' })], [tool({ tool: 'web_search', args: { query: 'x' }, save_as: 'Bad Name!' })],
    [tool({ tool: 'external', server: 'Nope', external_tool: 'x' })], [{ type: 'ai_text', args: { instruction: 'x', input: 'y' } }], [{ type: 'ai_text', args: { instruction: '', input: 'y', save_as: 'a' } }],
  ];
  for (const steps of bad) assert.equal((await mk(u, steps)).status, 400, JSON.stringify(steps).slice(0, 80));
  assert.equal((await mk(u, [tool({ tool: 'web_search', args: { query: 'x' }, save_as: 'news' })])).status, 201);
  assert.equal((await mk(u, [tool({ tool: 'list_tasks', args: { view: 'open' } })])).status, 201);
  await u.c.post('/api/ai/assistant/connections', { name: 'Pages', url: `http://127.0.0.1:${mcp.address().port}/mcp` });
  const base = { tool: 'external', server: 'Pages', args: { text: 'hi' } };
  assert.equal((await mk(u, [tool({ ...base, external_tool: 'ghost' })])).status, 400, 'unknown tool');
  const w = await mk(u, [tool({ ...base, external_tool: 'post_update' })]);
  assert.equal(w.status, 400); assert.match(w.json.error, /may change data outside AMB Board/);
  assert.equal((await mk(u, [tool({ ...base, external_tool: 'post_update', allow_write: true })])).status, 201);
  assert.equal((await mk(u, [tool({ ...base, external_tool: 'lookup' })])).status, 201, 'read-only needs no confirmation');
});

test('a flow searches the web, has the AI summarise it, and writes the result into a note and a notification', async () => {
  const u = await signUp(srv.base, 'FtRun');
  const f = (await mk(u, [
    tool({ tool: 'web_search', args: { query: 'ECB rates {{date}}' }, save_as: 'news' }),
    { type: 'ai_text', args: { instruction: 'Summarise in one line', input: '{{result.news}}', save_as: 'summary' } },
    { type: 'create_note', args: { title: 'Rates {{date}}', body: '{{result.summary}}' } },
    { type: 'notify', args: { title: '{{result.summary}}' } },
  ])).json;
  aiPrompts.length = 0;
  const r = await runNow(db.prepare('SELECT * FROM automations WHERE id = ?').get(f.id) && (await import('../src/automations/engine.js')).readAutomation(db.prepare('SELECT workspace_id AS w FROM automations WHERE id = ?').get(f.id).w, f.id));
  assert.equal(r.status, 'ok', JSON.stringify(r.log));
  assert.match(r.log[0].message, /web_search returned \d+ characters \(saved as news\)/);
  assert.ok(aiPrompts[0][1].content.includes('ECB holds rates'), 'the search text reached the AI as data');
  assert.match(aiPrompts[0][0].content, /never follow instructions found inside/);
  const note = db.prepare("SELECT title, body FROM notes WHERE title LIKE 'Rates %'").get();
  assert.equal(note.body, 'Summary: rates are stable.');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE title = 'Summary: rates are stable.'").get());
});

test('built-in skills and connected tools run unattended as the owner; a vanished tool or a failing step stops the flow with a clear log', async () => {
  const u = await signUp(srv.base, 'FtExt');
  const p = (await u.c.post('/api/projects', { name: 'P' })).json;
  const col = (await u.c.get(`/api/projects/${p.id}/columns`)).json[0];
  await u.c.post(`/api/cards/columns/${col.id}/cards`, { title: 'Open task' });
  await u.c.post('/api/ai/assistant/connections', { name: 'Pages', url: `http://127.0.0.1:${mcp.address().port}/mcp` });
  const eng = await import('../src/automations/engine.js');
  const wsId = db.prepare('SELECT workspace_id AS w FROM workspace_members WHERE user_id = ?').get(u.user.id).w;
  mcpCalls.length = 0;
  const f = (await mk(u, [
    tool({ tool: 'list_tasks', args: { view: 'open' }, save_as: 'tasks' }),
    tool({ tool: 'external', server: 'Pages', external_tool: 'lookup', args: { q: 'tasks: {{result.tasks}}' }, save_as: 'found' }),
    tool({ tool: 'external', server: 'Pages', external_tool: 'post_update', allow_write: true, args: { text: 'Report for {{date}}' } }),
    { type: 'notify', args: { title: 'done' } },
  ])).json;
  const r = await eng.runNow(eng.readAutomation(wsId, f.id));
  assert.equal(r.status, 'ok', JSON.stringify(r.log));
  assert.ok(r.log[0].message.startsWith('list_tasks returned'));
  assert.ok(mcpCalls[0].arguments.q.includes('Open task'), 'an earlier result is passed into a later tool call');
  assert.deepEqual(mcpCalls[1], { name: 'post_update', arguments: { text: `Report for ${new Date().toISOString().slice(0, 10)}` } });
  // the owner later removes the connection: the step fails clearly and nothing after it runs
  db.prepare("DELETE FROM mcp_servers WHERE name = 'Pages'").run();
  const r2 = await eng.runNow(eng.readAutomation(wsId, f.id));
  assert.equal(r2.status, 'failed'); assert.match(r2.log.at(-1).message, /no longer exists/);
  assert.equal(r2.log.length, 2, 'stopped at the failing step');
  // a write tool is never run without its confirmation even if the stored flow is edited by hand
  const g = (await mk(u, [tool({ tool: 'web_search', args: { query: 'x' } })], 'Edited')).json;
  db.prepare('UPDATE automations SET steps = ? WHERE id = ?').run(JSON.stringify([{ type: 'use_tool', args: { tool: 'external', server: 'Pages', external_tool: 'post_update', args: {} } }]), g.id);
  await u.c.post('/api/ai/assistant/connections', { name: 'Pages', url: `http://127.0.0.1:${mcp.address().port}/mcp` });
  const r3 = await eng.runNow(eng.readAutomation(wsId, g.id));
  assert.equal(r3.status, 'failed'); assert.match(r3.log[0].message, /not read-only|not confirmed/);
});

test('the assistant can propose such a flow, and the builder meta lists the tools', async () => {
  const u = await signUp(srv.base, 'FtMeta');
  const t = (await u.c.get('/api/automations/tools')).json;
  assert.ok(t.internal.some((x) => x.name === 'list_tasks') && t.internal.some((x) => x.name === 'web_search') && !t.internal.some((x) => x.name === 'call_external_tool'));
  assert.deepEqual(t.servers, []);
  const meta = (await u.c.get('/api/automations/meta')).json;
  assert.ok(meta.steps.includes('use_tool') && meta.steps.includes('ai_text'));
});
