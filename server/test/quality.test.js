// Fallbacks, guaranteed next steps, answer feedback and the quality summary. The AI provider is MOCKED (raw replies).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp } from './helpers.js';

let srv, ai, db;
let replies = []; let calls = 0;
const json = (o) => JSON.stringify(o);
before(async () => {
  ai = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { calls += 1; res.setHeader('content-type', 'application/json'); res.end(json({ choices: [{ message: { content: replies.shift() ?? json({ type: 'final', answer: 'x' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  srv = await startServer();
  process.env.DEEPSEEK_API_KEY = 'k'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
  ({ db } = await import('../src/db.js'));
});
after(() => { srv.close(); ai.close(); });
const chat = async (u, message, script, conversationId) => { replies = script; calls = 0; return (await u.c.post('/api/ai/assistant/chat', { message, conversationId })).json; };
const outcome = (id) => db.prepare('SELECT outcome FROM ai_turns WHERE message_id = ?').get(id).outcome;

test('an unreadable reply is retried once, then shown as prose, never a dead error', async () => {
  const u = await signUp(srv.base, 'QaRetry');
  const fixed = await chat(u, 'hello', ['oops not json', json({ type: 'final', answer: 'Recovered.' })]);
  assert.equal(fixed.message.content, 'Recovered.'); assert.equal(calls, 2); assert.equal(outcome(fixed.message.id), 'ok');
  const prose = await chat(u, 'hello', ['Plain words, no JSON.', 'Still plain words.']);
  assert.equal(prose.message.content, 'Still plain words.'); assert.equal(outcome(prose.message.id), 'plain_text');
  const broken = await chat(u, 'hello', ['{"type":"final","answer":', '{"type":"fin']);
  assert.match(broken.message.content, /could not read my own answer/); assert.equal(outcome(broken.message.id), 'parse_error');
  assert.deepEqual(broken.message.suggestions, ['Give me an overview', 'What is overdue?', 'What can you do?']);
});

test('running out of steps gives options instead of a canned apology', async () => {
  const u = await signUp(srv.base, 'QaBudget');
  const tool = json({ type: 'tool', calls: [{ tool: 'list_projects', args: {} }] });
  const r = await chat(u, 'tell me everything', [tool, tool, tool, tool, json({ type: 'tool', calls: [] })]);
  assert.match(r.message.content, /ran out of steps/); assert.equal(outcome(r.message.id), 'budget_exhausted');
  assert.equal(r.message.suggestions.length, 3);
});

test('answers always leave something to click: derived next steps when the model gives none', async () => {
  const u = await signUp(srv.base, 'QaChips');
  assert.deepEqual((await chat(u, 'hi', [json({ type: 'final', answer: 'Do you want a report?' })])).message.suggestions, ['Yes', 'No', 'Something else']);
  assert.deepEqual((await chat(u, 'hi', [json({ type: 'final', answer: 'Done.' })])).message.suggestions, [], 'a statement needs no chips');
  const own = await chat(u, 'hi', [json({ type: 'final', answer: 'Do you want a report?', suggestions: ['Weekly', 'Monthly'] })]);
  assert.deepEqual(own.message.suggestions, ['Weekly', 'Monthly'], 'the model suggestions win');
  const guided = await chat(u, 'create an automation', [json({ type: 'final', answer: 'Working on it.' })]);
  assert.deepEqual(guided.message.suggestions, ['Go on', '/stop']);
  const drop = await chat(u, 'hi', [json({ type: 'final', answer: 'Here.', proposals: [{ type: 'create_task', args: { project_id: 'nope', title: 'x' } }] })]);
  assert.deepEqual(drop.message.suggestions, ['Try again', 'Tell me what to change']);
  assert.equal(db.prepare('SELECT derived_suggestions d FROM ai_turns WHERE message_id = ?').get(drop.message.id).d, 1);
});

test('thumbs and the quality summary', async () => {
  const u = await signUp(srv.base, 'QaFb');
  const a = await chat(u, 'hi', [json({ type: 'final', answer: 'One.' })]);
  const b = await chat(u, 'hi', [json({ type: 'final', answer: 'Two.' })], a.conversationId);
  await chat(u, 'hi', ['{"broken', '{"broken'], a.conversationId);
  assert.equal((await u.c.post(`/api/ai/assistant/messages/${a.message.id}/feedback`, { value: 'up' })).status, 200);
  assert.equal((await u.c.post(`/api/ai/assistant/messages/${b.message.id}/feedback`, { value: 'down' })).status, 200);
  assert.equal((await u.c.post(`/api/ai/assistant/messages/${b.message.id}/feedback`, { value: 'sideways' })).status, 400);
  const conv = (await u.c.get(`/api/ai/assistant/conversations/${a.conversationId}`)).json;
  assert.equal(conv.messages.find((m) => m.id === a.message.id).feedback, 'up');
  const q = (await u.c.get('/api/ai/assistant/quality')).json;
  assert.equal(q.turns, 3); assert.equal(q.fallback_rate_pct, 33.3); assert.deepEqual(q.thumbs, { up: 1, down: 1, satisfied_pct: 50 });
  // nobody else's messages, nobody else's numbers
  const other = await signUp(srv.base, 'QaOther');
  assert.equal((await other.c.post(`/api/ai/assistant/messages/${a.message.id}/feedback`, { value: 'up' })).status, 404);
  assert.equal((await other.c.get('/api/ai/assistant/quality')).json.turns, 0);
});
