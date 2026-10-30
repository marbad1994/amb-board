// Decimal string -> integer minor units (2 decimals). Returns null when invalid. No floating point.
export function toMinor(text) {
  const m = String(text).trim().replace(',', '.').match(/^(\d{1,10})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
  return minor > 0 ? minor : null;
}

export function fmt(minor, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

const KEY = 'amb-board.currency';
export const lastCurrency = () => { try { return localStorage.getItem(KEY) || 'EUR'; } catch { return 'EUR'; } };
export const rememberCurrency = (c) => { try { localStorage.setItem(KEY, c); } catch { /* storage unavailable */ } };
