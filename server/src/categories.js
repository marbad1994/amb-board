import { db } from './db.js';

// What removing a category touches. Used by the screen (to show the counts), the API and the assistant.
export function categoryUsage(ws, id) {
  const n = (sql) => db.prepare(sql).get(ws, id).n;
  return {
    transactions: n('SELECT COUNT(*) n FROM transactions WHERE workspace_id = ? AND category_id = ?'),
    recurring: n('SELECT COUNT(*) n FROM recurring_expenses WHERE workspace_id = ? AND category_id = ?'),
    budget_lines: n('SELECT COUNT(*) n FROM monthly_budgets WHERE workspace_id = ? AND category_id = ?'),
    children: n('SELECT COUNT(*) n FROM transaction_categories WHERE workspace_id = ? AND parent_id = ? AND archived_at IS NULL'),
  };
}

// Caller owns the transaction. Entries move to `moveTo` (or become uncategorised), sub-categories become top level,
// the category's monthly budget lines are deleted with it.
export function removeCategory(ws, id, moveTo = null) {
  db.prepare('UPDATE transactions SET category_id = ? WHERE workspace_id = ? AND category_id = ?').run(moveTo, ws, id);
  db.prepare('UPDATE recurring_expenses SET category_id = ? WHERE workspace_id = ? AND category_id = ?').run(moveTo, ws, id);
  db.prepare('UPDATE transaction_categories SET parent_id = NULL WHERE workspace_id = ? AND parent_id = ?').run(ws, id);
  db.prepare('DELETE FROM monthly_budgets WHERE workspace_id = ? AND category_id = ?').run(ws, id);
  db.prepare('DELETE FROM transaction_categories WHERE workspace_id = ? AND id = ?').run(ws, id);
}

// Shared checks. Returns { error } or { cat, moveTo, usage }.
export function planCategoryRemoval(ws, role, canFn, id, moveToId) {
  const cat = db.prepare('SELECT id, name, parent_id FROM transaction_categories WHERE id = ? AND workspace_id = ?').get(String(id), ws);
  if (!cat) return { error: 'unknown category' };
  let moveTo = null;
  if (moveToId) {
    moveTo = db.prepare('SELECT id, name, parent_id FROM transaction_categories WHERE id = ? AND workspace_id = ? AND archived_at IS NULL').get(String(moveToId), ws);
    if (!moveTo) return { error: 'unknown category to move entries to' };
    if (moveTo.id === cat.id) return { error: 'cannot move entries into the category being removed' };
  }
  const usage = categoryUsage(ws, cat.id);
  if (usage.budget_lines && !canFn(role, 'budget:approve')) return { error: 'this category has budget limits; only an owner or admin can remove it' };
  return { cat, moveTo, usage };
}
