import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { can, audit } from '../access.js';
import { AiUnavailableError, AiLimitError, AiFailureError } from '../ai/gateway.js';
import { chat, listConversations, getConversation, presentProposal, expireOld } from '../ai/assistant.js';
import { executeProposal } from '../ai/actions.js';

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
    const out = await chat({ workspaceId: req.ws.id, user: req.user, role: req.ws.role, conversationId: req.body.conversationId, message });
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
router.post('/proposals/:id/approve', (req, res) => {
  const p = ownProposal(req);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!can(req.ws.role, 'content:write')) return res.status(403).json({ error: 'insufficient permissions' });
  if (p.status !== 'pending') return res.status(409).json({ error: `proposal is already ${p.status}` });
  // claim first so concurrent approvals cannot both execute
  const claimed = db.prepare("UPDATE ai_action_proposals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(nowIso(), req.user.id, p.id);
  if (!Number(claimed.changes)) return res.status(409).json({ error: 'proposal is already decided' });
  try {
    const result = executeProposal(p, req.user);
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

export default router;
