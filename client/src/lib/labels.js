export const PROJECT_STATUSES = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
];
export const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];
export const statusLabel = (v) => PROJECT_STATUSES.find((s) => s.value === v)?.label || v;
export const priorityLabel = (v) => PRIORITIES.find((p) => p.value === v)?.label || v;

// 'YYYY-MM-DD' -> readable, without timezone shifting
export function formatDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
