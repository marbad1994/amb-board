// Deterministic reading of a budget SPREADSHEET export (label + amount cells, no dates). Every amount comes from this
// code; the AI only classifies the labels. Works for Romanian and other languages.
import { parseAmount } from './csv.js';

const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const isNumberCell = (c) => {
  const s = String(c ?? '').trim();
  return s !== '' && /\d/.test(s) && !/%/.test(s) && !/[a-z]{3,}/i.test(s.replace(/\b(ron|lei|eur|usd|gbp|sek)\b/gi, '')) && parseAmount(s) !== null;
};
const isTextCell = (c) => { const s = String(c ?? '').trim(); return /\p{L}/u.test(s) && !isNumberCell(s); };

const TOTAL_RE = /\b(total|subtotal|sold|rest|ramas|ramasa|disponibil|diferenta|balanta|balance|suma)\b/;
const INCOME_RE = /\b(salar|venit|incasar|bonus|alocati|pensie|chirie incasata|income|salary|wage)/;

// Returns [{id, label, section, amount_minor, row, col}] in sheet order.
export function readSheet(rows) {
  const out = []; let section = ''; let multi = 0;
  const running = new Map(); // column -> amounts since the last total in that column
  rows.forEach((r, ri) => {
    const filled = r.map((c) => String(c ?? '').trim()).filter(Boolean);
    if (filled.length === 1 && isTextCell(filled[0])) { section = filled[0].slice(0, 60); running.clear(); return; }
    let label = '';
    r.forEach((cell, ci) => {
      if (isTextCell(cell)) { label = String(cell).replace(/\s+/g, ' ').trim().slice(0, 60); return; }
      if (!isNumberCell(cell)) return;
      const amount = parseAmount(cell);
      if (!label) return;
      if (amount === null || amount === 0) { label = ''; return; }
      const prev = running.get(ci) || [];
      const sum = prev.reduce((a, b) => a + b, 0);
      // a figure equal to the sum of the lines above it (in the same column) is a subtotal, not a new line
      const isSum = prev.length >= 2 && Math.abs(amount) === Math.abs(sum);
      out.push({ id: out.length, label, section, amount_minor: Math.abs(amount), row: ri, col: ci, negative: amount < 0, total: isSum });
      running.set(ci, isSum ? [] : [...prev, Math.abs(amount)]);
      label = '';
    });
    if (r.filter(isNumberCell).length > 1 && out.length) multi += 1;
  });
  return { items: out, multiAmountRows: multi };
}

// Used when the AI is unavailable.
export function heuristicKind(item) {
  const l = fold(item.label); const s = fold(item.section);
  if (item.total || TOTAL_RE.test(l)) return 'total';
  if (INCOME_RE.test(l) || INCOME_RE.test(s)) return 'income';
  return 'expense';
}
