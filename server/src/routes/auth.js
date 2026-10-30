import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import {
  hashPassword, verifyPassword, DUMMY_HASH, newToken, sha256, createLimiter, PASSWORD_MIN, PASSWORD_MAX,
} from '../security.js';
import { requireAuth, SESSION_COOKIE, SESSION_DAYS } from '../access.js';
import { createWorkspace, listWorkspacesFor } from '../workspaceService.js';

const router = Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const loginFailures = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
const registerAttempts = createLimiter({ max: Number(process.env.REGISTER_RATE_MAX) || 10, windowMs: 60 * 60 * 1000 });
export const _limiters = { loginFailures, registerAttempts }; // exposed for tests

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cookieOptions(maxAgeSec) {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

function startSession(req, res, userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, nowIso(), expires, String(req.headers['user-agent'] || '').slice(0, 200), req.ip || '');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions(SESSION_DAYS * 86400)}`);
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

function auditNoWs(userId, action) {
  db.prepare(`INSERT INTO audit_log (id, workspace_id, user_id, action, entity_type, entity_id, meta, created_at)
    VALUES (?, NULL, ?, ?, 'user', ?, '{}', ?)`).run(nanoid(), userId, action, userId, nowIso());
}

router.post('/register', wrap(async (req, res) => {
  if (!registerAttempts.take(`ip:${req.ip}`)) return res.status(429).json({ error: 'too many attempts, try later' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 80);
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'a valid email is required' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `password must be at least ${PASSWORD_MIN} characters` });
  if (password.length > PASSWORD_MAX) return res.status(400).json({ error: 'password is too long' });

  const passwordHash = await hashPassword(password);
  let userId;
  try {
    userId = tx(() => {
      const id = nanoid();
      const ts = nowIso();
      db.prepare('INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, name, passwordHash, ts, ts);
      const wsId = createWorkspace({ userId: id, name: 'Personal Space', kind: 'personal' });
      // D4: the very first account adopts pre-auth legacy data.
      if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 1) {
        db.prepare('UPDATE projects SET workspace_id = ? WHERE workspace_id IS NULL').run(wsId);
        db.prepare('UPDATE idea_notes SET workspace_id = ? WHERE workspace_id IS NULL').run(wsId);
      }
      auditNoWs(id, 'user.register');
      return id;
    });
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'an account with this email already exists' });
    throw err;
  }
  startSession(req, res, userId);
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
  res.status(201).json({ user: publicUser(user), workspaces: listWorkspacesFor(userId) });
}));

router.post('/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = `login:${email}`;
  if (loginFailures.blocked(key)) return res.status(429).json({ error: 'too many failed attempts, try again later' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || user.disabled_at) {
    loginFailures.record(key);
    return res.status(401).json({ error: 'invalid email or password' });
  }
  loginFailures.clear(key);
  startSession(req, res, user.id);
  auditNoWs(user.id, 'user.login');
  res.json({ user: publicUser(user), workspaces: listWorkspacesFor(user.id) });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, workspaces: listWorkspacesFor(req.user.id) });
});

router.post('/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(0)}`);
  res.status(204).end();
});

// Session revocation: sign out everywhere.
router.post('/logout-all', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(0)}`);
  auditNoWs(req.user.id, 'user.logout_all');
  res.status(204).end();
});

router.post('/password', requireAuth, wrap(async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
    return res.status(400).json({ error: `new password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters` });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(current.slice(0, PASSWORD_MAX), user.password_hash))) {
    return res.status(403).json({ error: 'current password is incorrect' });
  }
  const hash = await hashPassword(next);
  tx(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, nowIso(), user.id);
    // revoke every other session
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(user.id, req.sessionId);
    auditNoWs(user.id, 'user.password_change');
  });
  res.status(204).end();
}));

export default router;
