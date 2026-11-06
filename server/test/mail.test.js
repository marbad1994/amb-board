// Email hosting: domains proven by DNS, mailboxes and aliases, and the files the root helper reads. DNS is a fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, signUp } from './helpers.js';

let srv, dns, db; const dir = mkdtempSync(join(tmpdir(), 'amb-mail-')); const txt = {}; let mx = {};
const read = (f) => readFileSync(join(dir, 'in', f), 'utf8');
before(async () => {
  srv = await startServer();
  Object.assign(process.env, { MAIL_ENABLED: 'true', MAIL_DIR: dir, MAIL_HOST: 'mail.hosting.net', MAIL_SERVER_IP: '203.0.113.9' });
  dns = await import('../src/mail/dns.js'); ({ db } = await import('../src/db.js'));
  dns.resolver.txt = async (n) => (txt[n] || []).map((t) => [t]);
  dns.resolver.mx = async (n) => (mx[n] || []).map((e, i) => ({ exchange: e, priority: (i + 1) * 10 }));
});
after(() => { srv.close(); delete process.env.MAIL_ENABLED; });

const token = (domain) => db.prepare('SELECT verify_token t FROM mail_domains WHERE domain = ?').get(domain).t;
async function verified(u, domain) {
  const d = (await u.c.post('/api/mail/domains', { domain })).json;
  txt[`_amb-mail.${domain}`] = [`amb-mail-verification=${token(domain)}`];
  assert.equal((await u.c.post(`/api/mail/domains/${d.id}/verify`)).status, 200);
  return d;
}

test('off by default, owners and admins only, and a domain must be well formed and unique', async () => {
  const u = await signUp(srv.base, 'MailOff');
  process.env.MAIL_ENABLED = 'false';
  const off = (await u.c.get('/api/mail')).json; assert.equal(off.enabled, false); assert.equal(off.available, false);
  assert.equal((await u.c.post('/api/mail/domains', { domain: 'example.org' })).status, 503);
  process.env.MAIL_ENABLED = 'true';
  assert.equal((await u.c.get('/api/mail')).json.client.imap.port, 993);
  for (const bad of ['', 'nodot', 'http://a.com', 'a b.com', 'x@y.com', 'foo.local', '-a.com', 'a..com']) assert.equal((await u.c.post('/api/mail/domains', { domain: bad })).status, 400, bad);
  const d = await u.c.post('/api/mail/domains', { domain: '  Mine-Shop.COM. ' });
  assert.equal(d.status, 201); assert.equal(d.json.domain, 'mine-shop.com'); assert.equal(d.json.verified, false);
  assert.equal(d.json.verify.name, '_amb-mail.mine-shop.com'); assert.match(d.json.verify.value, /^amb-mail-verification=[0-9a-f]{32}$/);
  const other = await signUp(srv.base, 'MailOther');
  const dup = await other.c.post('/api/mail/domains', { domain: 'mine-shop.com' });
  assert.equal(dup.status, 409); assert.ok(!/MailOff/.test(dup.text), 'does not say who has it');
  assert.equal((await other.c.get(`/api/mail/domains/${d.json.id}/accounts`)).status, 404);
  for (const n of ['a1', 'a2']) assert.equal((await u.c.post('/api/mail/domains', { domain: `${n}-shop.org` })).status, 201);
  assert.equal((await u.c.post('/api/mail/domains', { domain: 'a3-shop.org' })).status, 409, 'at most three domains');
  // a plain member of a shared workspace cannot manage mail
  const owner = await signUp(srv.base, 'MailTeam'); const ws = (await owner.c.post('/api/workspaces', { name: 'Team' })).json;
  const m = await signUp(srv.base, 'MailMember');
  const inv = await owner.c.post(`/api/workspaces/${ws.id}/invitations`, { email: m.email, role: 'member' });
  await m.c.post('/api/invitations/accept', { token: inv.json.token }); m.c.useWorkspace(ws.id);
  assert.equal((await m.c.get('/api/mail')).status, 403); assert.equal((await m.c.post('/api/mail/domains', { domain: 'sneaky.com' })).status, 403);
});

