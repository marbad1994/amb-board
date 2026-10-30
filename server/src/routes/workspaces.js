import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { newToken, sha256 } from '../security.js';
import { membershipRole, can } from '../access.js';
import { createWorkspace, listWorkspacesFor } from '../workspaceService.js';

const router = Router();
export const invitationsRouter = Router();

const INVITE_DAYS = 7;
const INVITE_ROLES = ['admin', 'member', 'viewer'];

function auditWs(req, wsId, action, entityType, entityId, meta = {}) {
  db.prepare(`INSERT INTO audit_log (id, workspace_id, user_id, action, entity_type, entity_id, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(nanoid(), wsId, req.user.id, action, entityType, entityId, JSON.stringify(meta), nowIso());
}

// Resolves :id to a membership for the caller (404 when not a member) and checks a permission.
function withMembership(permission) {
  return (req, res, next) => {
    const role = membershipRole(req.user.id, req.params.id);
    if (!role) return res.status(404).json({ error: 'workspace not found' });
    if (permission && !can(role, permission)) return res.status(403).json({ error: 'insufficient permissions' });
    req.wsRole = role;
    next();
  };
}

router.get('/', (req, res) => res.json(listWorkspacesFor(req.user.id)));

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = tx(() => createWorkspace({ userId: req.user.id, name, kind: 'shared' }));
  auditWs(req, id, 'workspace.create', 'workspace', id, { name });
  res.status(201).json(listWorkspacesFor(req.user.id).find((w) => w.id === id));
});

router.patch('/:id', withMembership('workspace:manage'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), req.params.id);
  auditWs(req, req.params.id, 'workspace.rename', 'workspace', req.params.id, { name });
  res.json(listWorkspacesFor(req.user.id).find((w) => w.id === req.params.id));
});

// ---- members ----
router.get('/:id/members', withMembership(null), (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.name, u.email, m.role, m.created_at FROM workspace_members m
    JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at ASC`).all(req.params.id));
});

router.patch('/:id/members/:userId', withMembership('members:manage'), (req, res) => {
  const role = String(req.body.role || '');
  if (!INVITE_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${INVITE_ROLES.join(', ')}` });
  const target = membershipRole(req.params.userId, req.params.id);
  if (!target) return res.status(404).json({ error: 'member not found' });
  if (target === 'owner') return res.status(400).json({ error: 'the owner role cannot be changed' });
  if (target === 'admin' && req.wsRole !== 'owner') return res.status(403).json({ error: 'only the owner can change an admin' });
  if (role === 'admin' && req.wsRole !== 'owner') return res.status(403).json({ error: 'only the owner can grant admin' });
  db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, req.params.id, req.params.userId);
  auditWs(req, req.params.id, 'member.role_change', 'user', req.params.userId, { role });
  res.status(204).end();
});

router.delete('/:id/members/:userId', withMembership(null), (req, res) => {
  const self = req.params.userId === req.user.id;
  if (!self && !can(req.wsRole, 'members:manage')) return res.status(403).json({ error: 'insufficient permissions' });
  const target = membershipRole(req.params.userId, req.params.id);
  if (!target) return res.status(404).json({ error: 'member not found' });
  if (target === 'owner') return res.status(400).json({ error: 'the owner cannot be removed' });
  if (target === 'admin' && !self && req.wsRole !== 'owner') return res.status(403).json({ error: 'only the owner can remove an admin' });
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  auditWs(req, req.params.id, self ? 'member.leave' : 'member.remove', 'user', req.params.userId);
  res.status(204).end();
});

// ---- invitations (D5) ----
router.get('/:id/invitations', withMembership('members:manage'), (req, res) => {
  res.json(db.prepare(`SELECT id, email, role, created_at, expires_at FROM invitations
    WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`)
    .all(req.params.id, nowIso()));
});

router.post('/:id/invitations', withMembership('members:manage'), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || 'member');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'a valid email is required' });
  if (!INVITE_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${INVITE_ROLES.join(', ')}` });
  if (role === 'admin' && req.wsRole !== 'owner') return res.status(403).json({ error: 'only the owner can invite an admin' });
  const ws = db.prepare('SELECT kind FROM workspaces WHERE id = ?').get(req.params.id);
  if (ws.kind === 'personal') return res.status(400).json({ error: 'personal workspaces cannot have members; create a shared workspace' });
  const existing = db.prepare(`SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND u.email = ?`).get(req.params.id, email);
  if (existing) return res.status(409).json({ error: 'already a member' });

  const token = newToken();
  const id = nanoid();
  db.prepare(`INSERT INTO invitations (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.params.id, email, role, sha256(token), req.user.id, nowIso(), new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString());
  auditWs(req, req.params.id, 'invitation.create', 'invitation', id, { email, role });
  // The token is returned exactly once; only its hash is stored.
  res.status(201).json({ id, email, role, token });
});

router.delete('/:id/invitations/:invitationId', withMembership('members:manage'), (req, res) => {
  db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL')
    .run(nowIso(), req.params.invitationId, req.params.id);
  auditWs(req, req.params.id, 'invitation.revoke', 'invitation', req.params.invitationId);
  res.status(204).end();
});

invitationsRouter.post('/accept', (req, res) => {
  const token = String(req.body.token || '');
  const inv = db.prepare(`SELECT * FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
    .get(sha256(token), nowIso());
  // same response for unknown/expired and wrong-email so tokens cannot be probed
  if (!inv || inv.email.toLowerCase() !== req.user.email.toLowerCase()) {
    return res.status(400).json({ error: 'invitation is invalid or expired' });
  }
  tx(() => {
    db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(inv.workspace_id, req.user.id, inv.role, nowIso());
    db.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').run(nowIso(), inv.id);
  });
  auditWs(req, inv.workspace_id, 'invitation.accept', 'invitation', inv.id);
  res.json({ workspaces: listWorkspacesFor(req.user.id), workspaceId: inv.workspace_id });
});

export default router;
