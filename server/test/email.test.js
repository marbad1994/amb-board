// Email notifications. The SMTP transport is a recording fake: no mail leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp } from './helpers.js';

let srv, db, mailer;
const sent = [];
let failNext = false;
const fakeTransport = { sendMail: async (m) => { if (failNext) throw new Error('smtp down'); sent.push(m); } };

before(async () => {
  srv = await startServer();
  ({ db } = await import('../src/db.js'));
  mailer = await import('../src/notifications/mailer.js');
});
after(() => srv.close());

const wsOf = (u) => db.prepare('SELECT workspace_id AS w FROM workspace_members WHERE user_id = ?').get(u.user.id).w;
let n = 0;
const notify = (u, title, createdAt = new Date().toISOString(), body = '') => db.prepare('INSERT INTO notifications (id, workspace_id, user_id, kind, title, body, link, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(`n${++n}`, wsOf(u), u.user.id, 'automation', title, body, '/tasks', `k${n}`, createdAt);

test('email cannot be switched on while the server has no SMTP settings', async () => {
  const u = await signUp(srv.base, 'NoSmtp');
  mailer.setTransportForTests(null);
  delete process.env.SMTP_PASS;
  const r = await u.c.put('/api/notifications/preferences', { email: true });
  assert.equal(r.status, 409);
  assert.equal((await u.c.get('/api/notifications/preferences')).json.email_available, false);
  assert.equal((await u.c.post('/api/notifications/email-test')).status, 409);
});

test('email on: only notifications created afterwards are mailed, once, as one escaped digest; others are untouched', async () => {
  const u = await signUp(srv.base, 'Mailer');
  const other = await signUp(srv.base, 'Quiet');
  mailer.setTransportForTests(fakeTransport); sent.length = 0;
  notify(u, 'Old one', new Date(Date.now() - 3600_000).toISOString());
  const on = await u.c.put('/api/notifications/preferences', { email: true });
  assert.equal(on.status, 200); assert.equal(on.json.email, true); assert.equal(on.json.email_available, true);
  const t = new Date(Date.now() + 1000).toISOString();
  notify(u, 'Task due: <b>Pay rent</b>', t, 'Home & garden'); notify(u, 'Second', t); notify(other, 'Not for you', t);
  assert.equal(await mailer.sendPendingEmails(new Date(Date.now() + 5000)), 1);
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, u.email); assert.match(m.from, /admin@makketing\.com/); assert.match(m.subject, /2 new notifications/);
  assert.ok(m.html.includes('&lt;b&gt;Pay rent&lt;/b&gt;') && !m.html.includes('<b>Pay rent</b>'), 'html is escaped');
  assert.ok(!m.text.includes('Old one'), 'notifications from before email was enabled are not sent');
  assert.equal(await mailer.sendPendingEmails(new Date(Date.now() + 6000)), 0, 'nothing is sent twice');
  assert.equal(db.prepare("SELECT emailed_at FROM notifications WHERE title = 'Not for you'").get().emailed_at, null);
  // turning it off stops mail
  await u.c.put('/api/notifications/preferences', { email: false });
  notify(u, 'After off', new Date(Date.now() + 8000).toISOString());
  assert.equal(await mailer.sendPendingEmails(new Date(Date.now() + 9000)), 0);
});

test('a failing mail server leaves notifications unsent, pauses, then retries without duplicates', async () => {
  const u = await signUp(srv.base, 'Retry');
  mailer.setTransportForTests(fakeTransport); sent.length = 0; mailer.resetBackoffForTests();
  await u.c.put('/api/notifications/preferences', { email: true });
  notify(u, 'Flaky', new Date(Date.now() + 1000).toISOString());
  failNext = true;
  const t0 = Date.now() + 3000;
  assert.equal(await mailer.sendPendingEmails(new Date(t0)), 0);
  assert.equal(db.prepare("SELECT emailed_at FROM notifications WHERE title = 'Flaky'").get().emailed_at, null);
  failNext = false;
  assert.equal(await mailer.sendPendingEmails(new Date(t0 + 60_000)), 0, 'paused for ten minutes after a failure');
  assert.equal(await mailer.sendPendingEmails(new Date(t0 + 11 * 60_000)), 1);
  assert.equal(sent.filter((s) => s.to === u.email).length, 1);
});

test('test email goes to the signed-in user only and is rate limited', async () => {
  const u = await signUp(srv.base, 'TestMail');
  mailer.setTransportForTests(fakeTransport); sent.length = 0;
  const a = await u.c.post('/api/notifications/email-test');
  assert.equal(a.status, 200); assert.equal(a.json.sent_to, u.email); assert.equal(sent[0].to, u.email);
  assert.equal((await u.c.post('/api/notifications/email-test')).status, 429);
});
