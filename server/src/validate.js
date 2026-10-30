export const PROJECT_STATUSES = ['todo', 'in_progress', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// Strict calendar date YYYY-MM-DD (rejects 2026-02-30). null/'' clears the value.
export function parseDate(value) {
  if (value === null || value === '' || value === undefined) return null;
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? undefined : s;
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);

export function escapeLike(q) {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}
