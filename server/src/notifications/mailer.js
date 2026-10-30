import nodemailer from 'nodemailer';
import { db, nowIso } from '../db.js';

// Outgoing email through any SMTP server (set up for Zoho: smtppro.zoho.eu, port 465, SSL). The password lives only in
// the server environment (server/.env), never in the database or the repository.
const cfg = () => ({
  host: process.env.SMTP_HOST || 'smtppro.zoho.eu',
  port: Number(process.env.SMTP_PORT || 465),
  secure: (process.env.SMTP_SECURE ?? 'true') !== 'false',
  user: process.env.SMTP_USER || process.env.SMTP_FROM_ADDRESS || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || `AMB Board <${process.env.SMTP_FROM_ADDRESS || 'admin@makketing.com'}>`,
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
});

let override = null; // tests inject a transport
export const setTransportForTests = (t) => { override = t; };
export const mailConfigured = () => !!override || (!!cfg().user && !!cfg().pass);

let cached = null; let cachedKey = '';
function transport() {
  if (override) return override;
  const c = cfg(); const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
  if (!cached || key !== cachedKey) {
    cached = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, connectionTimeout: 15_000, socketTimeout: 20_000 });
    cachedKey = key;
  }
  return cached;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export async function sendMail({ to, subject, text, html }) {
  await transport().sendMail({ from: cfg().from, to, subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200), text, html });
}

const link = (l) => (l && cfg().appUrl ? `${cfg().appUrl}${l.startsWith('/') ? l : `/${l}`}` : '');

export function renderDigest(name, items) {
  const subject = items.length === 1 ? items[0].title : `${items.length} new notifications from AMB Board`;
  const text = [`Hi ${name},`, '', ...items.flatMap((n) => [`- ${n.title}${n.body ? ` (${n.body})` : ''}`, ...(link(n.link) ? [`  ${link(n.link)}`] : [])]), '',
    `You get these because email notifications are on in your AMB Board settings${cfg().appUrl ? ` (${cfg().appUrl}/settings)` : ''}.`].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#1c2330"><h2 style="margin:0 0 12px">AMB Board</h2><p>Hi ${esc(name)},</p>`
    + `<ul style="padding-left:18px">${items.map((n) => `<li style="margin-bottom:8px"><b>${esc(n.title)}</b>${n.body ? `<br><span style="color:#5b6577">${esc(n.body)}</span>` : ''}${link(n.link) ? `<br><a href="${esc(link(n.link))}">Open</a>` : ''}</li>`).join('')}</ul>`
    + `<p style="color:#8a93a3;font-size:12px">You get these because email notifications are on in your settings. Turn them off any time under Workspace &amp; account.</p></div>`;
  return { subject, text, html };
}

let backoffUntil = 0;
const MAX_PER_USER = 10; const LOOKBACK_MS = 2 * 24 * 3600_000;

// Emails notifications created AFTER the user turned email on, at most one email per user per run, newest 10.
// A failure leaves them unsent (retried on the next run, with a 10 minute pause) so nothing is lost or duplicated.
export async function sendPendingEmails(now = new Date()) {
  if (!mailConfigured() || now.getTime() < backoffUntil) return 0;
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const users = db.prepare(`SELECT DISTINCT u.id, u.name, u.email FROM notifications n JOIN users u ON u.id = n.user_id JOIN notification_preferences p ON p.user_id = u.id
    WHERE p.email = 1 AND n.emailed_at IS NULL AND n.created_at >= p.email_enabled_at AND n.created_at >= ? LIMIT 50`).all(since);
  let sent = 0;
  for (const u of users) {
    const items = db.prepare(`SELECT n.id, n.title, n.body, n.link FROM notifications n JOIN notification_preferences p ON p.user_id = n.user_id
      WHERE n.user_id = ? AND p.email = 1 AND n.emailed_at IS NULL AND n.created_at >= p.email_enabled_at AND n.created_at >= ? ORDER BY n.created_at DESC LIMIT ?`).all(u.id, since, MAX_PER_USER);
    if (!items.length) continue;
    try {
      await sendMail({ to: u.email, ...renderDigest(u.name, items) });
      const mark = db.prepare('UPDATE notifications SET emailed_at = ? WHERE id = ?');
      const ts = nowIso();
      for (const i of items) mark.run(ts, i.id);
      // anything older than the ten shown is covered by this email too; do not send it later
      db.prepare('UPDATE notifications SET emailed_at = ? WHERE user_id = ? AND emailed_at IS NULL AND created_at <= ?').run(ts, u.id, now.toISOString());
      sent += 1;
    } catch (err) {
      console.error('email delivery failed:', err.message);
      backoffUntil = now.getTime() + 10 * 60_000;
      break;
    }
  }
  return sent;
}
export const resetBackoffForTests = () => { backoffUntil = 0; };
