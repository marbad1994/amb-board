import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { db } from '../db.js';
import { decryptSecret } from '../secrets.js';
import { mailConfig } from './config.js';

// The in-app webmail is a thin relay: the server talks IMAP/SMTP to the same Dovecot/Postfix the
// helper configures, using the member's own mailbox password. The password is stored encrypted at
// rest (see webmail_sessions) and held in memory only for the length of a request.

export function sessionRow(userId, wsId) {
  return db.prepare('SELECT * FROM webmail_sessions WHERE user_id = ? AND workspace_id = ?').get(userId, wsId) ?? null;
}

export function webmailSession(userId, wsId) {
  const row = sessionRow(userId, wsId);
  return row ? { address: row.address, password: decryptSecret(row.password_enc) } : null;
}

const imapPort = () => Number(process.env.MAIL_IMAP_PORT) || 993;
const smtpPort = () => Number(process.env.MAIL_SMTP_PORT) || 587;

export function clientSettings() {
  const c = mailConfig();
  return {
    host: c.host || '127.0.0.1',
    imap: { host: c.host || '127.0.0.1', port: imapPort(), security: 'SSL/TLS' },
    smtp: { host: c.host || '127.0.0.1', port: smtpPort(), security: 'STARTTLS' },
  };
}

export function newClient(session) {
  const c = mailConfig();
  return new ImapFlow({
    host: c.host || '127.0.0.1',
    port: imapPort(),
    secure: true,
    auth: { user: session.address, pass: session.password },
    logger: false,
    connectionTimeout: 15_000,
  });
}

let testClientFactory = null;
// Tests replace the real IMAP connection with a fake client so no mail server is needed.
export const __setImapClientForTests = (factory) => { testClientFactory = factory; };

// ImapFlow emits 'error' on the client itself for failures after the connect promise has settled
// (a dropped connection, a Dovecot restart mid-command). With no listener attached, Node turns that
// into ERR_UNHANDLED_ERROR and kills the whole server - which is exactly what happened in production
// ("Emitted 'error' event on ImapFlow instance"). The pending command still rejects with a
// NoConnection error, so the request fails cleanly; this listener only keeps the process alive.
const quietErrorListener = (err) => console.error('imap connection error:', err.message);

// A Dovecot restart or a network blip can drop the connection during the handshake. One quick retry
// turns those blips into a seamless (if slightly slower) request instead of a 502.
const transientConnectError = (err) =>
  String(err.code || '').startsWith('ClosedAfterConnect')
  || ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err.code)
  || /unexpected close|socket hang up/i.test(err.message);

async function openClient(session, attempt = 0) {
  const client = newClient(session);
  client.on('error', quietErrorListener);
  try {
    await client.connect();
    return client;
  } catch (err) {
    client.close();   // release the socket; a failed handshake must not leak connections
    if (attempt === 0 && transientConnectError(err)) return openClient(session, 1);
    throw err;
  }
}

