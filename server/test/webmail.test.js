// In-app webmail: the per-user mailbox session, folder/message relay (against a fake IMAP client) and the
// OpenPGP key directory. Email hosting must be enabled for the workspace; the IMAP connection is stubbed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, signUp } from './helpers.js';

let srv, db, relay;
const dir = mkdtempSync(join(tmpdir(), 'amb-webmail-'));

const RAW = [
  'From: Alice <alice@example.com>',
  'To: me@mail.io',
  'Subject: Hello',
  'Date: Wed, 1 Jan 2025 00:00:00 +0000',
  'Message-ID: <1@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello body',
].join('\r\n');

function fakeClient() {
  return {
    list: async () => [{ name: 'INBOX', specialUse: '\\Inbox', flags: new Set(['\\HasNoChildren']) }],
    status: async () => ({ messages: 1, unseen: 0 }),
    mailboxOpen: async () => ({ exists: 1, unseen: 0 }),
    fetch: async function* () {
      yield { uid: 1, envelope: { from: [{ name: 'Alice', address: 'alice@example.com' }], to: [{ address: 'me@mail.io' }], subject: 'Hello' }, flags: new Set(['\\Seen']), internalDate: new Date('2025-01-01T00:00:00Z'), size: RAW.length };
    },
    fetchOne: async (uid) => ({ uid, source: Buffer.from(RAW), envelope: { subject: 'Hello' }, flags: new Set(['\\Seen']), internalDate: new Date('2025-01-01T00:00:00Z') }),
    messageFlagsAdd: async () => {},
    messageFlagsRemove: async () => {},
    messageMove: async () => {},
    messageDelete: async () => {},
    mailboxClose: async () => {},
  };
}

before(async () => {
  srv = await startServer();
  Object.assign(process.env, { MAIL_ENABLED: 'true', MAIL_DIR: dir, MAIL_HOST: 'mail.hosting.net' });
  ({ db } = await import('../src/db.js'));
  relay = await import('../src/mail/relay.js');
  relay.__setImapClientForTests(async () => fakeClient());
});
after(() => { srv.close(); delete process.env.MAIL_ENABLED; });

let n = 0;
function addMailbox(wsId) {
  n += 1;
  const domain = `wm${n}.io`;
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO mail_domains (id, workspace_id, domain, verify_token, dkim_selector, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`d${n}`, wsId, domain, 'tok', 'mail', ts);
  const dom = db.prepare('SELECT id FROM mail_domains WHERE domain = ?').get(domain);
  db.prepare('INSERT INTO mail_accounts (id, workspace_id, domain_id, local_part, password_hash, quota_mb, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(`a${n}`, wsId, dom.id, 'me', `$6$abcdefghijklmnop$${'x'.repeat(86)}`, 1024, ts);
  return `me@${domain}`;
}

test('webmail is gated when email hosting is off for the workspace', async () => {
  process.env.MAIL_ENABLED = 'false';
  const u = await signUp(srv.base, 'WmOff');
  assert.equal((await u.c.get('/api/webmail/session')).status, 503);
  process.env.MAIL_ENABLED = 'true';
});

test('connect, list folders and read a message, then disconnect', async () => {
  const u = await signUp(srv.base, 'WmRead');
  const address = addMailbox(u.personalId);

  const s0 = (await u.c.get('/api/webmail/session')).json;
  assert.equal(s0.session, null);
  assert.equal(s0.host, 'mail.hosting.net');
  assert.equal(s0.imap.port, 993);
  assert.equal(s0.smtp.port, 587);

  assert.equal((await u.c.post('/api/webmail/session', {})).status, 400, 'address and password are required');
  assert.equal((await u.c.post('/api/webmail/session', { address: 'nobody@nowhere.io', password: 'secret12345678' })).status, 400, 'the mailbox must belong to the workspace');

  const ok = await u.c.post('/api/webmail/session', { address, password: 'secret12345678' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.address, address);
  assert.equal((await u.c.get('/api/webmail/session')).json.session.address, address);

  const folders = (await u.c.get('/api/webmail/folders')).json;
  assert.equal(folders[0].name, 'INBOX');

  const list = (await u.c.get('/api/webmail/messages?folder=INBOX')).json;
  assert.equal(list.total, 1);
  assert.equal(list.messages[0].subject, 'Hello');
  assert.equal(list.messages[0].fromText, 'Alice');
  assert.equal(list.messages[0].seen, true);

  const msg = (await u.c.get('/api/webmail/messages/INBOX/1')).json;
  assert.equal(msg.subject, 'Hello');
  assert.match(msg.text, /Hello body/);
  assert.equal(msg.from[0].address, 'alice@example.com');

  assert.equal((await u.c.patch('/api/webmail/messages/INBOX/1', { flagged: true })).status, 200);
  assert.equal((await u.c.del('/api/webmail/messages/INBOX/1')).status, 200);

  assert.equal((await u.c.del('/api/webmail/session')).status, 204);
  assert.equal((await u.c.get('/api/webmail/session')).json.session, null);
});

test('keys: stored encrypted, published to the directory, and removable', async () => {
  const u = await signUp(srv.base, 'WmKeys');
  const address = addMailbox(u.personalId);
  const pub = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nzzz\n-----END PGP PUBLIC KEY BLOCK-----';
  const priv = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nyyy\n-----END PGP PRIVATE KEY BLOCK-----';

  assert.deepEqual((await u.c.get('/api/webmail/keys')).json, { has_key: false, addresses: [] });
  assert.deepEqual((await u.c.get('/api/webmail/keys/directory')).json, []);
  assert.equal((await u.c.put('/api/webmail/keys', { public_armored: pub, private_armored: priv, fingerprint: 'FINGER' })).status, 409, 'a key needs a connected mailbox');

  await u.c.post('/api/webmail/session', { address, password: 'secret12345678' });
  assert.equal((await u.c.put('/api/webmail/keys', { public_armored: 'not a key', private_armored: priv })).status, 400, 'the public key is validated');
  assert.equal((await u.c.put('/api/webmail/keys', { public_armored: pub, private_armored: priv, fingerprint: 'FINGER' })).status, 200);

  const k = (await u.c.get('/api/webmail/keys')).json;
  assert.equal(k.has_key, true);
  assert.equal(k.fingerprint, 'FINGER');
  assert.ok(k.public_armored.includes('PUBLIC KEY') && k.private_armored.includes('PRIVATE KEY'));
  assert.deepEqual(k.addresses, [address]);

  const dir = (await u.c.get(`/api/webmail/keys/directory?address=${encodeURIComponent(address)}`)).json;
  assert.ok(dir[address].public_armored.includes('PUBLIC KEY'));

  assert.equal((await u.c.del('/api/webmail/keys')).status, 204);
  assert.equal((await u.c.get('/api/webmail/keys')).json.has_key, false);
  assert.deepEqual((await u.c.get('/api/webmail/keys/directory')).json, []);
});