test('a domain carries no mail until its owner proves it with a DNS record; then keys and the postmaster alias appear', async () => {
  const u = await signUp(srv.base, 'MailVerify');
  const d = (await u.c.post('/api/mail/domains', { domain: 'proof.net' })).json;
  assert.equal((await u.c.post(`/api/mail/domains/${d.id}/accounts`, { local_part: 'me' })).status, 409, 'not verified yet');
  assert.equal((await u.c.get(`/api/mail/domains/${d.id}/dns`)).status, 409);
  const no = await u.c.post(`/api/mail/domains/${d.id}/verify`);
  assert.equal(no.status, 422); assert.equal(no.json.expected.name, '_amb-mail.proof.net'); assert.match(no.json.error, /not found yet/);
  txt['_amb-mail.proof.net'] = ['amb-mail-verification=wrong'];
  assert.equal((await u.c.post(`/api/mail/domains/${d.id}/verify`)).status, 422, 'a wrong token is not proof');
  assert.ok(!existsSync(join(dir, 'in', 'domains.txt')) || !read('domains.txt').includes('proof.net'), 'nothing is configured for an unverified domain');
  txt['_amb-mail.proof.net'] = [`amb-mail-verification=${token('proof.net')}`];
  const ok = await u.c.post(`/api/mail/domains/${d.id}/verify`); assert.equal(ok.status, 200); assert.equal(ok.json.verified, true);
  assert.match(read('domains.txt'), /^proof\.net\tmail$/m);
  assert.ok(readFileSync(join(dir, 'in', 'dkim', 'proof.net.pem'), 'utf8').startsWith('-----BEGIN PRIVATE KEY-----'));
  assert.match(read('aliases.txt'), new RegExp(`^postmaster@proof\\.net\\t${u.email.toLowerCase()}$`, 'm'));
  assert.ok(existsSync(join(dir, 'in', 'sync-request')));

  mx['proof.net'] = ['smtppro.zoho.eu']; txt['proof.net'] = ['v=spf1 include:zoho.eu ~all'];
  const dns1 = (await u.c.get(`/api/mail/domains/${d.id}/dns`)).json.records; const by = Object.fromEntries(dns1.map((r) => [r.key, r]));
  assert.equal(by.mx.status, 'mismatch'); assert.match(by.mx.note, /moves ALL mail/); assert.equal(by.mx.value, '10 mail.hosting.net.');
  assert.equal(by.spf.status, 'mismatch'); assert.equal(by.spf.value, 'v=spf1 mx ip4:203.0.113.9 ~all'); assert.equal(by.dkim.status, 'missing'); assert.equal(by.dmarc.status, 'missing');
  const pub = db.prepare('SELECT dkim_public p FROM mail_domains WHERE domain = ?').get('proof.net').p;
  assert.equal(by.dkim.value, `v=DKIM1; k=rsa; p=${pub}`);
  mx['proof.net'] = ['mail.hosting.net']; txt['proof.net'] = ['v=spf1 mx ip4:203.0.113.9 ~all']; txt['mail._domainkey.proof.net'] = [`v=DKIM1; k=rsa; p=${pub}`]; txt['_dmarc.proof.net'] = ['v=DMARC1; p=none'];
  const dns2 = (await u.c.get(`/api/mail/domains/${d.id}/dns`)).json.records; assert.deepEqual(dns2.map((r) => r.status), ['ok', 'ok', 'ok', 'ok']);
  assert.equal((await u.c.del(`/api/mail/domains/${d.id}`)).status, 204);
  assert.ok(!read('domains.txt').includes('proof.net') && !existsSync(join(dir, 'in', 'dkim', 'proof.net.pem')), 'removing a domain removes its configuration and key');
});

