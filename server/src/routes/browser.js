import { Router } from 'express';
import { nanoid } from 'nanoid';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowIso } from '../db.js';
import { membershipRole } from '../access.js';
import { createLimiter } from '../security.js';

const hash = (t) => createHash('sha256').update(t).digest('hex');
const LIMIT = 5;

// ---- pairing management (session-authenticated; mounted with the other workspace routes) ----
export const pairingsRouter = Router();
pairingsRouter.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, name, prefix, created_at, last_seen_at, shared_origin, shared_title FROM browser_pairings WHERE user_id = ? AND workspace_id = ? AND revoked_at IS NULL ORDER BY created_at').all(req.user.id, req.ws.id)
    .map((p) => ({ ...p, online: !!p.last_seen_at && p.last_seen_at >= new Date(Date.now() - 90_000).toISOString() })));
});
pairingsRouter.post('/', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (db.prepare('SELECT COUNT(*) AS n FROM browser_pairings WHERE user_id = ? AND revoked_at IS NULL').get(req.user.id).n >= LIMIT) return res.status(400).json({ error: `at most ${LIMIT} paired browsers` });
  const secret = `amb_br_${randomBytes(24).toString('base64url')}`;
  const id = nanoid();
  db.prepare('INSERT INTO browser_pairings (id, user_id, workspace_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.user.id, req.ws.id, name, hash(secret), secret.slice(0, 14), nowIso());
  res.status(201).json({ id, name, token: secret, note: 'Shown once. Paste it into the extension. It lets the assistant work in a tab YOU share, and nothing else.' });
});
pairingsRouter.delete('/:id', (req, res) => {
  db.prepare('UPDATE browser_pairings SET revoked_at = ?, shared_origin = NULL, last_snapshot = NULL WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(nowIso(), req.params.id, req.user.id);
  db.prepare("UPDATE browser_commands SET status = 'expired' WHERE pairing_id = ? AND status IN ('pending', 'running')").run(req.params.id);
  res.status(204).end();
});

// The extension folder as a zip (stored, no compression), so it can be downloaded, unzipped and loaded unpacked in Chrome.
const extDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'extension');
function buildZip() {
  const parts = []; const central = []; let offset = 0;
  for (const name of readdirSync(extDir).filter((f) => /\.(json|js|html)$/.test(f)).sort()) {
    const data = readFileSync(join(extDir, name)); const nm = Buffer.from(name); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
    parts.push(local, nm, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nm); offset += local.length + nm.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
pairingsRouter.get('/extension.zip', (req, res) => {
  res.setHeader('content-type', 'application/zip'); res.setHeader('content-disposition', 'attachment; filename="amb-board-extension.zip"');
  res.send(buildZip());
});

// ---- the extension's own endpoints: bearer token only, no cookies, any origin (the token is the credential) ----
export const extRouter = Router();
const limiter = createLimiter({ max: 400, windowMs: 60_000 });
extRouter.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
extRouter.use((req, res, next) => {
  const m = /^Bearer (amb_br_[\w-]+)$/.exec(req.headers.authorization || '');
  const p = m ? db.prepare('SELECT * FROM browser_pairings WHERE token_hash = ? AND revoked_at IS NULL').get(hash(m[1])) : null;
  if (!p) return res.status(401).json({ error: 'invalid or revoked pairing token' });
  if (!limiter.take(p.id)) return res.status(429).json({ error: 'slow down' });
  const user = db.prepare('SELECT id, disabled_at FROM users WHERE id = ?').get(p.user_id);
  if (!user || user.disabled_at || !membershipRole(p.user_id, p.workspace_id)) return res.status(401).json({ error: 'this pairing no longer has access' });
  db.prepare('UPDATE browser_pairings SET last_seen_at = ? WHERE id = ?').run(nowIso(), p.id);
  req.pairing = p;
  next();
});

// the person shares (or stops sharing) a tab
extRouter.post('/hello', (req, res) => {
  const shared = req.body.shared === true;
  let origin = null;
  if (shared) { try { origin = new URL(String(req.body.url || '')).origin; } catch { return res.status(400).json({ error: 'invalid page address' }); } if (!/^https?:/.test(origin)) return res.status(400).json({ error: 'only web pages can be shared' }); }
  db.prepare('UPDATE browser_pairings SET shared_origin = ?, shared_title = ?, shared_at = CASE WHEN ? IS NULL THEN NULL WHEN shared_origin IS ? THEN shared_at ELSE ? END, last_snapshot = CASE WHEN shared_origin IS ? THEN last_snapshot ELSE NULL END WHERE id = ?')
    .run(origin, shared ? String(req.body.title || '').slice(0, 200) : null, origin, origin, nowIso(), origin, req.pairing.id);
  if (!shared) db.prepare("UPDATE browser_commands SET status = 'expired' WHERE pairing_id = ? AND status IN ('pending', 'running')").run(req.pairing.id);
  res.json({ ok: true, user: db.prepare('SELECT name FROM users WHERE id = ?').get(req.pairing.user_id)?.name });
});

// long poll: the next command for this pairing, or null after `wait` seconds
extRouter.get('/poll', async (req, res) => {
  const wait = Math.max(0, Math.min(20, Number(req.query.wait) || 0)) * 1000;
  const deadline = Date.now() + wait;
  let aborted = false; req.on('close', () => { aborted = true; });
  for (;;) {
    db.prepare("UPDATE browser_commands SET status = 'expired' WHERE status IN ('pending', 'running') AND expires_at < ?").run(nowIso());
    const c = db.prepare("SELECT id, kind, payload FROM browser_commands WHERE pairing_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1").get(req.pairing.id);
    if (c && db.prepare("UPDATE browser_commands SET status = 'running' WHERE id = ? AND status = 'pending'").run(c.id).changes) return res.json({ command: { id: c.id, kind: c.kind, payload: JSON.parse(c.payload) } });
    if (Date.now() >= deadline || aborted) return res.json({ command: null });
    await new Promise((r) => setTimeout(r, 300));
  }
});

extRouter.post('/commands/:id/result', (req, res) => {
  const c = db.prepare("SELECT id FROM browser_commands WHERE id = ? AND pairing_id = ? AND status = 'running'").get(req.params.id, req.pairing.id);
  if (!c) return res.status(404).json({ error: 'unknown or finished command' });
  const body = JSON.stringify(req.body.ok === true ? (req.body.data ?? {}) : { error: String(req.body.error || 'the browser could not do that').slice(0, 300) });
  if (body.length > 200_000) return res.status(413).json({ error: 'result too large' });
  db.prepare('UPDATE browser_commands SET status = ?, result = ?, done_at = ? WHERE id = ?').run(req.body.ok === true ? 'done' : 'failed', body, nowIso(), c.id);
  res.json({ ok: true });
});
