import { nanoid } from 'nanoid';
import { db, nowIso } from './db.js';
import { parseCookies, sha256 } from './security.js';

export const SESSION_COOKIE = 'amb_session';
export const SESSION_DAYS = 30;

export const ROLES = ['owner', 'admin', 'member', 'viewer'];

// permission -> roles allowed
const PERMISSIONS = {
  'content:read': ['owner', 'admin', 'member', 'viewer'],
  'content:write': ['owner', 'admin', 'member'],
  'lifearea:manage': ['owner', 'admin'],
  'members:manage': ['owner', 'admin'],
  'budget:approve': ['owner', 'admin'],
  'workspace:manage': ['owner'],
};

export function can(role, permission) {
  return !!PERMISSIONS[permission]?.includes(role);
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!can(req.ws?.role, permission)) return res.status(403).json({ error: 'insufficient permissions' });
    next();
  };
}

export function audit(req, action, entityType = '', entityId = '', meta = {}) {
  db.prepare(`INSERT INTO audit_log (id, workspace_id, user_id, action, entity_type, entity_id, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nanoid(), req.ws?.id ?? null, req.user?.id ?? null, action, entityType, entityId, JSON.stringify(meta), nowIso());
}

export function membershipRole(userId, workspaceId) {
  return db.prepare('SELECT role FROM workspace_members WHERE user_id = ? AND workspace_id = ?')
    .get(userId, workspaceId)?.role ?? null;
}

export function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'authentication required' });
  const row = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name, u.disabled_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sha256(token));
  if (!row || row.disabled_at || row.expires_at <= nowIso()) {
    return res.status(401).json({ error: 'authentication required' });
  }
  req.user = { id: row.id, email: row.email, name: row.name };
  req.sessionId = row.session_id;
  next();
}

// Resolves the active workspace from x-workspace-id (or the user's personal workspace) and
// verifies membership. A non-member gets 404 so workspace ids cannot be probed.
export function requireWorkspace(req, res, next) {
  let wsId = req.headers['x-workspace-id'];
  if (!wsId) {
    wsId = db.prepare(`SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND w.kind = 'personal' AND w.archived_at IS NULL`).get(req.user.id)?.id;
  }
  const role = wsId ? membershipRole(req.user.id, String(wsId)) : null;
  const ws = role ? db.prepare('SELECT id FROM workspaces WHERE id = ? AND archived_at IS NULL').get(String(wsId)) : null;
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  req.ws = { id: ws.id, role };
  next();
}

// Reads need content:read, everything else content:write. Stricter routes add their own check.
export function methodPermission(req, res, next) {
  const perm = ['GET', 'HEAD'].includes(req.method) ? 'content:read' : 'content:write';
  if (!can(req.ws.role, perm)) return res.status(403).json({ error: 'insufficient permissions' });
  next();
}

// ---- workspace-scoped lookups. Each returns undefined when the row is not in the workspace. ----
export const projectInWs = (id, wsId) =>
  db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(String(id), wsId);

export const columnInWs = (id, wsId) =>
  db.prepare(`SELECT c.* FROM columns c JOIN projects p ON p.id = c.project_id
    WHERE c.id = ? AND p.workspace_id = ?`).get(String(id), wsId);

export const cardInWs = (id, wsId) =>
  db.prepare(`SELECT cards.* FROM cards
    JOIN columns c ON c.id = cards.column_id JOIN projects p ON p.id = c.project_id
    WHERE cards.id = ? AND p.workspace_id = ?`).get(String(id), wsId);

export const lifeAreaInWs = (id, wsId) =>
  db.prepare('SELECT * FROM life_areas WHERE id = ? AND workspace_id = ?').get(String(id), wsId);

export const ideaInWs = (id, wsId) =>
  db.prepare('SELECT * FROM idea_notes WHERE id = ? AND workspace_id = ?').get(String(id), wsId);

export function guard(lookup, param = 'id') {
  return (req, res, next) => {
    if (!lookup(req.params[param], req.ws.id)) return res.status(404).json({ error: 'not found' });
    next();
  };
}