test('mailboxes: generated or chosen password (hash only), duplicates, disabling, password reset, deletion', async () => {
  const u = await signUp(srv.base, 'MailBox'); const d = await verified(u, 'boxes.io');
  const url = `/api/mail/domains/${d.id}/accounts`;
  assert.equal((await u.c.post(url, { local_part: 'Bad Name' })).status, 400);
  const c = await u.c.post(url, { local_part: 'Anna', quota_mb: 2048 });
  assert.equal(c.status, 201); assert.equal(c.json.address, 'anna@boxes.io'); assert.ok(c.json.password.length >= 16, 'a generated password is shown once');
  assert.ok(!(await u.c.get(url)).text.includes(c.json.password) && !('password' in (await u.c.get(url)).json[0]), 'never again');
  const line = read('passwd.txt').trim().split('\n').find((l) => l.startsWith('anna@boxes.io\t')); const hash = line.split('\t')[1];
  assert.match(hash, /^\$6\$/); assert.ok(!read('passwd.txt').includes(c.json.password));
  assert.equal(execFileSync('openssl', ['passwd', '-6', '-salt', hash.split('$')[2], '-stdin'], { input: `${c.json.password}\n` }).toString().trim(), hash, 'a standard SHA512-CRYPT hash of that password');
  assert.match(read('mailboxes.txt'), /^anna@boxes\.io\t2048$/m);
  assert.equal(read('encrypt.txt').trim(), '', 'no mailbox is encrypted until asked');
  assert.equal((await u.c.patch(`/api/mail/accounts/${c.json.id}`, { encrypt_at_rest: true })).json.encrypt_at_rest, true);
  assert.match(read('encrypt.txt'), /^anna@boxes\.io$/m, 'encrypted mailboxes are listed for the helper');
  assert.equal((await u.c.patch(`/api/mail/accounts/${c.json.id}`, { encrypt_at_rest: false })).json.encrypt_at_rest, false);
  assert.ok(!read('encrypt.txt').includes('anna@'), 'turning encryption off removes it from the list');
  assert.equal((await u.c.post(url, { local_part: 'anna' })).status, 409);
  assert.equal((await u.c.post(url, { local_part: 'bob', password: 'short' })).status, 400);
  assert.equal((await u.c.post(url, { local_part: 'bob', password: 'a long enough password' })).json.password, undefined, 'a chosen password is not echoed');
  assert.equal((await u.c.post(`/api/mail/domains/${d.id}/aliases`, { local_part: 'anna', destinations: ['x@outside.org'] })).status, 409, 'alias and mailbox cannot share a name');

  const dis = await u.c.patch(`/api/mail/accounts/${c.json.id}`, { enabled: false }); assert.equal(dis.json.enabled, false);
  assert.ok(!read('passwd.txt').includes('anna@boxes.io') && read('mailboxes.txt').includes('anna@boxes.io'), 'a disabled mailbox cannot log in but still receives mail');
  await u.c.patch(`/api/mail/accounts/${c.json.id}`, { enabled: true });
  const reset = await u.c.post(`/api/mail/accounts/${c.json.id}/password`); assert.ok(reset.json.password);
  assert.notEqual(read('passwd.txt').split('\n').find((l) => l.startsWith('anna@')).split('\t')[1], hash);
  assert.equal((await u.c.del(`/api/mail/accounts/${c.json.id}`)).status, 204); assert.ok(!read('mailboxes.txt').includes('anna@'));
  const other = await signUp(srv.base, 'MailBoxOther');
  assert.equal((await other.c.patch(`/api/mail/accounts/${c.json.id}`, { enabled: false })).status, 404);
  const log = db.prepare("SELECT action, meta FROM audit_log WHERE action LIKE 'mail.%' ORDER BY created_at").all();
  assert.ok(log.some((l) => l.action === 'mail.account_create') && log.some((l) => l.action === 'mail.account_password'));
  assert.ok(!JSON.stringify(log).includes(c.json.password) && !JSON.stringify(log).includes(reset.json.password), 'passwords are never logged');
});

test('aliases: forward to one to five addresses, catch-all, validation, disabling', async () => {
  const u = await signUp(srv.base, 'MailAlias'); const d = await verified(u, 'aliases.co');
  const url = `/api/mail/domains/${d.id}/aliases`;
  const a = await u.c.post(url, { local_part: 'Info', destinations: 'me@gmail.test.org, team@aliases.co' }); assert.equal(a.status, 201, a.text);
  assert.deepEqual(a.json.destinations, ['me@gmail.test.org', 'team@aliases.co']);
  assert.match(read('aliases.txt'), /^info@aliases\.co\tme@gmail\.test\.org,team@aliases\.co$/m);
  const star = await u.c.post(url, { local_part: '*', destinations: ['catch@aliases.co'] }); assert.equal(star.json.catch_all, true); assert.match(read('aliases.txt'), /^\*@aliases\.co\tcatch@aliases\.co$/m);
  assert.equal((await u.c.post(url, { local_part: 'info', destinations: ['a@b.org'] })).status, 409);
  assert.equal((await u.c.post(url, { local_part: 'x', destinations: [] })).status, 400);
  assert.equal((await u.c.post(url, { local_part: 'x', destinations: ['not an address'] })).status, 400);
  assert.equal((await u.c.post(url, { local_part: 'x', destinations: ['x@aliases.co'] })).status, 400, 'no forwarding to itself');
  assert.equal((await u.c.post(url, { local_part: 'y', destinations: ['1@a.org', '2@a.org', '3@a.org', '4@a.org', '5@a.org', '6@a.org'] })).status, 400);
  assert.equal((await u.c.post(url, { local_part: 'new line\nevil', destinations: ['a@b.org'] })).status, 400, 'nothing that could break a map file');
  assert.equal((await u.c.patch(`/api/mail/aliases/${a.json.id}`, { enabled: false })).json.enabled, false); assert.ok(!read('aliases.txt').includes('info@'));
  assert.equal((await u.c.patch(`/api/mail/aliases/${a.json.id}`, { enabled: true, destinations: ['only@x.org'] })).json.destinations[0], 'only@x.org');
  assert.equal((await u.c.del(`/api/mail/aliases/${a.json.id}`)).status, 204); assert.ok(!read('aliases.txt').includes('info@'));
  assert.deepEqual(readdirSync(join(dir, 'in')).filter((f) => f.endsWith('.tmp')), [], 'files are written atomically');
});

