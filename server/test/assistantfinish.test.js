// MOCKED provider. The assistant fixes its own rejected proposals, knows when it is finished and does not repeat itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, signUp } from './helpers.js';

let srv, fake; const requests = []; let script = [];
before(async () => {
  fake = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    requests.push(JSON.parse(b).messages); const next = script.shift() ?? { type: 'final', answer: 'default', proposals: [] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  srv = await startServer();
  process.env.DEEPSEEK_API_KEY = 'test-key'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
});
after(() => { srv.close(); fake.close(); });
const reset = (s = []) => { requests.length = 0; script = s; };
const ev = (extra) => ({ type: 'create_event', args: { title: 'Dentist', timezone: 'UTC', ...extra } });

test('rejected proposals are corrected by the assistant itself, with the exact errors in front of it', async () => {
  const u = await signUp(srv.base, 'FixOwn');
  reset([
    { type: 'final', answer: 'I prepared three events.', suggestions: [], proposals: [ev({ start_local: '2027-05-01T09:00', all_day: true }), ev({ title: 'Lunch', start_local: '2027-05-02T12:00', all_day: true }), ev({ title: 'Call', start_local: '2027-05-03T10:00' })] },
    { type: 'final', answer: '', proposals: [ev({ start_local: '2027-05-01', all_day: true }), ev({ title: 'Lunch', start_local: '2027-05-02', all_day: true })] },
  ]);
  const r = await u.c.post('/api/ai/assistant/chat', { message: 'Add the dentist on 1 May, lunch on 2 May and a call on 3 May' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.dropped.length, 0, 'nothing is left over for the person to fix');
  assert.equal(r.json.message.proposals.length, 3, 'one was valid at once, two were fixed');
  assert.deepEqual(r.json.message.proposals.map((p) => p.type), ['create_event', 'create_event', 'create_event']);
  assert.equal(requests.length, 2);
  const repair = requests[1].map((m) => m.content).join('\n');
  assert.match(repair, /start_local must be YYYY-MM-DD/); assert.match(repair, /rejected_proposals/);
  assert.ok(r.json.message.tool_trace.some((t) => t.tool === 'repair_suggestions' && /Fixed 2 suggestions/.test(t.label)), 'the fix is shown as a step');
});

test('when the repair cannot succeed the person is told once, after two tries', async () => {
  const u = await signUp(srv.base, 'FixFail');
  const bad = ev({ start_local: 'tomorrow' });
  reset([{ type: 'final', answer: 'Here you go.', proposals: [bad] }, { type: 'final', answer: '', proposals: [bad] }, 'not json']);
  const r = await u.c.post('/api/ai/assistant/chat', { message: 'dentist tomorrow' });
  assert.equal(requests.length, 3, 'one answer and at most two repair rounds');
  assert.equal(r.json.dropped.length, 1); assert.match(r.json.dropped[0].reason, /start_local must be/);
  assert.equal(r.json.message.proposals.length, 0);
});

test('finished means finished: done clears the suggestions, thanks ends the chat, earlier decisions are visible', async () => {
  const u = await signUp(srv.base, 'Finish');
  reset([{ type: 'final', answer: 'Done. The event is prepared.', suggestions: ['Add another event', 'Plan my week'], done: true, proposals: [ev({ start_local: '2027-06-01T09:00' })] }]);
  const a = await u.c.post('/api/ai/assistant/chat', { message: 'Add the dentist on 1 June at 9' });
  assert.deepEqual(a.json.message.suggestions, [], 'a finished task offers nothing more, and no derived chips either');
  const conv = a.json.conversationId;
  assert.equal((await u.c.post(`/api/ai/assistant/proposals/${a.json.message.proposals[0].id}/reject`)).status, 200);

  reset([{ type: 'final', answer: 'Sure.', suggestions: ['Add another event'], proposals: [] }]);
  await u.c.post('/api/ai/assistant/chat', { conversationId: conv, message: 'What else could I add?' });
  assert.match(requests[0][1].content, /"decisions"/); assert.match(requests[0][1].content, /"status":"rejected"/, 'the model sees what was declined');
  assert.match(requests[0][0].content, /Know when you are finished/);

  reset([{ type: 'final', answer: 'Sure.', suggestions: ['Add another event', 'Review the budget plan'], proposals: [] }]);
  const again = await u.c.post('/api/ai/assistant/chat', { conversationId: conv, message: 'Anything else?' });
  assert.deepEqual(again.json.message.suggestions, ['Review the budget plan'], 'an option already shown is not offered again');

  reset();
  const thanks = await u.c.post('/api/ai/assistant/chat', { conversationId: conv, message: 'thanks!' });
  assert.equal(requests.length, 0, 'no model call to say goodbye');
  assert.deepEqual(thanks.json.message.suggestions, []); assert.match(thanks.json.message.content, /Glad that helped/);
});

test('inside a guided skill a plain "done" or "yes" is an answer, not the end', async () => {
  const u = await signUp(srv.base, 'FinishSkill');
  reset();
  await u.c.post('/api/ai/assistant/chat', { message: '/add-task' });
  const conv = (await u.c.get('/api/ai/assistant/conversations')).json[0].id;
  reset([{ type: 'final', answer: 'Which project?', suggestions: ['Yes', 'No'], proposals: [] }, { type: 'final', answer: 'Which project?', suggestions: ['Yes', 'No'], proposals: [] }]);
  const r1 = await u.c.post('/api/ai/assistant/chat', { conversationId: conv, message: 'Done' });
  assert.equal(requests.length, 1, 'the model answered: it was not treated as goodbye');
  assert.deepEqual(r1.json.message.suggestions, ['Yes', 'No']);
  const r2 = await u.c.post('/api/ai/assistant/chat', { conversationId: conv, message: 'Yes' });
  assert.deepEqual(r2.json.message.suggestions, ['Yes', 'No'], 'short generic options may repeat');
});
