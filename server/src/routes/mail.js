import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { audit, requirePermission } from '../access.js';
import { encryptSecret } from '../secrets.js';
import { mailConfig, mailAvailable } from '../mail/config.js';
import { normalizeDomain, validDomain, normalizeLocal, validLocal, validEmail } from '../mail/validate.js';
import { hashPassword, checkPassword, generatePassword } from '../mail/password.js';
import { generateDkim } from '../mail/dkim.js';
import { checkOwnership, checkRecords, verifyName, verifyValue } from '../mail/dns.js';
import { syncMail, syncStatus } from '../mail/sync.js';

// Email hosting: domains a workspace attaches, the mailboxes and aliases on them. Owners and admins only.
// A domain carries no mail until its owner proves control of it with a DNS record.
const router = Router();
router.use(requirePermission('members:manage'));

const off = (req, res, next) => (mailAvailable(req.ws.id) ? next() : res.status(503).json({ error: 'Email hosting is not set up for this workspace on this server.' }));
const domainOf = (req) => db.prepare('SELECT * FROM mail_domains WHERE id = ? AND workspace_id = ?').get(String(req.params.id), req.ws.id);
const accountOf = (req) => db.prepare('SELECT a.*, d.domain FROM mail_accounts a JOIN mail_domains d ON d.id = a.domain_id WHERE a.id = ? AND a.workspace_id = ?').get(String(req.params.id), req.ws.id);
const aliasOf = (req) => db.prepare('SELECT a.*, d.domain FROM mail_aliases a JOIN mail_domains d ON d.id = a.domain_id WHERE a.id = ? AND a.workspace_id = ?').get(String(req.params.id), req.ws.id);
const count = (table, ws) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(ws).n;
const pDomain = (d) => ({ id: d.id, domain: d.domain, verified: !!d.verified_at, verified_at: d.verified_at, created_at: d.created_at,
  verify: d.verified_at ? null : { type: 'TXT', name: verifyName(d.domain), value: verifyValue(d.verify_token) },
  accounts: db.prepare('SELECT COUNT(*) AS n FROM mail_accounts WHERE domain_id = ?').get(d.id).n, aliases: db.prepare('SELECT COUNT(*) AS n FROM mail_aliases WHERE domain_id = ?').get(d.id).n });
const pAccount = (a) => ({ id: a.id, local_part: a.local_part, address: `${a.local_part}@${a.domain}`, quota_mb: a.quota_mb, enabled: !!a.enabled, created_at: a.created_at });
const pAlias = (a) => ({ id: a.id, local_part: a.local_part, address: `${a.local_part}@${a.domain}`, destinations: JSON.parse(a.destinations), enabled: !!a.enabled, catch_all: a.local_part === '*', created_at: a.created_at });
const apply = () => { try { syncMail(); } catch (e) { console.error('mail sync failed:', e.message); } };

router.get('/', (req, res) => {
  const c = mailConfig(); const available = mailAvailable(req.ws.id);
  res.json({ enabled: c.enabled, available, host: c.host, ip: c.ip, limits: { domains: c.maxDomains, accounts: c.maxAccounts, aliases: c.maxAliases },
    usage: { domains: count('mail_domains', req.ws.id), accounts: count('mail_accounts', req.ws.id), aliases: count('mail_aliases', req.ws.id) },
    client: { imap: { host: c.host, port: 993, security: 'SSL/TLS' }, smtp: { host: c.host, port: 587, security: 'STARTTLS' } },
    sync: available ? syncStatus() : null,
    domains: db.prepare('SELECT * FROM mail_domains WHERE workspace_id = ? ORDER BY domain').all(req.ws.id).map(pDomain) });
});

