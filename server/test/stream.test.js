// Streaming answers (server-sent events), named steps, Stop, interrupted answers. The AI provider is a fake that streams.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp } from './helpers.js';

let srv, ai, db;
let plan = [];   // per model call: { chunks:[...], gap:ms, json:true, status }
const seen = [];
before(async () => {
  ai = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', async () => {
      const step = plan.shift() ?? { chunks: [JSON.stringify({ type: 'final', answer: 'default' })] };
      seen.push(JSON.parse(b).stream === true);
      if (step.status) { res.statusCode = step.status; return res.end('{}'); }
      if (step.json) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ choices: [{ message: { content: step.chunks.join('') } }], usage: {} })); }
      res.setHeader('content-type', 'text/event-stream');
      for (const c of step.chunks) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, step.gap ?? 5));
      }
      if (step.hang) return;                 // keeps the connection open (the test aborts)
      res.write('data: {"usage":{"prompt_tokens":3,"completion_tokens":4},"choices":[]}\n\ndata: [DONE]\n\n'); res.end();
    });
  });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  srv = await startServer();
  process.env.DEEPSEEK_API_KEY = 'k'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
  ({ db } = await import('../src/db.js'));
});
after(() => { srv.close(); ai.close(); });

const events = (text) => text.split('\n\n').map((b) => b.replace(/^data: /, '').trim()).filter(Boolean).map((j) => JSON.parse(j));
const stream = (u, message, conversationId) => u.c.post('/api/ai/assistant/chat/stream', { message, conversationId });
const fin = (answer, extra = {}) => JSON.stringify({ type: 'final', answer, ...extra });
const split = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'gs'));

test('the answer arrives piece by piece, then the finished message', async () => {
  const u = await signUp(srv.base, 'StrA');
  plan = [{ chunks: split(fin('Hello there, this is streamed.\n\nSecond paragraph.', { suggestions: ['Next'] }), 9) }];
  const r = await stream(u, 'hi');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const ev = events(r.text);
  const deltas = ev.filter((e) => e.type === 'delta');
  assert.ok(deltas.length >= 3, 'several pieces');
  assert.equal(deltas.map((d) => d.text).join(''), 'Hello there, this is streamed.\n\nSecond paragraph.');
  const done = ev.at(-1);
  assert.equal(done.type, 'done'); assert.equal(done.message.content, 'Hello there, this is streamed.\n\nSecond paragraph.');
  assert.deepEqual(done.message.suggestions, ['Next']); assert.ok(done.message.created_at); assert.equal(done.message.incomplete, false);
  assert.ok(seen.at(-1), 'the provider was asked to stream');
  assert.ok(db.prepare("SELECT 1 FROM ai_usage WHERE purpose = 'assistant' AND prompt_tokens = 3").get(), 'usage from the stream is recorded');
});

test('a provider that answers with plain JSON still works', async () => {
  const u = await signUp(srv.base, 'StrB');
  plan = [{ json: true, chunks: [fin('Plain answer.')] }];
  const ev = events((await stream(u, 'hi')).text);
  assert.deepEqual(ev.filter((e) => e.type === 'delta').map((d) => d.text), ['Plain answer.']);
  assert.equal(ev.at(-1).message.content, 'Plain answer.');
});

test('tools show as named steps with timings; tool rounds stream no text', async () => {
  const u = await signUp(srv.base, 'StrC');
  plan = [{ chunks: split(JSON.stringify({ type: 'tool', calls: [{ tool: 'project_health', args: {} }, { tool: 'list_tasks', args: {} }] }), 20) },
    { chunks: split(fin('Done looking.', { progress: { step: 2, of: 4 } }), 15) }];
  const ev = events((await stream(u, 'how are my projects')).text);
  const steps = ev.filter((e) => e.type === 'step');
  assert.deepEqual(steps.map((s) => `${s.label}:${s.state}`), ['Checking project health:running', 'Checked project health:done', 'Reading your tasks:running', 'Read your tasks:done']);
  assert.ok(steps[1].ms >= 0);
  assert.equal(ev.filter((e) => e.type === 'delta').map((d) => d.text).join(''), 'Done looking.', 'only the final answer is streamed');
  const m = ev.at(-1).message;
  assert.deepEqual(m.tool_trace.map((t) => [t.label, t.source]), [['Checked project health', 'Project health'], ['Read your tasks', 'Tasks']]);
  assert.equal(m.progress, null, 'progress only counts while a skill is active');
});

test('progress is kept only while a skill is active and only when sane', async () => {
  const u = await signUp(srv.base, 'StrD');
  plan = [{ json: true, chunks: [fin('Q1?', { progress: { step: 2, of: 4 } })] }];
  const m = events((await stream(u, '/create-automation every monday')).text).at(-1).message;
  assert.deepEqual(m.progress, { step: 2, of: 4 });
  plan = [{ json: true, chunks: [fin('Q2?', { progress: { step: 9, of: 4 } })] }];
  assert.equal(events((await stream(u, 'next', events((await stream(u, '/create-automation x')).text).at(-1).conversationId)).text).at(-1).message.progress, null);
});

test('Stop: closing the connection keeps what was written and marks it incomplete', async () => {
  const u = await signUp(srv.base, 'StrE');
  plan = [{ chunks: split(fin('This answer is long and gets stopped before it is finished, really.'), 6), gap: 40, hang: true }];
  const ctrl = new AbortController();
  const res = await fetch(`${srv.base}/api/ai/assistant/chat/stream`, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', cookie: u.c.cookie, 'x-workspace-id': u.personalId }, body: JSON.stringify({ message: 'write a lot' }) });
  const reader = res.body.getReader(); let got = '';
  while ((got.match(/"type":"delta"/g) || []).length < 4) { const { value, done } = await reader.read(); if (done) break; got += Buffer.from(value).toString('utf8'); }
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 400));
  const conv = (await u.c.get('/api/ai/assistant/conversations')).json[0];
  const msgs = (await u.c.get(`/api/ai/assistant/conversations/${conv.id}`)).json.messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].incomplete, true); assert.match(msgs[1].content, /^This answer is long/); assert.ok(msgs[1].content.length < 60);
  assert.equal(db.prepare('SELECT outcome FROM ai_turns WHERE message_id = ?').get(msgs[1].id).outcome, 'interrupted');
});

test('errors arrive as an event with the right status', async () => {
  const u = await signUp(srv.base, 'StrF');
  plan = [{ status: 500 }, { status: 500 }];
  const ev = events((await stream(u, 'hi')).text);
  assert.deepEqual([ev.at(-1).type, ev.at(-1).status], ['error', 502]);
  const k = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY;
  assert.equal(events((await stream(u, 'hi')).text).at(-1).status, 503);
  process.env.DEEPSEEK_API_KEY = k;
  assert.equal((await u.c.post('/api/ai/assistant/chat/stream', { message: '   ' })).status, 400);
});