test('deleted mailboxes are queued for removal from disk, a re-created one keeps its mail; limits, webmail and usage are exposed', async () => {
  process.env.MAIL_WEBMAIL_URL = 'https://mail.hosting.net/'; process.env.MAIL_SEND_PER_USER_HOUR = '20'; process.env.MAIL_TRASH_DAYS = '7';
  db.prepare('DELETE FROM mail_purges').run();   // the earlier tests deleted mailboxes too
  const u = await signUp(srv.base, 'MailPurge'); const d = await verified(u, 'purge.io'); const url = `/api/mail/domains/${d.id}/accounts`;
  const a = (await u.c.post(url, { local_part: 'old' })).json; const b = (await u.c.post(url, { local_part: 'keep' })).json;
  assert.match(read('limits.txt'), /^purge\.io\t20\t300\t1000$/m); assert.match(read('limits.txt'), /^\*\t20\t300\t1000$/m); assert.equal(read('settings.txt').trim(), 'trash_days\t7');
  assert.equal(read('purge.txt').trim(), '', 'nothing to remove yet');
  assert.equal((await u.c.del(`/api/mail/accounts/${a.id}`)).status, 204);
  assert.match(read('purge.txt'), /^old@purge\.io\t\d{4}-\d\d-\d\dT[\d:.]+Z$/m, 'the helper is asked to remove its stored mail');
  assert.ok(!read('purge.txt').includes('keep@'));
  assert.equal((await u.c.post(url, { local_part: 'old' })).status, 201); assert.ok(!read('purge.txt').includes('old@purge.io'), 'created again: its mail is kept');
  assert.equal((await u.c.del(`/api/mail/domains/${d.id}`)).status, 204);
  assert.match(read('purge.txt'), /^old@purge\.io\t/m); assert.match(read('purge.txt'), /^keep@purge\.io\t/m); assert.ok(b.id, 'removing a domain queues all of its mailboxes');
  db.prepare("UPDATE mail_purges SET requested_at = '2020-01-01T00:00:00.000Z'").run();
  const u2 = await signUp(srv.base, 'MailPurge2'); await verified(u2, 'purge2.io'); assert.equal(read('purge.txt').trim(), '', 'entries expire after 30 days');

  const info = (await u.c.get('/api/mail')).json;
  assert.equal(info.features.webmail, 'https://mail.hosting.net'); assert.equal(info.features.spam_filter, true); assert.equal(info.features.trash_days, 7);
  assert.deepEqual([info.sending.per_mailbox_hour, info.sending.per_mailbox_day, info.sending.per_domain_day, info.sending.tracked], [20, 300, 1000, false]);
  const d3 = await verified(u, 'usage.io'); const c = (await u.c.post(`/api/mail/domains/${d3.id}/accounts`, { local_part: 'anna' })).json;
  assert.equal((await u.c.get(`/api/mail/domains/${d3.id}/accounts`)).json[0].sent_today, null, 'unknown until the limit service reports');
  const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'out', 'usage.json'), JSON.stringify({ at: new Date().toISOString(), users: { 'anna@usage.io': { hour: 4, day: 17 } }, domains: {} }));
  const list = (await u.c.get(`/api/mail/domains/${d3.id}/accounts`)).json[0]; assert.deepEqual([list.sent_hour, list.sent_today], [4, 17]); assert.ok(c.id);
  assert.equal((await u.c.get('/api/mail')).json.sending.tracked, true);
  delete process.env.MAIL_WEBMAIL_URL; delete process.env.MAIL_SEND_PER_USER_HOUR; delete process.env.MAIL_TRASH_DAYS;
});