export async function withClient(session, fn) {
  if (testClientFactory) return fn(await testClientFactory(session));
  const client = await openClient(session);
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---- folders ----
export async function listFolders(session) {
  return withClient(session, async (client) => {
    const boxes = await client.list();
    const out = [];
    for (const box of boxes) {
      if (box.flags.has('\\Noselect')) continue;
      let count = null;
      try { count = await client.status(box.name, { messages: true, unseen: true }); } catch { count = null; }
      out.push({
        name: box.name,
        specialUse: box.specialUse || null,
        messages: count?.messages ?? null,
        unseen: count?.unseen ?? null,
      });
    }
    return out;
  });
}

// ---- messages ----
const ADDR = (a) => ({ name: a?.name || '', address: a?.address || '' });

function summary(m, folder) {
  const env = m.envelope || {};
  const from = (env.from || []).map(ADDR);
  const to = (env.to || []).map(ADDR);
  return {
    uid: m.uid,
    folder,
    from,
    to,
    fromText: from.map((a) => a.name || a.address).join(', ') || '(no sender)',
    toText: to.map((a) => a.name || a.address).join(', '),
    subject: env.subject || '(no subject)',
    date: m.internalDate ? new Date(m.internalDate).toISOString() : null,
    seen: m.flags.has('\\Seen'),
    flagged: m.flags.has('\\Flagged'),
    answered: m.flags.has('\\Answered'),
    size: m.size,
  };
}

export async function listMessages(session, folder, page = 1, limit = 30) {
  return withClient(session, async (client) => {
    const box = await client.mailboxOpen(folder);
    try {
      const total = box.exists;
      const size = Math.max(1, Math.min(100, limit));
      const p = Math.max(1, page);
      const end = Math.max(1, total - (p - 1) * size);
      const start = Math.max(1, end - size + 1);
      const rows = [];
      // an empty mailbox rejects any sequence set, so only fetch when there is something to fetch
      if (total > 0 && start <= end) {
        for await (const m of client.fetch(`${start}:${end}`, { envelope: true, flags: true, uid: true, internalDate: true, size: true })) {
          rows.push(summary(m, folder));
        }
      }
      rows.reverse(); // newest first
      return { folder, total, unseen: box.unseen ?? null, page: p, pageSize: size, hasMore: start > 1, messages: rows };
    } finally {
      await client.mailboxClose().catch(() => {});
    }
  });
}

const stripHtml = (html) => String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function plainText(parsed) {
  if (parsed.text) return parsed.text;
  return parsed.html ? stripHtml(parsed.html) : '';
}

function addrList(v) {
  return ((v && v.value) || []).map(ADDR);
}

export async function readMessage(session, folder, uid) {
  return withClient(session, async (client) => {
    await client.mailboxOpen(folder);
    try {
      const m = await client.fetchOne(uid, { source: true, envelope: true, flags: true, internalDate: true, uid: true }, { uid: true });
      if (!m || !m.source) return null;
      const parsed = await simpleParser(m.source);
      if (!m.flags.has('\\Seen')) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      return {
        uid: m.uid,
        folder,
        from: addrList(parsed.from),
        to: addrList(parsed.to),
        cc: addrList(parsed.cc),
        bcc: addrList(parsed.bcc),
        subject: parsed.subject || '(no subject)',
        date: parsed.date ? parsed.date.toISOString() : null,
        messageId: parsed.messageId || '',
        inReplyTo: parsed.inReplyTo || '',
        references: (Array.isArray(parsed.references) ? parsed.references : String(parsed.references || '').split(/\s+/)).filter(Boolean),
        seen: true,
        flagged: m.flags.has('\\Flagged'),
        text: plainText(parsed),
        attachments: (parsed.attachments || []).map((a) => ({
          filename: a.filename || 'attachment',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || (a.content ? a.content.length : 0),
          contentBase64: a.content ? a.content.toString('base64') : '',
        })),
      };
    } finally {
      await client.mailboxClose().catch(() => {});
    }
  });
}

// ---- actions ----
export async function setFlags(session, folder, uid, { seen, flagged }) {
  return withClient(session, async (client) => {
    await client.mailboxOpen(folder);
    try {
      if (seen !== undefined) {
        if (seen) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
      }
      if (flagged !== undefined) {
        if (flagged) await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
        else await client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
      }
      return { ok: true };
    } finally {
      await client.mailboxClose().catch(() => {});
    }
  });
}

export async function moveMessage(session, folder, uid, target) {
  return withClient(session, async (client) => {
    await client.mailboxOpen(folder);
    try {
      await client.messageMove(uid, target, { uid: true });
      return { ok: true };
    } finally {
      await client.mailboxClose().catch(() => {});
    }
  });
}

export async function deleteMessage(session, folder, uid, trashFolder) {
  return withClient(session, async (client) => {
    await client.mailboxOpen(folder);
    try {
      if (trashFolder && folder !== trashFolder) {
        await client.messageMove(uid, trashFolder, { uid: true });
      } else {
        await client.messageDelete(uid, { uid: true });
      }
      return { ok: true };
    } finally {
      await client.mailboxClose().catch(() => {});
    }
  });
}

// ---- send ----
const rawTransport = () => nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
async function composeRaw(data) {
  const info = await rawTransport().sendMail(data);
  const raw = info.message;
  return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
}

function attachmentData(attachments) {
  return (attachments || []).map((a) => ({
    filename: String(a.filename || 'attachment').replace(/[\r\n]/g, ''),
    contentType: String(a.contentType || 'application/octet-stream'),
    content: Buffer.from(String(a.contentBase64 || ''), 'base64'),
  }));
}

export async function sendMail(session, mail) {
  const c = mailConfig();
  const data = {
    from: session.address,
    to: mail.to || [],
    cc: mail.cc || [],
    bcc: mail.bcc || [],
    subject: String(mail.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 500),
    text: mail.text || '',
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
    ...(mail.references?.length ? { references: mail.references } : {}),
    attachments: attachmentData(mail.attachments),
  };
  const transporter = nodemailer.createTransport({
    host: c.host || '127.0.0.1',
    port: smtpPort(),
    secure: false,
    requireTLS: true,
    auth: { user: session.address, pass: session.password },
    connectionTimeout: 15_000,
    socketTimeout: 20_000,
  });
  await transporter.sendMail(data);

  // Postfix does not file a copy of what the webmail sends; save one to Sent ourselves (best effort).
  try {
    const raw = await composeRaw(data);
    await withClient(session, async (client) => {
      try { await client.mailboxOpen('Sent'); } catch { return; }
      try { await client.messageAppend('Sent', raw, ['\\Seen'], new Date()); } finally { await client.mailboxClose().catch(() => {}); }
    });
  } catch (err) {
    console.error('could not save a copy to Sent:', err.message);
  }
  return { ok: true };
}
