import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { audit } from '../access.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { mailAvailable } from '../mail/config.js';
import { validEmail } from '../mail/validate.js';
import * as relay from '../mail/relay.js';

// In-app webmail: each member reads and sends from their own mailbox. It is mounted before the
// workspace write gate (email is a personal action, not a workspace-content change) but still
// requires a workspace and the mail server being enabled for it.
const router = Router();

router.use((req, res, next) => (mailAvailable(req.ws.id) ? next() : res.status(503).json({ error: 'Email is not set up for this workspace on this server.' })));

const knownMailbox = (wsId, address) => db.prepare(`
  SELECT a.id, a.enabled, a.local_part || '@' || d.domain AS address
  FROM mail_accounts a JOIN mail_domains d ON d.id = a.domain_id
  WHERE d.workspace_id = ? AND (a.local_part || '@' || d.domain) = ?`)
  .get(wsId, String(address || '').trim().toLowerCase());

const needSession = (req, res) => {
  const s = relay.webmailSession(req.user.id, req.ws.id);
  if (!s) { res.status(409).json({ error: 'Connect a mailbox first.' }); return null; }
  return s;
};

const clean = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

// imapflow/smtp errors: the useful reason is usually in responseText (the mail server's own message),
// not the generic `message` ("Command failed"). Log the whole thing and return the meaningful part.
const describe = (e) => e.responseText || e.message || 'Mail server error';
const handle = (e, res) => { console.error('[webmail]', e.code || '', describe(e)); res.status(502).json({ error: describe(e) }); };

// ---- session (which mailbox this member reads) ----
router.get('/session', (req, res) => {
  const row = relay.sessionRow(req.user.id, req.ws.id);
  res.json({ ...relay.clientSettings(), session: row ? { address: row.address, created_at: row.created_at } : null });
});

router.post('/session', async (req, res) => {
  const address = String(req.body.address || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!address || !password) return res.status(400).json({ error: 'Enter the mailbox address and its password.' });
  if (password.length > 200) return res.status(400).json({ error: 'That password is too long.' });
  const box = knownMailbox(req.ws.id, address);
  if (!box || !box.enabled) return res.status(400).json({ error: 'That mailbox does not exist here, or logins are turned off. An owner or admin creates it under Workspace & account → Email.' });
  try { await relay.withClient({ address: box.address, password }, () => {}); }
  catch (e) { console.error('[webmail] session sign-in failed:', e.code || '', describe(e)); return res.status(401).json({ error: 'Could not sign in to that mailbox. Check the address and password.' }); }
  db.prepare(`INSERT INTO webmail_sessions (user_id, workspace_id, address, password_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, workspace_id) DO UPDATE SET address = excluded.address, password_enc = excluded.password_enc, updated_at = excluded.updated_at`)
    .run(req.user.id, req.ws.id, box.address, encryptSecret(password), nowIso(), nowIso());
  audit(req, 'webmail.connect', 'webmail_session', req.user.id, { address: box.address });
  res.json({ address: box.address });
});

router.delete('/session', (req, res) => {
  db.prepare('DELETE FROM webmail_sessions WHERE user_id = ? AND workspace_id = ?').run(req.user.id, req.ws.id);
  audit(req, 'webmail.disconnect', 'webmail_session', req.user.id, {});
  res.status(204).end();
});

// ---- folders & messages ----
router.get('/folders', async (req, res) => {
  const s = needSession(req, res); if (!s) return;
  try { res.json(await relay.listFolders(s)); } catch (e) { handle(e, res); }
});

router.get('/messages', async (req, res) => {
  const s = needSession(req, res); if (!s) return;
  const folder = String(req.query.folder || 'INBOX');
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
  try { res.json(await relay.listMessages(s, folder, page, limit)); } catch (e) { handle(e, res); }
});

router.get('/messages/:folder/:uid', async (req, res) => {
  const s = needSession(req, res); if (!s) return;
  try {
    const msg = await relay.readMessage(s, req.params.folder, Number(req.params.uid));
    if (!msg) return res.status(404).json({ error: 'not found' });
    res.json(msg);
  } catch (e) { handle(e, res); }
});

