// Email in automations, the template language, email templates, and the assistant's complete knowledge of flows. All outside services are fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp, client } from './helpers.js';

let srv, ai, web, mcp, db, mailer, tpl, eng;
const sent = []; const aiReqs = []; let script = [];
before(async () => {
  ai = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const m = JSON.parse(b).messages; aiReqs.push(m);
    const content = m[0].content.includes('plain text for a personal planner') ? 'Rates are stable. <b>no markup</b>' : JSON.stringify(script.shift() ?? { type: 'final', answer: 'x', proposals: [] });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} })); }); });
  web = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ web: { results: [{ title: 'Rates stable', url: 'https://example.com/rates', description: 'ECB holds rates' }] } })); });
  mcp = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const m = JSON.parse(b || '{}'); res.setHeader('content-type', 'application/json'); if (m.id === undefined) return res.end('{}');
    if (m.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'lookup', description: 'Find a page', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } }] } })); }); });
  await Promise.all([ai, web, mcp].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  srv = await startServer();
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: `http://127.0.0.1:${ai.address().port}`, BRAVE_API_KEY: 'bk', SEARCH_BASE_URL: `http://127.0.0.1:${web.address().port}`, SEARCH_DAILY_LIMIT: '500', MCP_ALLOW_PRIVATE: 'true' });
  ({ db } = await import('../src/db.js')); mailer = await import('../src/notifications/mailer.js'); tpl = await import('../src/automations/template.js'); eng = await import('../src/automations/engine.js');
  mailer.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
});
after(() => { srv.close(); ai.close(); web.close(); mcp.close(); });
const trig = { type: 'schedule', frequency: 'daily', time: '07:00', timezone: 'UTC' };
const mk = (u, steps, name = 'Mailer') => u.c.post('/api/automations', { name, trigger: trig, steps });
const wsOf = (u) => db.prepare('SELECT workspace_id AS w FROM workspace_members WHERE user_id = ?').get(u.user.id).w;

test('template language: placeholders, filters, readable tool results, unknown names empty, HTML and links safe', () => {
  const ctx = { date: '2027-01-02', 'owner.name': '', 'result.news': JSON.stringify({ results: [{ title: 'A', url: 'https://a.io', snippet: 's1' }] }), 'result.list': 'one\ntwo\nthree\nfour' };
  assert.equal(tpl.render('{{date}}|{{ owner.name | default:"there" }}|{{nope}}|{not}|{{x y}}', ctx), '2027-01-02|there||{not}|{{x y}}');
  assert.equal(tpl.render('{{result.list | lines:2}} / {{result.list | count_lines}} / {{result.list | bullets | first_line}} / {{result.list | upper | truncate:5}}', ctx), 'one\ntwo / 4 / - one / ONE…');
  assert.match(tpl.render('{{result.news | pretty}}', ctx), /- A\n {2}https:\/\/a\.io\n {2}s1/);
  const html = tpl.markdownToHtml('# T\n\n- a **b**\n- <img src=x onerror=1>\n\n[ok](https://x.io) [bad](javascript:alert(1)) https://y.io <script>x</script>');
  assert.ok(html.includes('<strong>b</strong>') && html.includes('&lt;img') && html.includes('href="https://x.io"') && html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('href="javascript') && !html.includes('<img') && !html.includes('<script'));
  assert.ok(tpl.emailDocument({ bodyText: 'hi', footer: 'f' }).includes('AMB Board'));
});

