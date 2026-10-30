import { fmt } from '../lib/money.js';

// Dependency-free SVG charts. Every chart has a text equivalent (legend/table) so it is not colour-only.
export const PALETTE = ['#0b7a70', '#3b82f6', '#e0a526', '#8b5cf6', '#d92d20', '#14b8a6', '#f97316', '#64748b'];

function polar(cx, cy, r, angle) {
  const a = (angle - 90) * (Math.PI / 180);
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// data: [{ label, value }] (value in minor units, > 0). Largest 7 shown, the rest grouped as "Other".
export function DonutChart({ data, currency, title }) {
  const sorted = data.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7).reduce((a, d) => a + d.value, 0);
  const slices = rest ? [...top, { label: 'Other', value: rest }] : top;
  const total = slices.reduce((a, d) => a + d.value, 0);
  if (!total) return <p className="muted">No spending to chart.</p>;
  let start = 0;
  const R = 70; const r = 42; const cx = 90; const cy = 90;
  const arcs = slices.map((d, i) => {
    const sweep = (d.value / total) * 360;
    const a0 = start; const a1 = start + sweep; start = a1;
    if (sweep >= 359.99) return { d, i, path: `M ${cx} ${cy - R} A ${R} ${R} 0 1 1 ${cx - 0.01} ${cy - R} L ${cx - 0.01} ${cy - r} A ${r} ${r} 0 1 0 ${cx} ${cy - r} Z` };
    const [x0, y0] = polar(cx, cy, R, a0); const [x1, y1] = polar(cx, cy, R, a1);
    const [x2, y2] = polar(cx, cy, r, a1); const [x3, y3] = polar(cx, cy, r, a0);
    const large = sweep > 180 ? 1 : 0;
    return { d, i, path: `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r} ${r} 0 ${large} 0 ${x3} ${y3} Z` };
  });
  return (
    <figure className="chart chart--donut">
      <svg viewBox="0 0 180 180" role="img" aria-label={`${title}: ${slices.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(', ')}`}>
        {arcs.map(({ d, i, path }) => <path key={d.label} d={path} fill={PALETTE[i % PALETTE.length]} stroke="var(--color-surface)" strokeWidth="1.5"><title>{`${d.label}: ${fmt(d.value, currency)}`}</title></path>)}
        <text x="90" y="86" textAnchor="middle" className="chart__total-label">Total</text>
        <text x="90" y="104" textAnchor="middle" className="chart__total">{fmt(total, currency)}</text>
      </svg>
      <figcaption>
        <ul className="legend">
          {slices.map((d, i) => (
            <li key={d.label}><i style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" /><span>{d.label}</span><b>{fmt(d.value, currency)}</b><small>{Math.round((d.value / total) * 100)}%</small></li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

// Budget vs actual per category: grey track = budget, coloured fill = spent (red when over).
export function BudgetBars({ rows, currency }) {
  const mine = rows.filter((r) => r.currency === currency);
  if (!mine.length) return null;
  const max = Math.max(...mine.map((r) => Math.max(r.budget_minor, r.actual_minor)), 1);
  const H = 26; const W = 420; const L = 110;
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W + L + 90} ${mine.length * H + 10}`} role="img" aria-label={`Budget versus spent per category in ${currency}: ${mine.map((r) => `${r.category} ${fmt(r.actual_minor, currency)} of ${fmt(r.budget_minor, currency)}`).join('; ')}`}>
        {mine.map((r, i) => {
          const y = i * H + 4; const bw = (r.budget_minor / max) * W; const aw = (r.actual_minor / max) * W;
          const color = r.status === 'over' ? '#d92d20' : r.status === 'warning' ? '#e0a526' : '#0b7a70';
          return (
            <g key={`${r.category_id}-${r.currency}`}>
              <text x={L - 8} y={y + 13} textAnchor="end" className="chart__label">{r.category.slice(0, 16)}</text>
              <rect x={L} y={y} width={Math.max(bw, 1)} height={18} rx={3} fill="var(--color-border)" />
              <rect x={L} y={y + 3} width={Math.max(aw, 0)} height={12} rx={3} fill={color}><title>{`${r.category}: ${fmt(r.actual_minor, currency)} of ${fmt(r.budget_minor, currency)}`}</title></rect>
              <text x={L + Math.max(bw, aw) + 6} y={y + 13} className="chart__label">{r.used_pct ?? 0}%</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="hint">Grey bar: monthly limit. Coloured bar: spent so far (amber at 80%, red when over).</figcaption>
    </figure>
  );
}

// points: [{ month, income_minor, expenses_minor }]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const [y, m] = String(ym).split('-'); return `${MONTHS[Number(m) - 1] || ym}${m === '01' ? ` ${y.slice(2)}` : ''}`; };
const compact = (minor) => { const v = Math.abs(minor) / 100; return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : String(Math.round(v)); };

export function TrendBars({ points, currency }) {
  const max = Math.max(...points.flatMap((p) => [p.income_minor, p.expenses_minor]), 1);
  const W = 420; const H = 150; const base = H - 22; const group = W / points.length; const bw = Math.min(22, group / 3);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Income and expenses per month in ${currency}: ${points.map((p) => `${p.month} income ${fmt(p.income_minor, currency)}, expenses ${fmt(p.expenses_minor, currency)}`).join('; ')}`}>
        <line x1="0" x2={W} y1={base} y2={base} stroke="var(--color-border)" />
        {points.map((p, i) => {
          const x = i * group + group / 2;
          const hi = (p.income_minor / max) * (base - 20); const he = (Math.max(p.expenses_minor, 0) / max) * (base - 20);
          return (
            <g key={p.month}>
              <rect x={x - bw - 1} y={base - hi} width={bw} height={hi} rx={2} fill="#0b7a70"><title>{`${p.month} income ${fmt(p.income_minor, currency)}`}</title></rect>
              <rect x={x + 1} y={base - he} width={bw} height={he} rx={2} fill="#e0a526"><title>{`${p.month} expenses ${fmt(p.expenses_minor, currency)}`}</title></rect>
              <text x={x} y={H - 6} textAnchor="middle" className="chart__label">{monthLabel(p.month)}</text>
              {p.income_minor > 0 && <text x={x - bw / 2 - 1} y={base - hi - 3} textAnchor="middle" className="chart__label chart__label--value">{compact(p.income_minor)}</text>}
              {p.expenses_minor > 0 && <text x={x + bw / 2 + 1} y={base - he - 3} textAnchor="middle" className="chart__label chart__label--value">{compact(p.expenses_minor)}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="legend legend--row"><span><i style={{ background: '#0b7a70' }} aria-hidden="true" /> Income</span><span><i style={{ background: '#e0a526' }} aria-hidden="true" /> Expenses</span></figcaption>
    </figure>
  );
}
