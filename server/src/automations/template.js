// The placeholder language used in every text field of an automation (titles, notes, tool arguments, emails):
//   {{result.news}}   {{trigger.title}}   {{date}}   {{owner.name}}   {{workspace.name}}
//   {{result.news | pretty | truncate:600}}   {{result.summary | default:"nothing new"}}
// It is plain text substitution with a fixed set of filters. It never evaluates code, and unknown names become empty text.
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// JSON text (tool results) -> readable lines for people
export function pretty(value, depth = 0) {
  let data;
  try { data = JSON.parse(value); } catch { return value; }
  if (data && !Array.isArray(data) && Array.isArray(data.results)) data = data.results;   // search-style results: just the list
  const render = (v, d) => {
    if (v == null) return '';
    if (typeof v !== 'object') return String(v);
    if (Array.isArray(v)) return v.slice(0, 25).map((x) => (x && typeof x === 'object' && !Array.isArray(x) && ('title' in x || 'name' in x)
      ? `- ${x.title ?? x.name}${x.url ? `\n  ${x.url}` : ''}${x.snippet || x.description ? `\n  ${x.snippet ?? x.description}` : ''}`
      : `- ${render(x, d + 1).replace(/\n/g, '\n  ')}`)).join('\n');
    return Object.entries(v).slice(0, 25).map(([k, x]) => (x && typeof x === 'object' ? (d >= 2 ? `${k}: …` : `${k}:\n${render(x, d + 1).replace(/^/gm, '  ')}`) : `${k}: ${render(x, d)}`)).join('\n');
  };
  return render(data, depth);
}

const FILTERS = {
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  trim: (v) => v.trim(),
  first_line: (v) => v.split('\n')[0],
  lines: (v, n) => v.split('\n').slice(0, Math.max(1, Math.min(200, Number(n) || 1))).join('\n'),
  truncate: (v, n) => clip(v, Math.max(1, Math.min(20000, Number(n) || 200))),
  default: (v, d) => (v.trim() ? v : String(d ?? '')),
  bullets: (v) => v.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `- ${l.replace(/^[-*•]\s*/, '')}`).join('\n'),
  count_lines: (v) => String(v.split('\n').filter((l) => l.trim()).length),
  pretty: (v) => pretty(v),
};
export const FILTER_NAMES = Object.keys(FILTERS);
export const FILTER_DOCS = {
  pretty: 'turns a tool result (JSON) into readable lines', truncate: 'truncate:300 keeps the first 300 characters', default: 'default:"nothing new" when empty',
  bullets: 'one "- item" per line', first_line: 'only the first line', lines: 'lines:5 keeps the first 5 lines', upper: 'UPPER CASE', lower: 'lower case', trim: 'removes spaces around', count_lines: 'number of non-empty lines',
};

const TOKEN = /\{\{([^{}]{1,300})\}\}/g;
const NAME = /^[a-z0-9_.]+$/;
const parseArg = (s) => { const t = s.trim(); return /^".*"$/.test(t) ? t.slice(1, -1) : t; };

// value for ONE token body such as `result.news | pretty | truncate:300`
function evaluate(body, ctx) {
  const [path, ...filters] = body.split('|').map((p) => p.trim());
  if (!NAME.test(path)) return null;           // not ours: leave the text as it was
  let v = String(ctx[path] ?? '');
  for (const f of filters) {
    const i = f.indexOf(':');
    const name = (i < 0 ? f : f.slice(0, i)).trim();
    const arg = i < 0 ? undefined : parseArg(f.slice(i + 1));
    if (FILTERS[name]) v = FILTERS[name](v, arg);
  }
  return v;
}

export function render(text, ctx) {
  return String(text ?? '').replace(TOKEN, (m, body) => { const v = evaluate(body, ctx); return v === null ? m : v; });
}

// names used in a text, for the UI and for validation hints
export const placeholdersIn = (text) => [...String(text ?? '').matchAll(TOKEN)].map((m) => m[1].split('|')[0].trim()).filter((p) => NAME.test(p));

// ------------------------------------------------------------------------------------------------ email bodies
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_LINK = /^(https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i;

function inline(s) {
  // s is ALREADY html-escaped; only add tags we construct ourselves
  return s
    .replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (m, label, url) => { const u = url.replace(/&amp;/g, '&'); return SAFE_LINK.test(u) ? `<a href="${esc(u)}">${label}</a>` : m; })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${url}">${url}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
}

// Markdown-lite: paragraphs, "# heading", "- list", "**bold**", "_italic_", [text](https://...), bare links. Everything is escaped first.
export function markdownToHtml(text) {
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return '';
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul style="margin:0 0 14px;padding-left:20px">${lines.map((l) => `<li style="margin:0 0 6px">${inline(esc(l.replace(/^\s*[-*•]\s+/, '')))}</li>`).join('')}</ul>`;
    const h = /^(#{1,3})\s+(.*)$/.exec(lines[0]);
    if (h && lines.length === 1) return `<h${h[1].length + 1} style="margin:18px 0 8px;color:#101d35">${inline(esc(h[2]))}</h${h[1].length + 1}>`;
    return `<p style="margin:0 0 14px;line-height:1.55">${lines.map((l) => inline(esc(l))).join('<br>')}</p>`;
  }).join('\n');
}

export function emailDocument({ bodyText, footer }) {
  return `<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c2330">
<div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#101d35;color:#fff;padding:14px 20px;border-radius:12px 12px 0 0;font-weight:700;letter-spacing:.04em">AMB Board</div>
<div style="background:#fff;padding:22px 20px;border-radius:0 0 12px 12px;font-size:15px">${markdownToHtml(bodyText)}</div>
<p style="color:#8a93a3;font-size:12px;margin:14px 4px">${esc(footer)}</p></div></body></html>`;
}

// ready-made templates (copied into a workspace on request); they only use placeholders that exist for the flows they suit
export const BUILTIN_TEMPLATES = {
  daily_digest: { name: 'Daily digest', subject: 'Your daily digest, {{date}}', body: '# Good morning, {{owner.name | default:"there"}}\n\nHere is what I found for {{weekday}}, {{date}}:\n\n{{result.digest | pretty | default:"Nothing new today."}}\n\nHave a good day.' },
  news_summary: { name: 'News summary', subject: 'News summary: {{date}}', body: 'Summary:\n\n{{result.summary | default:"No summary was produced."}}\n\n**Sources**\n\n{{result.news | pretty | truncate:1500}}' },
  alert: { name: 'Alert', subject: 'Heads up: {{trigger.title | default:"something needs attention"}}', body: '# {{trigger.title | default:"Attention"}}\n\nProject: {{trigger.project | default:"none"}}\n\nOpen AMB Board to see it.' },
  weekly_review: { name: 'Weekly review', subject: 'Weekly review, week of {{date}}', body: '# Weekly review\n\n{{result.review | pretty | default:"No data."}}\n\nSent automatically by AMB Board on {{weekday}}.' },
};
