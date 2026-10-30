import { createHash, randomBytes } from 'node:crypto';
import { db, nowIso } from '../db.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { assertSafeUrl } from './mcpClient.js';

// How a connected MCP server is authenticated. Everything secret (token, header value, OAuth client secret and tokens) is stored encrypted.
//   none    open server              bearer  Authorization: Bearer <token>        header  one custom header (for example X-API-Key)
//   oauth   OAuth 2.0 authorization code with PKCE: the person signs in in their browser, tokens are refreshed automatically
export const AUTH_TYPES = ['none', 'bearer', 'header', 'oauth'];
export const TRANSPORTS = [{ id: 'streamable-http', name: 'Streamable HTTP' }];   // the only transport this client speaks

// Ready-made settings. The person still supplies their own OAuth client (Google does not allow anonymous clients).
export const PRESETS = [
  { id: 'google-calendar', name: 'Google Calendar', server_name: 'calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', auth_type: 'oauth',
    oauth: { auth_url: 'https://accounts.google.com/o/oauth2/v2/auth', token_url: 'https://oauth2.googleapis.com/token', scopes: 'https://www.googleapis.com/auth/calendar', auth_params: { access_type: 'offline', prompt: 'consent' } },
    help: 'In the same Google Cloud project as your OAuth client (type: web application), enable the Google Calendar API and the Google Calendar MCP API (calendarmcp.googleapis.com), add the redirect address below to the client, and paste the client ID and secret here. A 403 when testing means the API is not enabled in that project or the scopes are too narrow: the message shown names which. Check the scopes against Google\'s current list for the Calendar MCP.' },
];

const FORBIDDEN_HEADERS = new Set(['host', 'content-type', 'content-length', 'accept', 'cookie', 'mcp-session-id', 'mcp-protocol-version', 'authorization', 'transfer-encoding', 'connection']);
const AUTH_PARAM_KEYS = ['access_type', 'prompt', 'login_hint'];
const text = (v, n) => String(v ?? '').trim().slice(0, n);
const httpsOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (process.env.MCP_ALLOW_PRIVATE === 'true' && x.protocol === 'http:'); } catch { return false; } };

export const readMeta = (row) => { try { return JSON.parse(decryptSecret(row.auth_meta_enc) || '{}'); } catch { return {}; } };
const saveMeta = (id, meta) => db.prepare('UPDATE mcp_servers SET auth_meta_enc = ? WHERE id = ?').run(encryptSecret(JSON.stringify(meta)), id);

// Request body -> { auth_type, auth_enc, meta } for a new connection, or { error }.
export function parseAuth(b) {
  const type = AUTH_TYPES.includes(b.auth_type) ? b.auth_type : (text(b.token, 4000) ? 'bearer' : 'none');
  if (type === 'none') return { auth_type: 'none', auth_enc: '', meta: {} };
  if (type === 'bearer') { const t = text(b.token, 4000); return t ? { auth_type: 'bearer', auth_enc: encryptSecret(t), meta: {} } : { error: 'enter the access token' }; }
  if (type === 'header') {
    const name = text(b.header_name, 60); const value = text(b.token, 4000);
    if (!/^[A-Za-z0-9-]{1,60}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) return { error: 'that header name cannot be used (letters, digits and dashes; not Authorization, Content-Type, Host and similar)' };
    if (!value || /[\r\n]/.test(value)) return { error: 'enter the header value' };
    return { auth_type: 'header', auth_enc: encryptSecret(value), meta: { header_name: name } };
  }
  const o = b.oauth && typeof b.oauth === 'object' ? b.oauth : {};
  const meta = { client_id: text(o.client_id, 300), client_secret: text(o.client_secret, 500), auth_url: text(o.auth_url, 500), token_url: text(o.token_url, 500), scopes: text(o.scopes, 600).replace(/[,\s]+/g, ' ').trim() };
  if (!meta.client_id) return { error: 'enter the OAuth client ID' };
  if (!httpsOk(meta.auth_url)) return { error: 'the authorization address must start with https://' };
  if (!httpsOk(meta.token_url)) return { error: 'the token address must start with https://' };
  const params = {}; for (const k of AUTH_PARAM_KEYS) if (o.auth_params?.[k]) params[k] = text(o.auth_params[k], 100);
  if (Object.keys(params).length) meta.auth_params = params;
  return { auth_type: 'oauth', auth_enc: '', meta };
}