// ---- domains ----
router.post('/domains', off, (req, res) => {
  const domain = normalizeDomain(req.body.domain);
  if (!validDomain(domain)) return res.status(400).json({ error: 'Enter a domain name such as example.com (without www or an @).' });
  if (count('mail_domains', req.ws.id) >= mailConfig().maxDomains) return res.status(409).json({ error: `At most ${mailConfig().maxDomains} domains per workspace.` });
  if (db.prepare('SELECT 1 FROM mail_domains WHERE domain = ?').get(domain)) return res.status(409).json({ error: 'That domain is already attached to a workspace on this server.' });
  const id = nanoid();
  db.prepare('INSERT INTO mail_domains (id, workspace_id, domain, verify_token, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.ws.id, domain, randomBytes(16).toString('hex'), req.user.id, nowIso());
  audit(req, 'mail.domain_add', 'mail_domain', id, { domain });
  res.status(201).json(pDomain(db.prepare('SELECT * FROM mail_domains WHERE id = ?').get(id)));
});

router.post('/domains/:id/verify', off, async (req, res) => {
  const d = domainOf(req); if (!d) return res.status(404).json({ error: 'not found' });
  if (d.verified_at) return res.json(pDomain(d));
  const r = await checkOwnership(d.domain, d.verify_token);
  if (!r.ok) return res.status(422).json({ error: `The record was not found yet. Add the TXT record below at your DNS provider, wait a few minutes (DNS can take longer) and check again.`, expected: { type: 'TXT', name: verifyName(d.domain), value: verifyValue(d.verify_token) }, found: r.found });
  const k = generateDkim();
  db.prepare('UPDATE mail_domains SET verified_at = ?, dkim_private_enc = ?, dkim_public = ? WHERE id = ?').run(nowIso(), encryptSecret(k.privatePem), k.publicB64, d.id);
  // every domain needs a postmaster address; it forwards to the person who attached the domain until they change it
  db.prepare('INSERT OR IGNORE INTO mail_aliases (id, workspace_id, domain_id, local_part, destinations, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(nanoid(), req.ws.id, d.id, 'postmaster', JSON.stringify([req.user.email.toLowerCase()]), nowIso());
  audit(req, 'mail.domain_verify', 'mail_domain', d.id, { domain: d.domain });
  apply();
  res.json(pDomain(db.prepare('SELECT * FROM mail_domains WHERE id = ?').get(d.id)));
});

router.get('/domains/:id/dns', off, async (req, res) => {
  const d = domainOf(req); if (!d) return res.status(404).json({ error: 'not found' });
  if (!d.verified_at) return res.status(409).json({ error: 'Verify the domain first.' });
  res.json({ domain: d.domain, records: await checkRecords(d), note: 'Also ask your server provider to set the reverse DNS (PTR) of the mail server address to the mail host name.' });
});

router.delete('/domains/:id', off, (req, res) => {
  const d = domainOf(req); if (!d) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM mail_domains WHERE id = ?').run(d.id);
  audit(req, 'mail.domain_remove', 'mail_domain', d.id, { domain: d.domain });
  apply();
  res.status(204).end();
});

// ---- mailboxes ----
const needVerified = (req, res) => { const d = domainOf(req); if (!d) { res.status(404).json({ error: 'not found' }); return null; } if (!d.verified_at) { res.status(409).json({ error: 'Verify the domain first.' }); return null; } return d; };
router.get('/domains/:id/accounts', off, (req, res) => {
  const d = domainOf(req); if (!d) return res.status(404).json({ error: 'not found' });
  res.json(db.prepare('SELECT * FROM mail_accounts WHERE domain_id = ? ORDER BY local_part').all(d.id).map((a) => pAccount({ ...a, domain: d.domain })));
});
router.post('/domains/:id/accounts', off, async (req, res) => {
  const d = needVerified(req, res); if (!d) return;
  const local = normalizeLocal(req.body.local_part);
  if (!validLocal(local)) return res.status(400).json({ error: 'The name before the @ may use letters, digits and . _ + - (2 to 64 characters, no spaces).' });
  if (count('mail_accounts', req.ws.id) >= mailConfig().maxAccounts) return res.status(409).json({ error: `At most ${mailConfig().maxAccounts} mailboxes per workspace.` });
  if (db.prepare('SELECT 1 FROM mail_accounts WHERE domain_id = ? AND local_part = ?').get(d.id, local)) return res.status(409).json({ error: 'That mailbox already exists.' });
  if (db.prepare('SELECT 1 FROM mail_aliases WHERE domain_id = ? AND local_part = ?').get(d.id, local)) return res.status(409).json({ error: 'An alias with that name exists. Delete the alias first, or choose another name.' });
  const generated = !req.body.password; const password = generated ? generatePassword() : req.body.password;
  const bad = generated ? null : checkPassword(password); if (bad) return res.status(400).json({ error: bad });
  const quota = Math.max(50, Math.min(51200, Math.round(Number(req.body.quota_mb) || 1024)));
  const id = nanoid();
  db.prepare('INSERT INTO mail_accounts (id, workspace_id, domain_id, local_part, password_hash, quota_mb, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, req.ws.id, d.id, local, await hashPassword(password), quota, req.user.id, nowIso());
  audit(req, 'mail.account_create', 'mail_account', id, { address: `${local}@${d.domain}` });
  apply();
  res.status(201).json({ ...pAccount({ ...db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(id), domain: d.domain }), ...(generated ? { password } : {}) });
});
router.patch('/accounts/:id', off, (req, res) => {
  const a = accountOf(req); if (!a) return res.status(404).json({ error: 'not found' });
  const enabled = req.body.enabled === undefined ? a.enabled : (req.body.enabled ? 1 : 0);
  const quota = req.body.quota_mb === undefined ? a.quota_mb : Math.max(50, Math.min(51200, Math.round(Number(req.body.quota_mb) || a.quota_mb)));
  db.prepare('UPDATE mail_accounts SET enabled = ?, quota_mb = ? WHERE id = ?').run(enabled, quota, a.id);
  audit(req, 'mail.account_update', 'mail_account', a.id, { address: `${a.local_part}@${a.domain}`, enabled: !!enabled, quota_mb: quota });
  apply();
  res.json(pAccount({ ...db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(a.id), domain: a.domain }));
});
router.post('/accounts/:id/password', off, async (req, res) => {
  const a = accountOf(req); if (!a) return res.status(404).json({ error: 'not found' });
  const generated = !req.body.password; const password = generated ? generatePassword() : req.body.password;
  const bad = generated ? null : checkPassword(password); if (bad) return res.status(400).json({ error: bad });
  db.prepare('UPDATE mail_accounts SET password_hash = ? WHERE id = ?').run(await hashPassword(password), a.id);
  audit(req, 'mail.account_password', 'mail_account', a.id, { address: `${a.local_part}@${a.domain}` });
  apply();
  res.json(generated ? { password } : { ok: true });
});
router.delete('/accounts/:id', off, (req, res) => {
  const a = accountOf(req); if (!a) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(a.id);
  audit(req, 'mail.account_delete', 'mail_account', a.id, { address: `${a.local_part}@${a.domain}` });
  apply();
  res.status(204).end();   // the stored mail stays on the server's disk until an administrator removes it
});

// ---- aliases: an address that forwards to one to five others (local mailboxes or outside addresses); "*" is a catch-all ----
function readDestinations(body, own) {
  const list = [...new Set((Array.isArray(body) ? body : String(body ?? '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  if (!list.length || list.length > 5) return { error: 'Give 1 to 5 destination addresses.' };
  const bad = list.find((x) => !validEmail(x)); if (bad) return { error: `"${bad.slice(0, 60)}" is not a valid email address.` };
  if (list.includes(own)) return { error: 'An alias cannot forward to itself.' };
  return { list };
}
router.get('/domains/:id/aliases', off, (req, res) => {
  const d = domainOf(req); if (!d) return res.status(404).json({ error: 'not found' });
  res.json(db.prepare('SELECT * FROM mail_aliases WHERE domain_id = ? ORDER BY local_part').all(d.id).map((a) => pAlias({ ...a, domain: d.domain })));
});
router.post('/domains/:id/aliases', off, (req, res) => {
  const d = needVerified(req, res); if (!d) return;
  const local = normalizeLocal(req.body.local_part);
  if (local !== '*' && !validLocal(local)) return res.status(400).json({ error: 'The alias name may use letters, digits and . _ + - (or * to catch all other mail).' });
  if (count('mail_aliases', req.ws.id) >= mailConfig().maxAliases) return res.status(409).json({ error: `At most ${mailConfig().maxAliases} aliases per workspace.` });
  if (db.prepare('SELECT 1 FROM mail_aliases WHERE domain_id = ? AND local_part = ?').get(d.id, local)) return res.status(409).json({ error: 'That alias already exists.' });
  if (local !== '*' && db.prepare('SELECT 1 FROM mail_accounts WHERE domain_id = ? AND local_part = ?').get(d.id, local)) return res.status(409).json({ error: 'A mailbox with that name exists. An alias cannot share its name.' });
  const r = readDestinations(req.body.destinations, `${local}@${d.domain}`); if (r.error) return res.status(400).json({ error: r.error });
  const id = nanoid();
  db.prepare('INSERT INTO mail_aliases (id, workspace_id, domain_id, local_part, destinations, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.ws.id, d.id, local, JSON.stringify(r.list), nowIso());
  audit(req, 'mail.alias_create', 'mail_alias', id, { address: `${local}@${d.domain}`, destinations: r.list });
  apply();
  res.status(201).json(pAlias({ ...db.prepare('SELECT * FROM mail_aliases WHERE id = ?').get(id), domain: d.domain }));
});
router.patch('/aliases/:id', off, (req, res) => {
  const a = aliasOf(req); if (!a) return res.status(404).json({ error: 'not found' });
  let dest = JSON.parse(a.destinations);
  if (req.body.destinations !== undefined) { const r = readDestinations(req.body.destinations, `${a.local_part}@${a.domain}`); if (r.error) return res.status(400).json({ error: r.error }); dest = r.list; }
  const enabled = req.body.enabled === undefined ? a.enabled : (req.body.enabled ? 1 : 0);
  db.prepare('UPDATE mail_aliases SET destinations = ?, enabled = ? WHERE id = ?').run(JSON.stringify(dest), enabled, a.id);
  audit(req, 'mail.alias_update', 'mail_alias', a.id, { address: `${a.local_part}@${a.domain}`, destinations: dest, enabled: !!enabled });
  apply();
  res.json(pAlias({ ...db.prepare('SELECT * FROM mail_aliases WHERE id = ?').get(a.id), domain: a.domain }));
});
router.delete('/aliases/:id', off, (req, res) => {
  const a = aliasOf(req); if (!a) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM mail_aliases WHERE id = ?').run(a.id);
  audit(req, 'mail.alias_delete', 'mail_alias', a.id, { address: `${a.local_part}@${a.domain}` });
  apply();
  res.status(204).end();
});

export default router;