router.post('/send', async (req, res) => {
  const s = needSession(req, res); if (!s) return;
  const to = clean(req.body.to); const cc = clean(req.body.cc); const bcc = clean(req.body.bcc);
  if (!to.length) return res.status(400).json({ error: 'Give at least one recipient.' });
  for (const x of [...to, ...cc, ...bcc]) if (!validEmail(x)) return res.status(400).json({ error: `"${x.slice(0, 60)}" is not a valid email address.` });
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  if (attachments.length > 10) return res.status(400).json({ error: 'At most 10 attachments.' });
  let total = 0;
  for (const a of attachments) {
    if (typeof a.contentBase64 !== 'string') return res.status(400).json({ error: 'Bad attachment.' });
    total += a.contentBase64.length * 0.75;
  }
  if (total > 10 * 1024 * 1024) return res.status(400).json({ error: 'Attachments together must stay under 10 MB.' });
  try {
    res.json(await relay.sendMail(s, { to, cc, bcc, subject: req.body.subject, text: req.body.text, replyTo: req.body.replyTo, inReplyTo: req.body.inReplyTo, references: req.body.references, attachments }));
    audit(req, 'webmail.send', 'webmail', '', { to: to.slice(0, 10), count: to.length });
  } catch (e) { handle(e, res); }
});

router.patch('/messages/:folder/:uid', async (req, res) => {
  const s = needSession(req, res); if (!s) return;
  const uid = Number(req.params.uid); const folder = req.params.folder;
  try {
    if (req.body.folder !== undefined && req.body.folder !== folder) res.json(await relay.moveMessage(s, folder, uid, String(req.body.folder)));
    else res.json(await relay.setFlags(s, folder, uid, { seen: req.body.seen, flagged: req.body.flagged }));
  } catch (e) { handle(e, res); }
});

router.delete('/messages/:folder/:uid', async (req, res) => {
  const s = needSession(req, res); if (!s) return;
  try {
    res.json(await relay.deleteMessage(s, req.params.folder, Number(req.params.uid), String(req.query.trash || 'Trash')));
  } catch (e) { handle(e, res); }
});

// ---- OpenPGP keys (end-to-end encryption) ----
router.get('/keys', (req, res) => {
  const k = db.prepare('SELECT * FROM mail_keys WHERE user_id = ?').get(req.user.id);
  const dir = db.prepare('SELECT address FROM mail_public_keys WHERE user_id = ? AND workspace_id = ? ORDER BY address').all(req.user.id, req.ws.id);
  res.json(k
    ? { has_key: true, public_armored: k.public_armored, private_armored: decryptSecret(k.private_enc), fingerprint: k.fingerprint, addresses: dir.map((d) => d.address), created_at: k.created_at }
    : { has_key: false, addresses: dir.map((d) => d.address) });
});

router.put('/keys', (req, res) => {
  const s = needSession(req, res); if (!s) return; // the key is registered for the connected mailbox
  const public_armored = String(req.body.public_armored || '');
  const private_armored = String(req.body.private_armored || '');
  if (!public_armored.includes('BEGIN PGP PUBLIC KEY BLOCK')) return res.status(400).json({ error: 'A PGP public key is required.' });
  if (!private_armored.includes('BEGIN PGP PRIVATE KEY BLOCK')) return res.status(400).json({ error: 'A (passphrase-protected) PGP private key is required.' });
  if (public_armored.length > 200_000 || private_armored.length > 200_000) return res.status(400).json({ error: 'Key is too large.' });
  const fingerprint = String(req.body.fingerprint || '');
  db.prepare(`INSERT INTO mail_keys (user_id, public_armored, private_enc, fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET public_armored = excluded.public_armored, private_enc = excluded.private_enc, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`)
    .run(req.user.id, public_armored, encryptSecret(private_armored), fingerprint, nowIso(), nowIso());
  db.prepare(`INSERT INTO mail_public_keys (workspace_id, address, user_id, public_armored, fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, address) DO UPDATE SET user_id = excluded.user_id, public_armored = excluded.public_armored, fingerprint = excluded.fingerprint`)
    .run(req.ws.id, s.address, req.user.id, public_armored, fingerprint, nowIso());
  audit(req, 'webmail.key_save', 'mail_key', req.user.id, { address: s.address });
  res.json({ ok: true });
});

router.delete('/keys', (req, res) => {
  db.prepare('DELETE FROM mail_keys WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM mail_public_keys WHERE user_id = ?').run(req.user.id);
  res.status(204).end();
});

router.get('/keys/directory', (req, res) => {
  const q = req.query.address;
  const addresses = q ? (Array.isArray(q) ? q : [q]) : [];
  if (addresses.length) {
    const map = {};
    for (const raw of addresses) {
      const a = String(raw).trim().toLowerCase();
      const row = db.prepare('SELECT public_armored, fingerprint FROM mail_public_keys WHERE workspace_id = ? AND address = ?').get(req.ws.id, a);
      if (row) map[a] = { public_armored: row.public_armored, fingerprint: row.fingerprint };
    }
    return res.json(map);
  }
  res.json(db.prepare('SELECT address, fingerprint, created_at FROM mail_public_keys WHERE workspace_id = ? ORDER BY address').all(req.ws.id));
});

export default router;
