// UI audit: boots the real app on a temp database, seeds some data, visits every page in light and dark theme at desktop
// and phone width, and measures what can be measured: text contrast, tiny text, small touch targets, unnamed controls,
// unlabeled fields, raw identifiers in visible text, horizontal overflow, fonts. Prints a summary and writes JSON.
//   node e2e/audit.mjs [--out /path/audit.json] [--page /finance]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.AUDIT_PORT || '3478';
const base = `http://127.0.0.1:${PORT}`;
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };

if (arg('shots')) mkdirSync(arg('shots'), { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'amb-audit-'));
const server = spawn(process.execPath, ['--experimental-sqlite', join(root, 'server/src/index.js')], {
  env: { ...process.env, PORT, HOST: '127.0.0.1', AMB_DB_PATH: join(dir, 'a.sqlite'), AMB_UPLOADS_DIR: join(dir, 'up'), SMTP_USER: 'a@example.test', SMTP_PASS: 'x', X_GROK_API_KEY: '', DEEPSEEK_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', (c) => reject(new Error(`server exited ${c}`))); });

// Runs inside the page. Returns plain data.
function measure() {
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
  const over = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); const c = parse(cs.backgroundColor); if (c && c[3] > 0) layers.push(c); if (c && c[3] === 1) break; if (cs.backgroundImage !== 'none') return null; }
    let bg = [255, 255, 255, 1]; for (const l of layers.reverse()) bg = over(l, bg); return bg;
  };
  const sel = (el) => { const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join(''); return `${el.tagName.toLowerCase()}${cls}`; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const out = { contrast: [], tiny: [], targets: [], unnamed: [], unlabeled: [], raw: [], fonts: [], overflow: false, h1: document.querySelectorAll('h1').length };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim(); const el = n.parentElement;
    if (!text || !el || !visible(el) || el.closest('script,style,.sr-only,svg')) continue;
    const cs = getComputedStyle(el); const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const fg = parse(cs.color); const bg = bgOf(el);
    if (fg && bg) {
      const f = fg[3] < 1 ? over(fg, bg) : fg; const a = lum(f) + 0.05; const b = lum(bg) + 0.05; const ratio = Math.max(a, b) / Math.min(a, b);
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const key = `${sel(el)}|${cs.color}|${cs.backgroundColor}`;
      if (ratio < need && !seen.has(key) && !el.closest('[disabled],:disabled')) { seen.add(key); out.contrast.push({ el: sel(el), text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, need, size }); }
    }
    if (size > 0 && size < 12 && !seen.has(`t${sel(el)}${size}`)) { seen.add(`t${sel(el)}${size}`); out.tiny.push({ el: sel(el), text: text.slice(0, 30), size }); }
    if (/\b[a-z]{2,}_[a-z_]{2,}\b/.test(text) && !/\{\{|result\.|trigger\./.test(text) && !seen.has(`r${text}`)) { seen.add(`r${text}`); out.raw.push({ el: sel(el), text: text.slice(0, 60) }); }
    const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(); if (!out.fonts.includes(fam)) out.fonts.push(fam);
  }
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=option]')) {
    if (!visible(el) || el.closest('.sr-only')) continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const inline = el.tagName === 'A' && cs.display === 'inline';
    const box = el.type === 'checkbox' || el.type === 'radio' ? el.closest('label')?.getBoundingClientRect() || r : r;
    // 44 px on phones, 32 px with a mouse (WCAG 2.2 asks for at least 24)
    const min = window.innerWidth <= 900 ? 44 : 32;
    if (!inline && (box.height < min || box.width < min) && !(box.width >= min && el.tagName === 'INPUT' && el.type === 'search')) {
      const key = `${sel(el)}${Math.round(box.width)}x${Math.round(box.height)}`;
      if (!seen.has(key)) { seen.add(key); out.targets.push({ el: sel(el), parent: el.parentElement ? sel(el.parentElement) : '', text: (el.innerText || el.getAttribute('aria-label') || el.value || '').slice(0, 24), w: Math.round(box.width), h: Math.round(box.height) }); }
    }
    const name = (el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('aria-labelledby') || (el.tagName === 'INPUT' && el.value && ['button', 'submit'].includes(el.type) ? el.value : '');
    if (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName) && !name && !el.querySelector('img[alt]:not([alt=""])')) out.unnamed.push({ el: sel(el) });
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && !['checkbox', 'radio', 'file', 'button', 'submit'].includes(el.type) || (el.type === 'checkbox' || el.type === 'radio')) {
      const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.getAttribute('title');
      if (!labelled) out.unlabeled.push({ el: sel(el), placeholder: el.getAttribute('placeholder') || '' });
    }
  }
  out.overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
  out.overflowBy = out.overflow ? [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && visible(e)).slice(0, 6).map((e) => `${sel(e)} ${Math.round(e.getBoundingClientRect().right)}`) : [];
  return out;
}

