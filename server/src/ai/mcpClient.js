import dns from 'node:dns/promises';
import net from 'node:net';
import { db, nowIso } from '../db.js';
import { decryptSecret } from '../secrets.js';

// Minimal MCP client (Streamable HTTP, JSON-RPC 2.0) so the assistant can use tools of servers the user connected.
// Everything a server returns is untrusted text. Calls are bounded (time, size, no redirects) and may not reach private networks.
const TIMEOUT_MS = 15_000; const MAX_BYTES = 256 * 1024;
const PROTOCOL = '2025-03-26';

const privateV4 = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; };
const privateV6 = (ip) => { const x = ip.toLowerCase(); return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || (x.startsWith('::ffff:') && privateV4(x.slice(7))); };
const isPrivate = (ip) => (net.isIPv4(ip) ? privateV4(ip) : privateV6(ip));

// Blocks plain http and private/loopback addresses (SSRF) unless MCP_ALLOW_PRIVATE=true (development and tests only).
export async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('that is not a valid URL'), { status: 400 }); }
  const dev = process.env.MCP_ALLOW_PRIVATE === 'true';
  if (u.protocol !== 'https:' && !(dev && u.protocol === 'http:')) throw Object.assign(new Error('the server address must start with https://'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('put credentials in the token field, not in the URL'), { status: 400 });
  if (!dev) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (addrs.length === 0) throw Object.assign(new Error('could not resolve that server address'), { status: 400 });
    if (addrs.some((a) => isPrivate(a.address))) throw Object.assign(new Error('that address is on a private network and cannot be used'), { status: 400 });
  }
  return u;
}

async function rpc(server, body, session) {
  const u = await assertSafeUrl(server.url);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
  const token = decryptSecret(server.auth_enc);
  if (token) headers.authorization = `Bearer ${token}`;
  if (session) headers['mcp-session-id'] = session;
  const res = await fetch(u, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const sid = res.headers.get('mcp-session-id') || session;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('the server sent too much data');
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  if (body.id === undefined) return { sid };
  let text = buf.toString('utf8');
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const msgs = text.split(/\n\n/).map((b) => b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean);
    text = msgs.find((m) => { try { return JSON.parse(m).id === body.id; } catch { return false; } }) || '';
  }
  let json; try { json = JSON.parse(text); } catch { throw new Error('the server sent an unreadable answer'); }
  if (json.error) throw new Error(String(json.error.message || 'the server reported an error').slice(0, 200));
  return { result: json.result, sid };
}

async function session(server) {
  const init = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'amb-board', version: '1.0' } } });
  await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid).catch(() => {});
  return init.sid;
}

const cache = new Map(); // server id -> { at, tools }
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

export async function listTools(server, force = false) {
  const hit = cache.get(server.id);
  if (!force && hit && Date.now() - hit.at < 5 * 60_000) return hit.tools;
  try {
    const sid = await session(server);
    const { result } = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid);
    const tools = (result?.tools || []).slice(0, 60).map((t) => ({ name: clean(t.name, 80), description: clean(t.description, 300), read_only: t.annotations?.readOnlyHint === true,
      input: JSON.stringify(t.inputSchema?.properties ? Object.fromEntries(Object.entries(t.inputSchema.properties).slice(0, 12).map(([k, v]) => [k, clean(v?.type, 20)])) : {}), required: t.inputSchema?.required || [] }));
    cache.set(server.id, { at: Date.now(), tools });
    db.prepare('UPDATE mcp_servers SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(nowIso(), server.id);
    return tools;
  } catch (err) {
    db.prepare('UPDATE mcp_servers SET last_error = ? WHERE id = ?').run(clean(err.message, 200), server.id);
    throw err;
  }
}

export async function callTool(server, name, args) {
  const sid = await session(server);
  const { result } = await rpc(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, sid);
  const text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { is_error: !!result?.isError, text: text.slice(0, 6000) };
}
export const forgetServer = (id) => cache.delete(id);
