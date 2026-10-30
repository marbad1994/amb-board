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

// A budget TABLE: a header row with a category column and a planned/budget column (and usually a type column), as in
// "Tip | Categorie | Buget planificat | Realizat | Diferenta | Note". Everything is read by code; no AI is needed.
const kindOfType = (t) => (/venit|income|salar/.test(t) ? 'income' : 'expense');

export function readTable(rows) {
  let h = -1; let cat = -1; let plan = -1; let type = -1; let actual = -1;
  for (let i = 0; i < Math.min(rows.length, 30) && h < 0; i += 1) {
    const f = rows[i].map((c) => fold(c).replace(/[^a-z ]/g, '').trim());
    const c = f.findIndex((x) => /^(categori|category|denumire|descriere|linie|name)/.test(x));
    const p = f.findIndex((x, j) => j !== c && /(planificat|planned|budget|buget|plan$|limita|limit)/.test(x));
    if (c >= 0 && p >= 0) { h = i; cat = c; plan = p; type = f.findIndex((x) => /^(tip|type|grupa|group|grup)/.test(x)); actual = f.findIndex((x) => /(realizat|actual|real|cheltuit|spent)/.test(x)); }
  }
  if (h < 0) return null;
  const items = []; let seen = false; let skippedZero = 0; let actualTotal = 0;
  for (const r of rows.slice(h + 1)) {
    const label = String(r[cat] ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!label) { if (seen) break; continue; }       // a blank row ends the table (summary blocks follow)
    seen = true;
    const planned = parseAmount(r[plan]);
    const typeText = type >= 0 ? String(r[type] ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    const act = actual >= 0 ? parseAmount(r[actual]) : null;
    if (act) actualTotal += Math.abs(act);
    if (planned === null || planned === 0) { skippedZero += 1; continue; }
    items.push({ label, parent: typeText, kind: kindOfType(fold(typeText)), amount_minor: Math.abs(planned) });
  }
  return { items, skippedZero, actualTotal, hasActual: actual >= 0 };
}
