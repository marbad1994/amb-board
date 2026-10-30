import { db } from '../db.js';
import { todayUtc } from '../validate.js';
import { addDays } from '../finance/money.js';
import { describeTrigger } from '../automations/spec.js';

// A compact, bounded snapshot of the whole workspace with the ids the model needs to act (so it can propose a task for a
// named project without a lookup). Private data stays private: journal entries and other people's habits are never included.
export function workspaceDigest(ws, userId, big = false) {
  const n = big ? 40 : 15;
  const today = todayUtc();
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const projects = db.prepare(`SELECT p.id, p.name, p.status, p.target_date, la.name AS life_area,
      (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id AND c.status <> 'done') AS open_tasks
    FROM projects p LEFT JOIN life_areas la ON la.id = p.life_area_id WHERE p.workspace_id = ? AND p.archived_at IS NULL ORDER BY p.created_at DESC LIMIT ?`).all(ws, n);
  const mine = db.prepare(`SELECT w.id, w.name, w.kind, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? AND w.archived_at IS NULL ORDER BY w.kind DESC, w.name`).all(userId);
  const current = mine.find((w) => w.id === ws) || db.prepare('SELECT id, name, kind FROM workspaces WHERE id = ?').get(ws);
  return {
    current_workspace: current && { id: current.id, name: current.name, kind: current.kind, your_role: current.role },
    my_workspaces: mine.map((w) => ({ id: w.id, name: w.name, kind: w.kind, your_role: w.role, current: w.id === ws, can_copy_into: w.id !== ws && ['owner', 'admin', 'member'].includes(w.role) })),
    counts: {
      active_projects: one('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL', ws).n,
      open_tasks: one(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done'`, ws).n,
      overdue_tasks: one(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done' AND c.due_date < ?`, ws, today).n,
      events_next_7_days: one('SELECT COUNT(*) AS n FROM calendar_events WHERE workspace_id = ? AND substr(start_local, 1, 10) BETWEEN ? AND ?', ws, today, addDays(today, 7)).n,
      transactions_this_month: one('SELECT COUNT(*) AS n FROM transactions WHERE workspace_id = ? AND substr(date, 1, 7) = ?', ws, today.slice(0, 7)).n,
    },
    projects,
    life_areas: db.prepare('SELECT id, name FROM life_areas WHERE workspace_id = ? AND archived_at IS NULL ORDER BY position LIMIT 20').all(ws),
    goals: db.prepare("SELECT id, title, target_date FROM goals WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?").all(ws, n),
    my_habits: db.prepare('SELECT id, title, frequency FROM habits WHERE workspace_id = ? AND user_id = ? AND archived_at IS NULL LIMIT ?').all(ws, userId, n),
    expense_categories: db.prepare('SELECT name FROM transaction_categories WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name LIMIT 40').all(ws).map((c) => c.name),
    shared_notes: db.prepare("SELECT id, title FROM notes WHERE workspace_id = ? AND kind = 'note' AND privacy = 'workspace' ORDER BY updated_at DESC LIMIT ?").all(ws, big ? 20 : 5),
    next_events: db.prepare('SELECT id, title, start_local, timezone FROM calendar_events WHERE workspace_id = ? AND substr(start_local, 1, 10) >= ? ORDER BY start_local LIMIT 6').all(ws, today),
    automations: db.prepare('SELECT id, name, enabled, trigger FROM automations WHERE workspace_id = ? ORDER BY created_at LIMIT 15').all(ws)
      .map((a) => ({ id: a.id, name: a.name, enabled: !!a.enabled, when: describeTrigger(JSON.parse(a.trigger)) })),
  };
}