async function tokenRequest(meta, params) {
  const u = await assertSafeUrl(meta.token_url);
  const body = new URLSearchParams({ client_id: meta.client_id, ...(meta.client_secret ? { client_secret: meta.client_secret } : {}), ...params });
  const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  let j = {}; try { j = JSON.parse(await res.text()); } catch { /* not JSON */ }
  if (!res.ok || j.error || !j.access_token) throw new Error(`the sign-in provider refused: ${String(j.error_description || j.error || res.status).replace(/[\u0000-\u001f]/g, ' ').slice(0, 150)}`);
  return j;
}
const withTokens = (meta, j) => ({ ...meta, access_token: j.access_token, refresh_token: j.refresh_token || meta.refresh_token || '', expires_at: new Date(Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600) * 1000).toISOString(), pending: undefined });

// Headers that authenticate one request. OAuth tokens are refreshed shortly before they expire.
export async function authHeaders(server) {
  const s = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(server.id) ?? server;
  const type = s.auth_type || 'bearer';
  if (type === 'none') return {};
  if (type === 'bearer') { const t = decryptSecret(s.auth_enc); return t ? { authorization: `Bearer ${t}` } : {}; }
  const meta = readMeta(s);
  if (type === 'header') return { [meta.header_name]: decryptSecret(s.auth_enc) };
  if (!meta.access_token) throw new Error('this connection needs your authorization: press Authorize in the settings');
  if (meta.expires_at && Date.parse(meta.expires_at) - Date.now() < 60_000) {
    if (!meta.refresh_token) throw new Error('the authorization expired: press Authorize again in the settings');
    try { Object.assign(meta, withTokens(meta, await tokenRequest(meta, { grant_type: 'refresh_token', refresh_token: meta.refresh_token }))); saveMeta(s.id, meta); }
    catch (e) { throw new Error(`could not renew the authorization (${e.message}); press Authorize again in the settings`); }
  }
  return { authorization: `Bearer ${meta.access_token}` };
}

// Step 1: the address to send the person's browser to.
export function startOAuth(server, redirectUri) {
  const meta = readMeta(server);
  const state = randomBytes(24).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: meta.client_id, redirect_uri: redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(meta.scopes ? { scope: meta.scopes } : {}), ...(meta.auth_params || {}) });
  saveMeta(server.id, { ...meta, pending: { state, verifier, redirect_uri: redirectUri, expires: Date.now() + 10 * 60_000 } });
  return `${meta.auth_url}${meta.auth_url.includes('?') ? '&' : '?'}${q}`;
}

// Step 2: the provider sent the person back with a code. Only the person who started it can finish it.
export async function finishOAuth(userId, code, state) {
  if (!code || !state) throw new Error('the sign-in was not completed');
  const row = db.prepare("SELECT * FROM mcp_servers WHERE user_id = ? AND auth_type = 'oauth'").all(userId).find((r) => { const p = readMeta(r).pending; return p && p.state === state && p.expires > Date.now(); });
  if (!row) throw new Error('this sign-in link expired or was not started here; press Authorize again');
  const meta = readMeta(row);
  try { saveMeta(row.id, withTokens(meta, await tokenRequest(meta, { grant_type: 'authorization_code', code, redirect_uri: meta.pending.redirect_uri, code_verifier: meta.pending.verifier }))); }
  catch (e) { saveMeta(row.id, { ...meta, pending: undefined }); throw e; }
  db.prepare('UPDATE mcp_servers SET last_error = NULL WHERE id = ?').run(row.id);
  db.prepare('INSERT INTO audit_log (id, workspace_id, user_id, action, entity_type, entity_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`oa${randomBytes(8).toString('hex')}`, row.workspace_id, userId, 'ai.connection_authorized', 'mcp_server', row.id, JSON.stringify({ name: row.name }), nowIso());
  return row;
}

export const describeAuth = (s) => {
  const meta = s.auth_type === 'oauth' || s.auth_type === 'header' ? readMeta(s) : {};
  return { auth_type: s.auth_type || 'bearer', has_token: !!s.auth_enc, header_name: meta.header_name || undefined,
    oauth: s.auth_type === 'oauth' ? { client_id: meta.client_id, scopes: meta.scopes, authorized: !!meta.access_token, expires_at: meta.expires_at || null, can_refresh: !!meta.refresh_token } : undefined };
};
