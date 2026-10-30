import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { can, audit } from '../access.js';
import { AiUnavailableError, AiLimitError, AiFailureError } from '../ai/gateway.js';
import { chat, listConversations, getConversation, presentProposal, expireOld } from '../ai/assistant.js';
import { executeProposalAsync, AUTO_APPROVABLE } from '../ai/actions.js';
import { userServers, findServer, toolsOf, forget } from '../ai/mcpServers.js';
import { assertSafeUrl } from '../ai/mcpClient.js';
import { encryptSecret } from '../secrets.js';
import { computeSuggestions, dismiss } from '../ai/suggestions.js';
import { TOOLS } from '../ai/tools.js';
import { ACTION_TYPES, PROPOSAL_DOCS } from '../ai/actions.js';

const router = Router();

function fail(res, err) {
  if (err instanceof AiUnavailableError) return res.status(503).json({ error: err.message });
  if (err instanceof AiLimitError) return res.status(429).json({ error: err.message });
  if (err instanceof AiFailureError) return res.status(502).json({ error: err.message });
  console.error('assistant error:', err);
  return res.status(500).json({ error: 'internal error' });
}

// Conversations are private to the user who started them, even inside a shared workspace.
router.get('/conversations', (req, res) => res.json(listConversations(req.ws.id, req.user.id)));

router.get('/conversations/:id', (req, res) => {
  const conv = getConversation(req.ws.id, req.user.id, req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  res.json(conv);
});

router.post('/chat', async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (message.length > 2000) return res.status(400).json({ error: 'message is too long (2000 characters max)' });
  try {
    const out = await chat({ workspaceId: req.ws.id, user: req.user, role: req.ws.role, conversationId: req.body.conversationId, message, context: req.body.context });
    if (out.notFound) return res.status(404).json({ error: 'not found' });
    res.json(out);
  } catch (err) { fail(res, err); }
});

function ownProposal(req) {
  expireOld();
  return db.prepare('SELECT * FROM ai_action_proposals WHERE id = ? AND workspace_id = ? AND user_id = ?').get(req.params.id, req.ws.id, req.user.id);
}

// Approval is the only way a proposal changes data. It re-checks the approver's CURRENT role, so a user
// demoted after the proposal was made cannot use it, and it re-validates the target against current data.
router.post('/proposals/:id/approve', async (req, res) => {
  const p = ownProposal(req);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!can(req.ws.role, 'content:write')) return res.status(403).json({ error: 'insufficient permissions' });
  if (p.status !== 'pending') return res.status(409).json({ error: `proposal is already ${p.status}` });
  // claim first so concurrent approvals cannot both execute
  const claimed = db.prepare("UPDATE ai_action_proposals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(nowIso(), req.user.id, p.id);
  if (!Number(claimed.changes)) return res.status(409).json({ error: 'proposal is already decided' });
  try {
    const result = await executeProposalAsync(p, req.user);
    db.prepare('UPDATE ai_action_proposals SET result = ? WHERE id = ?').run(JSON.stringify(result), p.id);
    audit(req, 'ai.action_executed', result.entity, result.id ?? '', { proposal: p.id, type: p.type, description: p.description });
    res.json(presentProposal(db.prepare('SELECT * FROM ai_action_proposals WHERE id = ?').get(p.id)));
  } catch (err) {
    db.prepare("UPDATE ai_action_proposals SET status = 'failed', result = ? WHERE id = ?").run(JSON.stringify({ error: err.message }), p.id);
    audit(req, 'ai.action_failed', 'proposal', p.id, { type: p.type, reason: err.message });
    res.status(422).json({ error: err.message, proposal: presentProposal(db.prepare('SELECT * FROM ai_action_proposals WHERE id = ?').get(p.id)) });
  }
});

router.post('/proposals/:id/reject', (req, res) => {
  const p = ownProposal(req);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.status !== 'pending') return res.status(409).json({ error: `proposal is already ${p.status}` });
  db.prepare("UPDATE ai_action_proposals SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?").run(nowIso(), req.user.id, p.id);
  audit(req, 'ai.action_rejected', 'proposal', p.id, { type: p.type });
  res.json(presentProposal(db.prepare('SELECT * FROM ai_action_proposals WHERE id = ?').get(p.id)));
});

