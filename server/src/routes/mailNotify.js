import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { mailConfig } from '../mail/config.js';

// New-mail reports from amb-mail-notify (a small service on the mail server that watches the mailboxes). It carries a shared secret,
// not a session cookie. It only tells AMB Board WHO wrote and the subject; the mail itself stays on the mail server and is read in the
// webmail. Each message becomes a notification for the member the mailbox is assigned to.
const router = Router();
const MAX_MESSAGES = 20; const INDIVIDUAL = 3;
let windowStart = 0; let seen = 0;
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const same = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

router.post('/', (req, res) => {
  const c = mailConfig();
  if (!c.enabled || c.notifySecret.length < 16) return res.status(404).json({ error: 'not found' });
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!same(given, c.notifySecret)) return res.status(401).json({ error: 'unauthorized' });
  const now = Date.now(); if (now - windowStart > 60_000) { windowStart = now; seen = 0; }
  const msgs = (Array.isArray(req.body?.messages) ? req.body.messages : []).slice(0, MAX_MESSAGES);
  seen += msgs.length; if (seen > 600) return res.status(429).json({ error: 'too many reports' });

  const address = clean(req.body?.address, 254).toLowerCase(); const [local, domain] = [address.slice(0, address.lastIndexOf('@')), address.slice(address.lastIndexOf('@') + 1)];
  const a = db.prepare(`SELECT a.workspace_id, a.notify_user_id, a.created_by FROM mail_accounts a JOIN mail_domains d ON d.id = a.domain_id
    WHERE a.local_part = ? AND d.domain = ? AND d.verified_at IS NOT NULL`).get(local, domain);
  if (!a || !msgs.length) return res.json({ accepted: 0 });
  const isMember = (u) => !!u && db.prepare('SELECT 1 FROM workspace_members WHERE user_id = ? AND workspace_id = ?').get(u, a.workspace_id);
  const userId = isMember(a.notify_user_id) ? a.notify_user_id : (isMember(a.created_by) ? a.created_by : null);
  if (!userId) return res.json({ accepted: 0 });
  if (db.prepare('SELECT mail FROM notification_preferences WHERE user_id = ?').get(userId)?.mail === 0) return res.json({ accepted: 0, muted: true });

  const link = c.webmailUrl || '';
  const ins = db.prepare('INSERT OR IGNORE INTO notifications (id, workspace_id, user_id, kind, title, body, link, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const make = (title, body, key) => Number(ins.run(nanoid(), a.workspace_id, userId, 'mail', title, body, link, key, nowIso()).changes);
  let accepted = 0;
  const fresh = msgs.filter((m) => /^[\w.,:+=@-]{1,200}$/.test(String(m?.id ?? '')));
  for (const m of fresh.slice(0, INDIVIDUAL)) {
    const from = clean(m.from, 120); const subject = clean(m.subject, 200);
    accepted += make(from ? `New mail from ${from}` : `New mail in ${address}`, `${subject || '(no subject)'} - ${address}`, `mail:${address}:${m.id}`);
  }
  if (fresh.length > INDIVIDUAL) accepted += make(`${fresh.length - INDIVIDUAL} more new messages`, `in ${address}`, `mail:${address}:batch:${fresh[0].id}`);
  res.json({ accepted });
});

export default router;
