// Deterministic bank-CSV parsing. No AI is involved here: every date and amount comes from this code.

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 5000;

// RFC 4180-ish parser: quotes, escaped quotes, CRLF, embedded newlines. Delimiter is detected from the header line.
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) break;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row); }
  return { delimiter, rows };
}

const norm = (h) => String(h).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const HEADERS = {
  date: ['date', 'data', 'transaction date', 'booking date', 'posting date', 'data tranzactie', 'data operatiunii', 'datum', 'buchungstag'],
  description: ['description', 'details', 'detail', 'memo', 'payee', 'merchant', 'narrative', 'reference', 'descriere', 'detalii', 'detalii tranzactie', 'beneficiar', 'beneficiar ordonator', 'name', 'text', 'verwendungszweck'],
  amount: ['amount', 'suma', 'valoare', 'value', 'betrag', 'amount eur', 'amount ron', 'transaction amount'],
  debit: ['debit', 'debit amount', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'plati', 'debitat'],
  credit: ['credit', 'credit amount', 'deposit', 'deposits', 'money in', 'paid in', 'incasari', 'creditat'],
  currency: ['currency', 'ccy', 'moneda', 'valuta', 'wahrung'],
};

// Finds which column holds what. Returns { mapping, headers } or { error } listing the headers it saw.
export function detectColumns(headerRow) {
  const headers = headerRow.map(norm);
  const find = (names) => headers.findIndex((h) => names.includes(h));
  const loose = (names) => headers.findIndex((h) => names.some((n) => h.includes(n)));
  const m = { date: find(HEADERS.date), description: find(HEADERS.description), amount: find(HEADERS.amount),
    debit: find(HEADERS.debit), credit: find(HEADERS.credit), currency: find(HEADERS.currency) };
  if (m.date < 0) m.date = loose(['date', 'data']);
  if (m.description < 0) m.description = loose(['descri', 'detail', 'merchant', 'payee', 'benef']);
  if (m.amount < 0 && m.debit < 0 && m.credit < 0) m.amount = loose(['amount', 'suma', 'valoare']);
  const hasAmount = m.amount >= 0 || m.debit >= 0 || m.credit >= 0;
  if (m.date < 0 || m.description < 0 || !hasAmount) {
    return { error: `Could not find the date, description and amount columns. Columns seen: ${headerRow.slice(0, 15).map((h) => `"${String(h).slice(0, 30)}"`).join(', ')}` };
  }
  return { mapping: m };
}

// Handles 1.234,56 / 1,234.56 / 1234.56 / (12.00) / -12 / "12 EUR" / currency symbols. Returns integer minor units (signed) or null.
export function parseAmount(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^-|-$/.test(s)) { neg = true; s = s.replace(/^-|-$/g, ''); }
  s = s.replace(/^\+/, '').replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'); const lastComma = s.lastIndexOf(',');
  let decimalSep = null;
  if (lastDot >= 0 && lastComma >= 0) decimalSep = lastDot > lastComma ? '.' : ',';
  else if (lastComma >= 0) decimalSep = /,\d{1,2}$/.test(s) && s.split(',').length === 2 ? ',' : null;
  else if (lastDot >= 0) decimalSep = /\.\d{1,2}$/.test(s) && s.split('.').length === 2 ? '.' : null;
  let whole = s; let frac = '';
  if (decimalSep) { const i = s.lastIndexOf(decimalSep); whole = s.slice(0, i); frac = s.slice(i + 1); }
  // thousands separators must be well-formed groups (1,234,567 / 1.234.567); anything else is not a number
  if (/[.,]/.test(whole) && !/^\d{1,3}([.,]\d{3})+$/.test(whole)) return null;
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole || '0') || !/^\d{0,2}$/.test(frac)) return null;
  const minor = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0') || 0);
  if (!Number.isSafeInteger(minor) || minor > 1e12) return null;
  return neg ? -minor : minor;
}

// YYYY-MM-DD, YYYY/MM/DD, DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY (day first, the European convention, unless the
// first number is impossible as a day), with optional time. Returns 'YYYY-MM-DD' or null for non-dates.
export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  let y; let m; let d;
  let r = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (r) [, y, m, d] = r.map(Number);
  else {
    r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (!r) return null;
    const a = Number(r[1]); const b = Number(r[2]);
    y = Number(r[3]);
    if (b > 12 && a <= 12) { m = a; d = b; } else { d = a; m = b; }
  }
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso || y < 1990 || y > 2100 ? null : iso;
}

// signMode: 'auto' | 'negative_is_expense' | 'positive_is_expense'
// auto: separate debit/credit columns are used as such; with one signed column, negatives are expenses when both signs
// occur; if every amount has the same sign, they are all treated as expenses (typical card statement).
export function extractRows(rows, defaultCurrency, signMode = 'auto') {
  const [header, ...body] = rows;
  const det = detectColumns(header);
  if (det.error) return { error: det.error };
  const { mapping: m } = det;
  const parsed = []; let skipped = 0;
  for (const r of body.slice(0, MAX_ROWS)) {
    const date = parseDate(r[m.date]);
    const description = String(r[m.description] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    let signed = null;
    if (m.debit >= 0 || m.credit >= 0) {
      const debit = m.debit >= 0 ? parseAmount(r[m.debit]) : null;
      const credit = m.credit >= 0 ? parseAmount(r[m.credit]) : null;
      if (debit) signed = -Math.abs(debit);
      else if (credit) signed = Math.abs(credit);
    }
    if (signed === null && m.amount >= 0) signed = parseAmount(r[m.amount]);
    const cur = m.currency >= 0 ? String(r[m.currency] || '').trim().toUpperCase() : '';
    if (!date || signed === null || signed === 0 || !description) { skipped += 1; continue; }
    parsed.push({ date, description, signed, currency: /^[A-Z]{3}$/.test(cur) ? cur : defaultCurrency });
  }
  const hasDebitCredit = m.debit >= 0 || m.credit >= 0;
  const pos = parsed.filter((p) => p.signed > 0).length; const neg = parsed.filter((p) => p.signed < 0).length;
  let expensesAreNegative = true;
  if (!hasDebitCredit) {
    if (signMode === 'positive_is_expense') expensesAreNegative = false;
    else if (signMode === 'auto' && (pos === 0 || neg === 0)) expensesAreNegative = neg > 0 ? true : false;
  }
  const out = parsed.map((p) => {
    const isExpense = hasDebitCredit || expensesAreNegative ? p.signed < 0 : p.signed > 0;
    return { date: p.date, description: p.description, amount_minor: Math.abs(p.signed), currency: p.currency, type: isExpense ? 'expense' : 'income' };
  });
  return { rows: out, skipped, mapping: m, header, sign_assumption: hasDebitCredit ? 'debit/credit columns' : expensesAreNegative ? 'negative amounts are expenses' : 'positive amounts are expenses' };
}

// Merchant key used for grouping and for what is sent to the AI: card numbers, long digit runs and dates removed.
export function merchantKey(description) {
  return String(description).toLowerCase()
    .replace(/\b\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?\b/g, ' ')   // dates first, before their digits are stripped
    .replace(/\d{4,}/g, ' ')                                       // card / reference / IBAN-like digit runs
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
