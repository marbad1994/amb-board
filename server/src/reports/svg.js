// Server-side SVG builders for standalone reports. No scripts, no external resources; all text escaped.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const PALETTE = ['#0b7a70', '#3b82f6', '#e0a526', '#8b5cf6', '#d92d20', '#14b8a6', '#f97316', '#64748b'];
export const money = (minor, currency) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; } };

const polar = (cx, cy, r, a) => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };

export function donut(items, currency, title) {
  const data = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const top = data.slice(0, 7); const rest = data.slice(7).reduce((a, d) => a + d.value, 0);
  const slices = rest ? [...top, { label: 'Other', value: rest }] : top;
  const total = slices.reduce((a, d) => a + d.value, 0);
  if (!total) return '<p class="muted">No data.</p>';
  let start = 0; const R = 70; const r = 42;
  const paths = slices.map((d, i) => {
    const sweep = (d.value / total) * 360; const a0 = start; start += sweep; const a1 = start;
    let path;
    if (sweep >= 359.99) path = `M 90 ${90 - R} A ${R} ${R} 0 1 1 89.99 ${90 - R} L 89.99 ${90 - r} A ${r} ${r} 0 1 0 90 ${90 - r} Z`;
    else { const [x0, y0] = polar(90, 90, R, a0); const [x1, y1] = polar(90, 90, R, a1); const [x2, y2] = polar(90, 90, r, a1); const [x3, y3] = polar(90, 90, r, a0); const l = sweep > 180 ? 1 : 0;
      path = `M ${x0} ${y0} A ${R} ${R} 0 ${l} 1 ${x1} ${y1} L ${x2} ${y2} A ${r} ${r} 0 ${l} 0 ${x3} ${y3} Z`; }
    return `<path d="${path}" fill="${PALETTE[i % 8]}" stroke="#fff" stroke-width="1.5"><title>${esc(d.label)}: ${esc(money(d.value, currency))}</title></path>`;
  }).join('');
  const legend = slices.map((d, i) => `<li><i style="background:${PALETTE[i % 8]}"></i><span>${esc(d.label)}</span><b>${esc(money(d.value, currency))}</b><small>${Math.round((d.value / total) * 100)}%</small></li>`).join('');
  return `<figure class="donut"><svg viewBox="0 0 180 180" role="img" aria-label="${esc(title)}">${paths}<text x="90" y="86" text-anchor="middle" class="t-sm">Total</text><text x="90" y="104" text-anchor="middle" class="t-b">${esc(money(total, currency))}</text></svg><ul class="legend">${legend}</ul></figure>`;
}

export function hbars(rows, currency, title) { // rows: [{label, budget, actual, status}]
  if (!rows.length) return '<p class="muted">No data.</p>';
  const max = Math.max(...rows.map((r) => Math.max(r.budget, r.actual)), 1); const W = 420; const L = 120; const H = 26;
  const body = rows.map((r, i) => {
    const y = i * H + 4; const bw = (r.budget / max) * W; const aw = (r.actual / max) * W;
    const color = r.status === 'over' ? '#d92d20' : r.status === 'warning' ? '#e0a526' : '#0b7a70';
    return `<text x="${L - 8}" y="${y + 13}" text-anchor="end" class="t-sm">${esc(String(r.label).slice(0, 18))}</text><rect x="${L}" y="${y}" width="${Math.max(bw, 1)}" height="18" rx="3" fill="#e5e7eb"/><rect x="${L}" y="${y + 3}" width="${Math.max(aw, 0)}" height="12" rx="3" fill="${color}"><title>${esc(r.label)}: ${esc(money(r.actual, currency))} of ${esc(money(r.budget, currency))}</title></rect><text x="${L + Math.max(bw, aw) + 6}" y="${y + 13}" class="t-sm">${r.budget ? Math.round((r.actual / r.budget) * 100) : 0}%</text>`;
  }).join('');
  return `<figure><svg viewBox="0 0 ${W + L + 60} ${rows.length * H + 10}" role="img" aria-label="${esc(title)}">${body}</svg><figcaption class="muted">Grey: limit. Colour: spent (amber from 80%, red when over).</figcaption></figure>`;
}

export function trend(points, currency, title) { // [{label, a, b}] a=income, b=expenses
  const max = Math.max(...points.flatMap((p) => [p.a, p.b]), 1); const W = 420; const H = 150; const base = H - 22; const g = W / points.length; const bw = Math.min(22, g / 3);
  const bars = points.map((p, i) => { const x = i * g + g / 2; const ha = (p.a / max) * (base - 8); const hb = (Math.max(p.b, 0) / max) * (base - 8);
    return `<rect x="${x - bw - 1}" y="${base - ha}" width="${bw}" height="${ha}" rx="2" fill="#0b7a70"><title>${esc(p.label)} income ${esc(money(p.a, currency))}</title></rect><rect x="${x + 1}" y="${base - hb}" width="${bw}" height="${hb}" rx="2" fill="#e0a526"><title>${esc(p.label)} expenses ${esc(money(p.b, currency))}</title></rect><text x="${x}" y="${H - 6}" text-anchor="middle" class="t-sm">${esc(p.label)}</text>`; }).join('');
  return `<figure><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="#d1d5db"/>${bars}</svg><figcaption class="legend-row"><span><i style="background:#0b7a70"></i> Income</span><span><i style="background:#e0a526"></i> Expenses</span></figcaption></figure>`;
}

export function columns(points, title) { // [{label, value, value2?}] simple columns: tasks + appointments stacked
  const max = Math.max(...points.map((p) => p.tasks + p.appointments), 1); const W = Math.max(420, points.length * 26); const H = 140; const base = H - 24; const g = W / points.length; const bw = Math.min(16, g - 4);
  const bars = points.map((p, i) => { const x = i * g + (g - bw) / 2; const ht = (p.tasks / max) * (base - 8); const ha = (p.appointments / max) * (base - 8);
    return `<rect x="${x}" y="${base - ht}" width="${bw}" height="${ht}" fill="#0b7a70"><title>${esc(p.label)}: ${p.tasks} tasks due</title></rect><rect x="${x}" y="${base - ht - ha}" width="${bw}" height="${ha}" fill="#3b82f6"><title>${esc(p.label)}: ${p.appointments} appointments</title></rect><text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" class="t-sm">${esc(p.label)}</text>`; }).join('');
  return `<figure><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="#d1d5db"/>${bars}</svg><figcaption class="legend-row"><span><i style="background:#0b7a70"></i> Tasks due</span><span><i style="background:#3b82f6"></i> Appointments</span></figcaption></figure>`;
}

export function progress(pct, label) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return `<div class="bar" role="img" aria-label="${esc(label)} ${p}%"><div style="width:${p}%"></div></div>`;
}