test('send_email validation: recipients, templates, content, and email must be set up', async () => {
  const u = await signUp(srv.base, 'EmVal');
  const email = (args) => [{ type: 'send_email', args }];
  for (const bad of [{ to: [], subject: 's', body: 'b' }, { to: ['not-an-email'], subject: 's', body: 'b' }, { to: ['a@b.io', 'c@d.io', 'e@f.io', 'g@h.io', 'i@j.io', 'k@l.io'], subject: 's', body: 'b' },
    { to: ['me'], subject: '', body: 'b' }, { to: ['me'], subject: 's', body: '' }, { to: ['me'], template: 'no_such_template' }, { to: ['evil@x.io\nbcc: y@z.io'], subject: 's', body: 'b' }]) {
    assert.equal((await mk(u, email(bad))).status, 400, JSON.stringify(bad).slice(0, 70));
  }
  const ok = await mk(u, email({ to: ['ME', 'Pat@Example.com', 'pat@example.com'], subject: 'Hi\nthere', body: 'Body' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json)); assert.deepEqual(ok.json.steps[0].args.to, ['me', 'pat@example.com']); assert.equal(ok.json.steps[0].args.subject, 'Hi there');
  assert.equal((await mk(u, email({ to: ['me'], template: 'daily_digest' }))).status, 201, 'built-in template needs no subject or body');
  mailer.setTransportForTests(null); delete process.env.SMTP_PASS;
  const off = await mk(u, email({ to: ['me'], subject: 's', body: 'b' }));
  assert.equal(off.status, 400); assert.match(off.json.error, /not set up/);
  mailer.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
});

test('a flow searches, summarises with AI and emails the result; each recipient gets their own message; footer, reply-to and escaping are right; limits hold', async () => {
  const u = await signUp(srv.base, 'EmRun');
  const wsId = wsOf(u);
  const t = (await u.c.post('/api/automations/templates', { name: 'Rates note', subject: 'Rates for {{date}}: {{result.summary | first_line | truncate:40}}', body: '# {{owner.name}}\n\n{{result.summary}}\n\nSources:\n\n{{result.news | pretty}}\n\n[Open AMB](https://amb.makketing.com)' })).json;
  const f = (await mk(u, [
    { type: 'use_tool', args: { tool: 'web_search', args: { query: 'rates' }, save_as: 'news' } },
    { type: 'ai_text', args: { instruction: 'Summarise', input: '{{result.news | pretty}}', save_as: 'summary' } },
    { type: 'send_email', args: { to: ['me', 'boss@example.com'], template: t.id } },
  ], 'Rates mail')).json;
  sent.length = 0;
  const r = await eng.runNow(eng.readAutomation(wsId, f.id));
  assert.equal(r.status, 'ok', JSON.stringify(r.log));
  assert.equal(sent.length, 2, 'one message per recipient, nobody sees the other');
  assert.deepEqual(sent.map((m) => m.to).sort(), ['boss@example.com', u.email.toLowerCase()].sort());
  const m = sent[0];
  assert.equal(m.replyTo, u.email); assert.match(m.subject, /^Rates for \d{4}-\d{2}-\d{2}: Rates are stable\./);
  assert.ok(m.html.includes('Rates are stable. &lt;b&gt;no markup&lt;/b&gt;'), 'AI text is escaped in the HTML');
  assert.ok(m.html.includes('Rates stable') && m.html.includes('https://example.com/rates') && m.html.includes('href="https://amb.makketing.com"'));
  assert.ok(m.text.includes('Sent by the AMB Board automation "Rates mail"') && m.text.includes(`Reply to this email to reach ${u.user.name}`));
  assert.match(r.log.at(-1).message, /sent to 2 recipients/);
  // limit: 20 per flow per day
  const g = (await mk(u, [{ type: 'send_email', args: { to: ['me'], subject: 's', body: 'b' } }], 'Flood')).json;
  const au = eng.readAutomation(wsId, g.id);
  for (let i = 0; i < 20; i += 1) assert.equal((await eng.runNow(au)).status, 'ok');
  const over = await eng.runNow(au);
  assert.equal(over.status, 'failed'); assert.match(over.log.at(-1).message, /daily email limit/);
  assert.equal(db.prepare('SELECT COALESCE(SUM(recipients), 0) AS n FROM email_sends WHERE automation_id = ?').get(g.id).n, 20);
});

test('email templates: built-ins and own, preview with sample data, rights, and deletion blocked while used', async () => {
  const u = await signUp(srv.base, 'EmTpl');
  const list = (await u.c.get('/api/automations/templates')).json;
  assert.ok(list.builtin.some((b) => b.key === 'daily_digest') && list.filters.pretty);
  assert.equal((await u.c.post('/api/automations/templates', { name: 'x', subject: '', body: 'b' })).status, 400);
  const t = (await u.c.post('/api/automations/templates', { name: 'Alert', subject: 'Alert {{trigger.title}}', body: 'See {{result.x | upper}}' })).json;
  const pv = (await u.c.post('/api/automations/email-preview', { template: t.id })).json;
  assert.match(pv.subject, /^Alert \[sample trigger\.title\]/); assert.ok(pv.html.includes('SAMPLE RESULT.X')); assert.deepEqual(pv.placeholders.sort(), ['result.x', 'trigger.title']);
  const used = (await mk(u, [{ type: 'send_email', args: { to: ['me'], template: t.id } }])).json;
  const del = await u.c.del(`/api/automations/templates/${t.id}`);
  assert.equal(del.status, 409); assert.match(del.json.error, /Mailer/);
  await u.c.del(`/api/automations/${used.id}`);
  assert.equal((await u.c.del(`/api/automations/templates/${t.id}`)).status, 204);
  const other = await signUp(srv.base, 'EmTplOther');
  assert.deepEqual((await other.c.get('/api/automations/templates')).json.custom, [], 'templates are per workspace');
});

test('the assistant has the complete picture: guide, full flows, templates, connected tools; it can change, delete and run flows and manage templates', async () => {
  const u = await signUp(srv.base, 'EmAi');
  await u.c.post('/api/ai/assistant/connections', { name: 'Pages', url: `http://127.0.0.1:${mcp.address().port}/mcp` });
  const t = (await u.c.post('/api/automations/templates', { name: 'Mine', subject: 's', body: 'b' })).json;
  const f = (await mk(u, [{ type: 'send_email', args: { to: ['me'], template: t.id } }], 'Existing')).json;
  script = [{ type: 'tool', calls: [{ tool: 'automation_guide', args: {} }] }, { type: 'final', answer: 'x', proposals: [] }];
  aiReqs.length = 0; await u.c.post('/api/ai/assistant/chat', { message: 'what can automations do?' });
  const first = aiReqs[0][1].content; const guide = aiReqs.at(-1)[1].content;
  assert.match(aiReqs[0][0].content, /BEFORE designing, creating or changing a flow call automation_guide/);
  assert.ok(first.includes('"email_templates"') && first.includes('"Existing"') && first.includes('"steps":["send_email"]'), 'snapshot knows flows, their steps and templates');
  for (const must of ['send_email', 'use_tool', 'ai_text', 'result.NAME', 'pretty', 'truncate', 'web_search', 'read_web_page', 'project_health', 'Pages', '"lookup"', 'daily_digest', f.id, t.id, 'ways_to_create_or_change_flows', 'update_automation', 'setup_plan', 'transaction_added', 'weekday']) assert.ok(guide.includes(must), `guide mentions ${must}`);
  assert.ok(!guide.includes('browser_fill'.concat('"')) || guide.includes('not_in_flows'), 'browser tools are listed as not usable in flows');
  script = [{ type: 'tool', calls: [{ tool: 'list_automations', args: {} }] }, { type: 'final', answer: 'x', proposals: [] }];
  aiReqs.length = 0; await u.c.post('/api/ai/assistant/chat', { message: 'list my flows' });
  assert.ok(aiReqs.at(-1)[1].content.includes('"template":"') && aiReqs.at(-1)[1].content.includes('"to":["me"]'), 'full step arguments are visible');
  // change steps: the proposal describes the email recipients; approval replaces the flow
  script = [{ type: 'final', answer: 'ok', proposals: [{ type: 'update_automation', args: { automation_id: f.id, name: 'Renamed', steps: [{ type: 'send_email', args: { to: ['me', 'ops@example.com'], subject: 'Hi {{date}}', body: 'Body' } }] } }] }];
  const r1 = (await u.c.post('/api/ai/assistant/chat', { message: 'email ops too' })).json;
  const p1 = r1.message.proposals[0]; assert.match(p1.description, /email you, ops@example\.com/);
  assert.equal((await u.c.post(`/api/ai/assistant/proposals/${p1.id}/approve`)).status, 200);
  const now = (await u.c.get(`/api/automations/${f.id}`)).json; assert.equal(now.name, 'Renamed'); assert.deepEqual(now.steps[0].args.to, ['me', 'ops@example.com']);
  // plan: a template plus a flow that uses it by reference, then a destructive delete needs its warning
  script = [{ type: 'final', answer: 'ok', proposals: [{ type: 'setup_plan', args: { title: 'Digest', steps: [
    { ref: 't1', type: 'create_email_template', args: { name: 'Digest', subject: 'Digest {{date}}', body: '{{result.d | pretty}}' } },
    { type: 'create_automation', args: { name: 'Digest flow', trigger: trig, steps: [{ type: 'use_tool', args: { tool: 'list_tasks', args: {}, save_as: 'd' } }, { type: 'send_email', args: { to: ['me'], template: '@t1' } }] } }] } }] }];
  const r2 = (await u.c.post('/api/ai/assistant/chat', { message: 'daily task digest by email' })).json;
  assert.equal(r2.message.proposals.length, 1, JSON.stringify(r2.dropped));
  assert.equal((await u.c.post(`/api/ai/assistant/proposals/${r2.message.proposals[0].id}/approve`)).status, 200);
  const made = db.prepare("SELECT steps FROM automations WHERE name = 'Digest flow'").get();
  assert.equal(JSON.parse(made.steps)[1].args.template, db.prepare("SELECT id FROM email_templates WHERE name = 'Digest'").get().id);
  script = [{ type: 'final', answer: 'ok', proposals: [{ type: 'delete_automation', args: { automation_id: f.id } }, { type: 'delete_email_template', args: { template_id: t.id } }] }];
  const r3 = (await u.c.post('/api/ai/assistant/chat', { message: 'remove them' })).json;
  assert.match(r3.message.proposals[0].description, /^DELETE automation "Renamed"/);
  assert.equal(r3.message.proposals.length + r3.dropped.length, 2);
  assert.ok(db.prepare('SELECT 1 FROM automations WHERE id = ?').get(f.id), 'nothing is deleted before approval');
  // MCP clients get none of this
  const tok = (await u.c.post('/api/tokens', { name: 'x' })).json;
  const names = (await client(srv.base).post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${tok.token}` })).json.result.tools.map((x) => x.name);
  assert.ok(!names.some((n) => /^propose_.*(automation|email_template)/.test(n)) && !names.includes('automation_guide'), 'no flow changes or personal tool lists for token holders');
});
