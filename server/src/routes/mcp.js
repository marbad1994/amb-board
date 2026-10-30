import { Router } from 'express';
import { nanoid } from 'nanoid';
import { createHash, randomBytes } from 'node:crypto';
import { db, nowIso } from '../db.js';
import { can, membershipRole } from '../access.js';
import { TOOLS, runSkill } from '../ai/tools.js';
import { ACTION_TYPES, PROPOSAL_DOCS, validateProposal } from '../ai/actions.js';
import { createLimiter } from '../security.js';

// ---------------------------------------------------------------------------------------------
// MCP (Model Context Protocol) endpoint: JSON-RPC 2.0 over HTTP POST at /api/mcp, authenticated with a
// personal access token bound to ONE workspace. It exposes exactly the same skills as the in-app assistant:
//   read / analysis / report skills run immediately (scoped to the token's workspace and user);
//   write skills only CREATE A PROPOSAL; a human must approve it inside AMB Board. Nothing changes until then.
// ---------------------------------------------------------------------------------------------
const hash = (t) => createHash('sha256').update(t).digest('hex');
const limiter = createLimiter({ max: 120, windowMs: 60_000 });

// ---- token management (session-authenticated, mounted separately) ----
export const tokensRouter = Router();
const TOKEN_LIMIT = 10;

tokensRouter.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? AND workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(req.user.id, req.ws.id));
});

tokensRouter.post('/', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL').get(req.user.id).n >= TOKEN_LIMIT) return res.status(400).json({ error: `at most ${TOKEN_LIMIT} active tokens` });
  const secret = `amb_pat_${randomBytes(24).toString('base64url')}`;
  const id = nanoid();
  db.prepare('INSERT INTO api_tokens (id, user_id, workspace_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.user.id, req.ws.id, name, hash(secret), secret.slice(0, 12), nowIso());
  res.status(201).json({ id, name, token: secret, note: 'Shown once. It acts as you in this workspace; write actions still need your approval in the app.' });
});

tokensRouter.delete('/:id', (req, res) => {
  db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(nowIso(), req.params.id, req.user.id);
  res.status(204).end();
});

// ---- the MCP endpoint ----
const mcp = Router();
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

const readTools = () => Object.entries(TOOLS).map(([name, t]) => ({
  name, description: `[${t.kind || 'read'}] ${t.doc}`, inputSchema: { type: 'object', additionalProperties: true },
}));
const proposeTools = () => ACTION_TYPES.map((type) => ({
  name: `propose_${type}`, description: `[write: creates a PENDING proposal that the user must approve in AMB Board] arguments: ${PROPOSAL_DOCS[type]}`,
  inputSchema: { type: 'object', additionalProperties: true },
}));

function auth(req, res, next) {
  const m = String(req.headers.authorization || '').match(/^Bearer (amb_pat_[\w-]{20,})$/);
  if (!m) return res.status(401).json(rpcError(null, -32001, 'a personal access token is required (Authorization: Bearer amb_pat_...)'));
  const row = db.prepare(`SELECT t.id, t.user_id, t.workspace_id, u.name, u.email, u.disabled_at FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL`).get(hash(m[1]));
  if (!row || row.disabled_at) return res.status(401).json(rpcError(null, -32001, 'invalid or revoked token'));
  const role = membershipRole(row.user_id, row.workspace_id);
  if (!role) return res.status(401).json(rpcError(null, -32001, 'the token owner is no longer a member of this workspace'));
  if (!limiter.take(`mcp:${row.id}`)) return res.status(429).json(rpcError(null, -32002, 'rate limit exceeded'));
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  req.mcp = { user: { id: row.user_id, name: row.name, email: row.email }, ws: row.workspace_id, role };
  next();
}

mcp.post('/', auth, async (req, res) => {
  const { id, method, params } = req.body || {};
  if (req.body?.jsonrpc !== '2.0' || typeof method !== 'string') return res.json(rpcError(id, -32600, 'invalid JSON-RPC request'));
  const { user, ws, role } = req.mcp;
  try {
    if (method === 'initialize') {
      return res.json(ok(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'amb-board', version: '1.0.0' },
        instructions: 'Read, analysis and report tools run immediately. propose_* tools only create pending proposals that the user approves inside AMB Board.' }));
    }
    if (method === 'notifications/initialized') return res.status(204).end();
    if (method === 'ping') return res.json(ok(id, {}));
    if (method === 'tools/list') return res.json(ok(id, { tools: [...readTools(), ...proposeTools()] }));
    if (method === 'tools/call') {
      const name = String(params?.name || '');
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const text = (obj, isError = false) => res.json(ok(id, { content: [{ type: 'text', text: JSON.stringify(obj) }], isError }));
      if (name.startsWith('propose_')) {
        const type = name.slice('propose_'.length);
        if (!ACTION_TYPES.includes(type)) return text({ error: 'unknown tool' }, true);
        if (!can(role, 'content:write')) return text({ error: 'insufficient permissions: viewers cannot propose changes' }, true);
        const v = validateProposal(type, args, ws);
        if (v.error) return text({ error: v.error }, true);
        // proposals made over MCP live in one private conversation per user so they appear in the app for approval
        let conv = db.prepare("SELECT id FROM ai_conversations WHERE workspace_id = ? AND user_id = ? AND title = 'External assistant (MCP)'").get(ws, user.id);
        if (!conv) { const cid = nanoid(); db.prepare("INSERT INTO ai_conversations (id, workspace_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, 'External assistant (MCP)', ?, ?)").run(cid, ws, user.id, nowIso(), nowIso()); conv = { id: cid }; }
        const mid = nanoid(); const pid = nanoid(); const now = nowIso();
        db.prepare("INSERT INTO ai_messages (id, conversation_id, role, content, tool_trace, created_at) VALUES (?, ?, 'assistant', ?, '{\"calls\":[],\"artifacts\":[]}', ?)").run(mid, conv.id, `An external assistant proposed: ${v.description}`, now);
        db.prepare(`INSERT INTO ai_action_proposals (id, workspace_id, conversation_id, message_id, user_id, type, target, payload, description, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pid, ws, conv.id, mid, user.id, type, JSON.stringify(v.target), JSON.stringify(v.payload), v.description, now, new Date(Date.now() + 24 * 3600_000).toISOString());
        return text({ status: 'pending_approval', proposal_id: pid, description: v.description, note: 'Nothing has changed. The user must approve this in AMB Board (AI Assistant).' });
      }
      if (!Object.hasOwn(TOOLS, name)) return text({ error: 'unknown tool' }, true);
      const result = await runSkill(name, args, ws, user);
      return text(result, !!result?.error);
    }
    return res.json(rpcError(id, -32601, `method not found: ${method.slice(0, 40)}`));
  } catch (err) {
    console.error('mcp error', err);
    return res.json(rpcError(id, -32603, 'internal error'));
  }
});

export default mcp;
