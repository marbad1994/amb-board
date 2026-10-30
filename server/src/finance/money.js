// Money is integer minor units (2 decimals assumed; zero-decimal currencies such as JPY are not supported yet).
export const CURRENCY_RE = /^[A-Z]{3}$/;

export function parseMinor(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1e12) return value;
  return undefined;
}

export function formatMinor(minor, currency) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(minor / 100);
}

const pad = (n) => String(n).padStart(2, '0');

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Adds whole months keeping the anchor day, clamped to month length (31 Jan + 1 month = 28/29 Feb).
export function addMonths(date, months, anchorDay = Number(date.slice(8, 10))) {
  const [y, m] = date.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(anchorDay, last))}`;
}

export function nextOccurrence(date, frequency, anchorDate) {
  const anchorDay = Number(anchorDate.slice(8, 10));
  if (frequency === 'weekly') return addDays(date, 7);
  if (frequency === 'monthly') return addMonths(date, 1, anchorDay);
  if (frequency === 'yearly') return addMonths(date, 12, anchorDay);
  throw new Error(`unknown frequency ${frequency}`);
}
