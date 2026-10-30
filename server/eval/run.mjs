// Golden-set evaluation of the assistant against the REAL model (not part of npm test; it costs money and needs a key).
//   cd server && DEEPSEEK_API_KEY=... node --experimental-sqlite eval/run.mjs [--group money] [--limit 10] [--out eval/last.json]
// Each utterance runs in its own conversation in a throw-away database with a small sample workspace. A case passes when the
// assistant's first move (a skill it called, or a change it proposed, valid or not) is one of the expected names. "direct"
// cases may also pass by answering without any action; "none" cases pass only when nothing was proposed or changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, signUp } from '../test/helpers.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./golden.json', import.meta.url)), 'utf8'))
  .filter((g) => !args.group || g.group === args.group).slice(0, Number(args.limit) || 1000);
if (!process.env.DEEPSEEK_API_KEY && !process.env.X_GROK_API_KEY) { console.error('Set DEEPSEEK_API_KEY (or X_GROK_API_KEY) to run the evaluation against a real model.'); process.exit(2); }

const srv = await startServer();
const u = await signUp(srv.base, 'Eval');
const proj = (await u.c.post('/api/projects', { name: 'Apartment Renovation' })).json;
await u.c.post('/api/projects', { name: 'Pets' });
const cols = (await u.c.get(`/api/projects/${proj.id}/columns`)).json;
for (const t of ['Order tiles', 'Old idea', 'Book movers']) await u.c.post(`/api/cards/columns/${cols[0].id}/cards`, { title: t, due_date: '2020-01-01' });
await u.c.post('/api/finance/transactions', { type: 'expense', amount_minor: 4500, currency: 'EUR', date: new Date().toISOString().slice(0, 10), description: 'Netflix' });

const results = [];
for (const g of golden) {
  let res;
  try { res = (await u.c.post('/api/ai/assistant/chat', { message: g.text })).json; } catch (e) { res = { error: String(e.message) }; }
  const m = res.message;
  const used = m ? [...new Set([...(m.tool_trace || []).map((t) => t.tool), ...(m.proposals || []).map((p) => p.type), ...(res.dropped || []).map((d) => d.type)])] : [];
  const acted = used.length > 0 || (m?.proposals?.length ?? 0) > 0;
  const expectNone = g.expect.includes('none');
  const ok = !m ? false : expectNone ? !acted : used.some((x) => g.expect.includes(x)) || (g.direct && !acted);
  results.push({ ...g, used, ok, answer: (m?.content || res.error || '').slice(0, 140), skill: res.skill ?? null });
  process.stdout.write(ok ? '.' : 'x');
}
console.log('\n');
const groups = [...new Set(results.map((r) => r.group))];
for (const grp of groups) { const rs = results.filter((r) => r.group === grp); console.log(`${grp.padEnd(10)} ${rs.filter((r) => r.ok).length}/${rs.length}  ${(100 * rs.filter((r) => r.ok).length / rs.length).toFixed(0)}%`); }
const pass = results.filter((r) => r.ok).length;
console.log(`\nIntent accuracy: ${pass}/${results.length} = ${(100 * pass / results.length).toFixed(1)}% (target above 85%)`);
for (const r of results.filter((x) => !x.ok)) console.log(`FAIL [${r.group}] "${r.text}"\n   expected ${r.expect.join(' | ')}; got ${r.used.join(', ') || 'a direct answer'}\n   ${r.answer}`);
if (args.out) writeFileSync(args.out === true ? 'eval/last.json' : args.out, JSON.stringify({ at: new Date().toISOString(), accuracy: pass / results.length, results }, null, 1));
srv.close();
