import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, nowIso } from '../db.js';
import { decryptSecret } from '../secrets.js';
import { mailConfig } from './config.js';

// AMB Board never touches Postfix, Dovecot or OpenDKIM. It writes plain list files into MAIL_DIR/in and then a request file.
// A small root helper (deploy/mail/amb-mail-sync) validates every line, builds the real configuration and reloads the services.
// That keeps the web app unprivileged: a bug here can at worst produce a rejected file, never a configuration line.
const atomic = (file, text, mode = 0o640) => { const tmp = `${file}.tmp`; writeFileSync(tmp, text, { mode }); renameSync(tmp, file); };

export function renderFiles() {
  const domains = db.prepare('SELECT * FROM mail_domains WHERE verified_at IS NOT NULL ORDER BY domain').all();
  const ids = new Set(domains.map((d) => d.id)); const name = Object.fromEntries(domains.map((d) => [d.id, d.domain]));
  const accounts = db.prepare('SELECT * FROM mail_accounts ORDER BY domain_id, local_part').all().filter((a) => ids.has(a.domain_id));
  const aliases = db.prepare('SELECT * FROM mail_aliases WHERE enabled = 1 ORDER BY domain_id, local_part').all().filter((a) => ids.has(a.domain_id));
  return {
    'domains.txt': domains.map((d) => `${d.domain}\t${d.dkim_selector}`).join('\n'),
    'mailboxes.txt': accounts.map((a) => `${a.local_part}@${name[a.domain_id]}\t${a.quota_mb}`).join('\n'),
    'passwd.txt': accounts.filter((a) => a.enabled).map((a) => `${a.local_part}@${name[a.domain_id]}\t${a.password_hash}`).join('\n'),
    'aliases.txt': aliases.map((a) => `${a.local_part}@${name[a.domain_id]}\t${JSON.parse(a.destinations).join(',')}`).join('\n'),
    dkim: Object.fromEntries(domains.filter((d) => d.dkim_private_enc).map((d) => [d.domain, decryptSecret(d.dkim_private_enc)])),
  };
}

let counter = 0;
export function syncMail() {
  const cfg = mailConfig();
  if (!cfg.enabled) return { skipped: true };
  const inDir = join(cfg.dir, 'in'); const keyDir = join(inDir, 'dkim');
  mkdirSync(keyDir, { recursive: true, mode: 0o750 });
  const f = renderFiles();
  for (const k of ['domains.txt', 'mailboxes.txt', 'passwd.txt', 'aliases.txt']) atomic(join(inDir, k), f[k] ? `${f[k]}\n` : '', k === 'passwd.txt' ? 0o600 : 0o640);
  for (const [domain, pem] of Object.entries(f.dkim)) atomic(join(keyDir, `${domain}.pem`), pem, 0o600);
  for (const old of readdirSync(keyDir)) if (old.endsWith('.pem') && !(old.slice(0, -4) in f.dkim)) rmSync(join(keyDir, old), { force: true });
  atomic(join(inDir, 'sync-request'), `${nowIso()} #${++counter}\n`);   // written last: the helper starts when this changes
  return { requested: true };
}

// What the helper last did (it writes MAIL_DIR/out/status.json). null = the helper has not run yet.
export function syncStatus() {
  const file = join(mailConfig().dir, 'out', 'status.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