test('new mail: a shared secret reports it, the assigned member gets a notification that opens the webmail, nothing is mailed back', async () => {
  const note = (secret, body) => fetch(`${srv.base}/api/mail-notify`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
  delete process.env.MAIL_NOTIFY_SECRET; process.env.MAIL_WEBMAIL_URL = 'https://mail.hosting.net/';
  assert.equal((await note('whatever-secret-value-123', { address: 'a@b.org', messages: [] })).status, 404, 'off until a secret is configured');
  const SECRET = 'a-long-shared-secret-value'; process.env.MAIL_NOTIFY_SECRET = SECRET;

  const owner = await signUp(srv.base, 'MailNote'); const team = (await owner.c.post('/api/workspaces', { name: 'Mail team' })).json; owner.c.useWorkspace(team.id);
  const mate = await signUp(srv.base, 'MailMate'); const outsider = await signUp(srv.base, 'MailOutsider');
  const inv = await owner.c.post(`/api/workspaces/${team.id}/invitations`, { email: mate.email, role: 'member' });
  await mate.c.post('/api/invitations/accept', { token: inv.json.token }); mate.c.useWorkspace(team.id);
  const d = await verified(owner, 'notify.io'); const box = (await owner.c.post(`/api/mail/domains/${d.id}/accounts`, { local_part: 'anna' })).json;
  assert.equal(box.notify_user_id, owner.user.id, 'the creator is told by default');
  const list = async (u) => (await u.c.get('/api/notifications')).json.items.filter((n) => n.kind === 'mail');

  assert.equal((await note(null, { address: 'anna@notify.io', messages: [{ id: 'x1' }] })).status, 401);
  assert.equal((await note('wrong-secret-value-12345', { address: 'anna@notify.io', messages: [{ id: 'x1' }] })).status, 401);
  assert.equal((await (await note(SECRET, { address: 'nobody@notify.io', messages: [{ id: 'x1', from: 'A' }] })).json()).accepted, 0, 'an unknown mailbox is ignored');
  assert.equal((await (await note(SECRET, { address: 'anna@unknown.org', messages: [{ id: 'x1', from: 'A' }] })).json()).accepted, 0);

  const first = await (await note(SECRET, { address: 'Anna@Notify.io', messages: [{ id: '1700000000.M1.mail', from: 'Boss <boss@corp.org>', subject: 'Contract\nready' }] })).json();
  assert.equal(first.accepted, 1);
  const n = (await list(owner))[0]; assert.equal(n.title, 'New mail from Boss <boss@corp.org>'); assert.equal(n.body, 'Contract ready - anna@notify.io'); assert.equal(n.link, 'https://mail.hosting.net', 'a click opens the webmail');
  assert.equal((await (await note(SECRET, { address: 'anna@notify.io', messages: [{ id: '1700000000.M1.mail', from: 'Boss' }] })).json()).accepted, 0, 'the same message is not announced twice');
  assert.equal((await list(mate)).length, 0, 'only the assigned member is told');

  const many = await (await note(SECRET, { address: 'anna@notify.io', messages: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ id: `m-${x}`, from: x, subject: x })) })).json();
  assert.equal(many.accepted, 4, 'three individually, then one line for the rest');
  assert.ok((await list(owner)).some((x) => x.title === '2 more new messages'));
  const odd = await (await note(SECRET, { address: 'anna@notify.io', messages: [{ id: 'bad id with spaces' }, { id: '../etc' }, { subject: 'no id' }] })).json(); assert.equal(odd.accepted, 0, 'ids that cannot be trusted are dropped');

  // assign the mailbox to someone else, only a member of the workspace
  assert.equal((await owner.c.patch(`/api/mail/accounts/${box.id}`, { notify_user_id: outsider.user.id })).status, 400);
  assert.equal((await owner.c.patch(`/api/mail/accounts/${box.id}`, { notify_user_id: mate.user.id })).json.notify_user_id, mate.user.id);
  await note(SECRET, { address: 'anna@notify.io', messages: [{ id: 'for-mate', from: 'Client' }] });
  assert.equal((await list(mate))[0].title, 'New mail from Client');
  // a member can mute these
  assert.equal((await mate.c.put('/api/notifications/preferences', { mail: false })).json.mail, false);
  const muted = await (await note(SECRET, { address: 'anna@notify.io', messages: [{ id: 'quiet', from: 'Spam' }] })).json(); assert.equal(muted.accepted, 0); assert.equal(muted.muted, true);

  // the sidebar entry is the webmail address; it is gone when there is none; the built-in client no longer exists
  assert.equal((await owner.c.get('/api/workspaces')).json.find((w) => w.id === team.id).mail, 'https://mail.hosting.net');
  delete process.env.MAIL_WEBMAIL_URL; assert.equal((await owner.c.get('/api/workspaces')).json.find((w) => w.id === team.id).mail, null);
  assert.equal((await owner.c.get('/api/webmail/session')).status, 404); assert.equal((await owner.c.get('/api/webmail/folders')).status, 404);
  for (const t of ['webmail_sessions', 'mail_keys', 'mail_public_keys']) assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = ?").get(t).n, 0, `${t} was dropped`);
  delete process.env.MAIL_NOTIFY_SECRET;
});