// Proactive next steps. Free (no AI call); `context=project:<id>` or `context=finance` adds page-specific ones.
router.get('/suggestions', (req, res) => {
  const [page, id] = String(req.query.context || '').split(':');
  res.json({ suggestions: computeSuggestions({ workspaceId: req.ws.id, userId: req.user.id, role: req.ws.role, context: page ? { page, id } : null }) });
});

// body: { days: 1 | 7 }
router.post('/suggestions/dismiss', (req, res) => {
  const key = String(req.body.key || '').trim();
  const days = [1, 7, 30].includes(Number(req.body.days)) ? Number(req.body.days) : 1;
  if (!key) return res.status(400).json({ error: 'key is required' });
  dismiss(req.user.id, req.ws.id, key, days);
  res.status(204).end();
});

// The skill catalogue, for the UI ("what can the assistant do") and for MCP clients.
router.get('/skills', (req, res) => {
  res.json({
    read: Object.entries(TOOLS).map(([name, t]) => ({ name, kind: t.kind || 'read', description: t.doc })),
    write: ACTION_TYPES.map((name) => ({ name, kind: 'write', requires_approval: true, arguments: PROPOSAL_DOCS[name] })),
  });
});

// ---- what the assistant may do without asking ----
router.get('/settings', (req, res) => {
  const row = db.prepare('SELECT auto_approve FROM ai_user_settings WHERE user_id = ? AND workspace_id = ?').get(req.user.id, req.ws.id);
  res.json({ auto_approve: JSON.parse(row?.auto_approve ?? '[]').filter((t) => AUTO_APPROVABLE.includes(t)), available: AUTO_APPROVABLE });
});
router.put('/settings', (req, res) => {
  const list = Array.isArray(req.body.auto_approve) ? [...new Set(req.body.auto_approve.map(String))] : null;
  if (!list || list.some((t) => !AUTO_APPROVABLE.includes(t))) return res.status(400).json({ error: 'auto_approve must be a list of routine change types' });
  db.prepare(`INSERT INTO ai_user_settings (user_id, workspace_id, auto_approve) VALUES (?, ?, ?) ON CONFLICT (user_id, workspace_id) DO UPDATE SET auto_approve = excluded.auto_approve`).run(req.user.id, req.ws.id, JSON.stringify(list));
  audit(req, 'ai.auto_approve_changed', 'user', req.user.id, { types: list });
  res.json({ auto_approve: list, available: AUTO_APPROVABLE });
});

// ---- other MCP servers the assistant may use (private to the person who added them) ----
const present = (s) => ({ id: s.id, name: s.name, url: s.url, has_token: !!s.auth_enc, last_ok_at: s.last_ok_at, last_error: s.last_error });
router.get('/connections', (req, res) => res.json(userServers(req.ws.id, req.user.id).map(present)));
router.post('/connections', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (userServers(req.ws.id, req.user.id).length >= 10) return res.status(409).json({ error: 'at most 10 connected servers' });
  if (findServer(req.ws.id, req.user.id, name)) return res.status(409).json({ error: 'you already have a server with that name' });
  try { await assertSafeUrl(String(req.body.url || '')); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const id = nanoid();
  db.prepare('INSERT INTO mcp_servers (id, workspace_id, user_id, name, url, auth_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.ws.id, req.user.id, name, String(req.body.url).trim(), encryptSecret(String(req.body.token || '').trim()), nowIso());
  audit(req, 'ai.connection_added', 'mcp_server', id, { name });
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
  try { const tools = await toolsOf(server); res.status(201).json({ ...present(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)), tools: tools.length }); }
  catch (e) { res.status(201).json({ ...present(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)), tools: 0, warning: `Saved, but the server could not be reached: ${String(e.message).slice(0, 120)}` }); }
});
router.post('/connections/:id/test', async (req, res) => {
  const s = findServer(req.ws.id, req.user.id, req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  try { res.json({ tools: (await toolsOf(s)).map((t) => ({ name: t.name, read_only: t.read_only })) }); } catch (e) { res.status(502).json({ error: String(e.message).slice(0, 150) }); }
});
router.delete('/connections/:id', (req, res) => {
  const s = findServer(req.ws.id, req.user.id, req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(s.id); forget(s.id);
  audit(req, 'ai.connection_removed', 'mcp_server', s.id, { name: s.name });
  res.status(204).end();
});

export default router;
