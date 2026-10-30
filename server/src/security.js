import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// Used to equalise timing when the account does not exist.
export const DUMMY_HASH = await hashPassword('timing-equaliser-not-a-real-password');

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Fixed-window counter keyed by string. In-process only (see DECISIONS D10).
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    // returns true if the action is allowed and records it
    take(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.reset <= now) {
        hits.set(key, { count: 1, reset: now + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
    // true if already over the limit, without recording a hit
    blocked(key) {
      const entry = hits.get(key);
      return !!entry && entry.reset > Date.now() && entry.count >= max;
    },
    record(key) { this.take(key); },
    clear(key) { hits.delete(key); },
  };
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  if (process.env.COOKIE_SECURE === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
}

// CSRF defence in depth on top of SameSite=Lax: reject state-changing requests whose Origin
// does not match the Host the request was sent to.
export function originCheck(req, res, next) {
  // the browser extension talks to /api/browser-ext with a bearer token only (no cookies), from a chrome-extension:// origin
  if (req.originalUrl.startsWith('/api/browser-ext/')) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (curl, tests) send no Origin
  let host;
  try { host = new URL(origin).host; } catch { return res.status(403).json({ error: 'bad origin' }); }
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (host === req.headers.host || allowed.includes(origin)) return next();
  res.status(403).json({ error: 'cross-origin request blocked' });
}