const browser = await chromium.launch();
const report = {};
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const email = `audit${Date.now()}@example.com`;
  const api = async (method, path, body) => {
    const r = await page.request.fetch(`${base}/api${path}`, { method, data: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: base } });
    let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status(), json: j };
  };
  const reg = await api('POST', '/auth/register', { email, name: 'Audit User', password: 'correct-horse-battery' });
  const ws = reg.json.workspaces.find((w) => w.kind === 'personal').id;
  const seed = async (m, p, b) => { try { return await page.request.fetch(`${base}/api${p}`, { method: m, data: JSON.stringify(b), headers: { 'content-type': 'application/json', origin: base, 'x-workspace-id': ws } }).then((r) => r.json()); } catch { return null; } };
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const projs = [];
  for (const [name, status] of [['Apartment Renovation', 'in_progress'], ['Pets', 'todo'], ['New car', 'todo']]) projs.push(await seed('POST', '/projects', { name, description: `${name} plan`, status, priority: 'high', target_date: day(30) }));
  for (const p of projs) {
    if (!p?.id) continue;
    const cols = await seed('GET', `/projects/${p.id}/columns`);
    for (const [i, t] of ['Order tiles', 'Call the contractor', 'Book movers', 'Pick paint'].entries()) if (cols?.[i % 3]?.id) await seed('POST', `/cards/columns/${cols[i % 3].id}/cards`, { title: t, due_date: day(i - 1), priority: ['low', 'medium', 'high', 'urgent'][i] });
  }
  const cats = await seed('GET', '/finance/categories');
  for (const [i, d] of ['Groceries', 'Rent', 'Netflix', 'Fuel'].entries()) await seed('POST', '/finance/transactions', { type: 'expense', amount_minor: 2500 * (i + 1), currency: 'EUR', date: day(-i), description: d, categoryId: cats?.[i]?.id });
  await seed('POST', '/finance/transactions', { type: 'income', amount_minor: 320000, currency: 'EUR', date: day(-3), description: 'Salary' });
  await seed('POST', '/notes', { title: 'Plan', body: 'Ideas for the move', privacy: 'workspace' });
  await seed('POST', '/goals', { title: 'Run a half marathon', target_date: day(120) });
  await seed('POST', '/habits', { title: 'Read 20 minutes', frequency: 'daily' });
  await seed('POST', '/automations', { name: 'Weekly review', trigger: { type: 'schedule', frequency: 'weekly', weekday: 1, time: '08:00', timezone: 'UTC' }, steps: [{ type: 'notify', args: { title: 'Plan the week', body: '', link: '/tasks' } }] });

  await page.goto(base);          // registering through the API left the session cookie in this browser context
  await page.waitForSelector('.shell__top', { timeout: 15000 });

  const pages = arg('page') ? [arg('page')] : ['/', '/my-day', '/life-areas', '/projects', `/projects/${projs[0]?.id}`, '/tasks', '/goals', '/ideas', '/calendar', '/automations', '/finance', '/notes', '/documents', '/reports', '/assistant', '/settings'];
  for (const path of pages) {
    for (const theme of ['light', 'dark']) {
      for (const [label, size] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
        if (label === 'phone' && theme === 'dark') continue;
        await page.setViewportSize(size);
        await page.goto(`${base}${path}`); await page.waitForSelector('.shell__top, .shell', { timeout: 15000 });
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(500);
        const key = `${path} ${theme} ${label}`;
        report[key] = await page.evaluate(measure);
        if (arg('shots')) await page.screenshot({ path: join(arg('shots'), `${path.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'dashboard'}-${theme}-${label}.png`), fullPage: true });
      }
    }
  }
} finally { await browser.close(); server.kill(); }

const total = (k) => Object.values(report).reduce((a, r) => a + (Array.isArray(r[k]) ? r[k].length : r[k] ? 1 : 0), 0);
console.log('page'.padEnd(34), 'contrast tiny targets unnamed unlabeled raw overflow h1');
for (const [k, r] of Object.entries(report)) console.log(k.padEnd(34), String(r.contrast.length).padStart(8), String(r.tiny.length).padStart(4), String(r.targets.length).padStart(7), String(r.unnamed.length).padStart(7), String(r.unlabeled.length).padStart(9), String(r.raw.length).padStart(3), String(r.overflow ? 'YES' : '').padStart(8), String(r.h1).padStart(3));
console.log('\nTOTAL', ['contrast', 'tiny', 'targets', 'unnamed', 'unlabeled', 'raw', 'overflow'].map((k) => `${k}=${total(k)}`).join(' '));
if (arg('out')) writeFileSync(arg('out'), JSON.stringify(report, null, 1));
