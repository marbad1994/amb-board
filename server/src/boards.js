import { db } from './db.js';

export const COLUMN_STATUSES = ['todo', 'doing', 'blocked', 'done'];

// Room check for a column's card limit. `exceptCardId` is the card being moved (it does not count against its own move).
export function columnRoom(columnId, exceptCardId = null) {
  const col = db.prepare('SELECT id, name, card_limit, status FROM columns WHERE id = ?').get(columnId);
  if (!col || col.card_limit == null) return { ok: true, col };
  const n = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE column_id = ? AND id IS NOT ?').get(columnId, exceptCardId).n;
  return { ok: n < col.card_limit, col, count: n };
}
export const fullMessage = (col) => `Column "${col.name}" is full (limit ${col.card_limit}). Finish or move a card out of it first.`;

// Where a card should live when its status changes: a column of the same project that holds that status and has room.
// Returns { column } | { full: col } (every matching column is full) | {} (no column holds that status: nothing to move).
export function columnForStatus(card, status) {
  const cols = db.prepare('SELECT c.id, c.name, c.status, c.card_limit FROM columns c WHERE c.project_id = (SELECT project_id FROM columns WHERE id = ?) AND c.status = ? ORDER BY c.position').all(card.column_id, status);
  if (cols.length === 0) return {};
  if (cols.some((c) => c.id === card.column_id)) return {};            // already in a column that holds this status
  const open = cols.find((c) => columnRoom(c.id, card.id).ok);
  return open ? { column: open } : { full: cols[0] };
}
