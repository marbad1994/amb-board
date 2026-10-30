import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbPath } from './db.js';

// Encrypts small secrets (tokens for connected tools) before they are stored. The key is SECRETS_KEY from the
// environment, or a random key generated once and kept next to the database (mode 600) so a database backup alone
// does not reveal them.
let key = null;
function getKey() {
  if (key) return key;
  if (process.env.SECRETS_KEY) { key = createHash('sha256').update(process.env.SECRETS_KEY).digest(); return key; }
  if (dbPath === ':memory:') { key = randomBytes(32); return key; }
  const file = join(dirname(dbPath), '.secret-key');
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 }); }
  key = createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest();
  return key;
}

export function encryptSecret(text) {
  if (!text) return '';
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decryptSecret(blob) {
  if (!blob) return '';
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', getKey(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
