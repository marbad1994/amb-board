import { nanoid } from 'nanoid';
import { db, nowIso } from './db.js';
import { DEFAULT_LIFE_AREAS } from './lifeAreaDefaults.js';
import { DEFAULT_CATEGORIES } from './finance/defaults.js';

// Caller is responsible for wrapping in a transaction when combined with other writes.
export function createWorkspace({ userId, name, kind }) {
  const id = nanoid();
  const ts = nowIso();
  db.prepare('INSERT INTO workspaces (id, name, kind, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, kind, userId, ts, ts);
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, 'owner', ts);
  seedLifeAreas(id);
  const cat = db.prepare('INSERT INTO transaction_categories (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)');
  for (const c of DEFAULT_CATEGORIES) cat.run(nanoid(), id, c, ts);
  return id;
}

export function seedLifeAreas(workspaceId) {
  const ts = nowIso();
  const stmt = db.prepare(`INSERT INTO life_areas (id, workspace_id, name, description, icon, position, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  DEFAULT_LIFE_AREAS.forEach(([name, description, icon], i) => stmt.run(nanoid(), workspaceId, name, description, icon, i, ts, ts));
}

export function listWorkspacesFor(userId) {
  return db.prepare(`SELECT w.id, w.name, w.kind, m.role FROM workspaces w
    JOIN workspace_members m ON m.workspace_id = w.id
    WHERE m.user_id = ? AND w.archived_at IS NULL ORDER BY w.kind ASC, w.created_at ASC`).all(userId);
}
