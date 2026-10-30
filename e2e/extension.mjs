// Browser-assistant E2E: (A) the extension's content script on a real form, (B) the whole chain with the real extension loaded in Chromium:
// assistant (scripted fake AI) -> AMB Board server -> extension service worker -> shared tab. Run: node e2e/extension.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.E2E_PORT || '3481';
const base = `http://127.0.0.1:${PORT}`;
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (err) { results.push(['FAIL', name, err.message.split('\n').slice(0, 5).join(' | ')]); throw err; } };

const FORM = `<!doctype html><html><head><title>Checkout</title></head><body><form id="f" onsubmit="return false"><h1>Delivery details</h1>
<label for="n">Full name</label><input id="n" name="name" required>
<label>Email <input id="e" type="email" name="email"></label>
<label for="pw">Password</label><input id="pw" type="password">
<label for="cc">Card number</label><input id="cc" name="cardnumber" autocomplete="cc-number">
<label for="c">Country</label><select id="c"><option value="">-</option><option value="RO">Romania</option><option value="SE">Sweden</option></select>
<label><input type="checkbox" id="nl"> Newsletter</label>
<fieldset><label><input type="radio" name="plan" value="basic"> Basic</label> <label><input type="radio" name="plan" value="pro"> Pro</label></fieldset>
<label for="m">Message</label><textarea id="m"></textarea>
<label for="ro">Order id</label><input id="ro" readonly value="X1">
<input type="hidden" id="h" value="secret"><button type="button" id="go">Place order</button></form><div id="out"></div>
<script>window.__log=[];document.querySelectorAll('input,textarea,select').forEach(el=>['input','change'].forEach(t=>el.addEventListener(t,()=>window.__log.push(el.id+':'+t))));
document.getElementById('go').onclick=()=>{document.getElementById('out').textContent='ORDERED';};</script></body></html>`;
const pageServer = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url.startsWith('/form') ? FORM : '<html><body>other</body></html>'); });
await new Promise((r) => pageServer.listen(0, '127.0.0.1', r));
const FORM_URL = `http://127.0.0.1:${pageServer.address().port}/form`;

// scripted fake AI: reads field ids out of the snapshot the assistant received, like a real model would
const aiLog = [];
let aiPlan = [];
const fakeAi = createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    const msgs = JSON.parse(b).messages; const user = msgs[1].content;
    let data = {}; try { data = JSON.parse(/<data>(.*)<\/data>/s.exec(user)[1]); } catch { /* not the assistant */ }
    const snap = (data.tool_results || []).find((t) => t.tool === 'browser_snapshot')?.result;
    const idOf = (label) => snap?.fields?.find((f) => f.label === label)?.id;
    const step = aiPlan.shift();
    aiLog.push(user.length);
    const out = typeof step === 'function' ? step({ idOf, data }) : { type: 'final', answer: 'ok', proposals: [] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }));
  });
});
await new Promise((r) => fakeAi.listen(0, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'amb-ext-'));
const server = spawn(process.execPath, ['--experimental-sqlite', join(root, 'server/src/index.js')], {
  env: { ...process.env, PORT, HOST: '127.0.0.1', AMB_DB_PATH: join(dir, 'e.sqlite'), AMB_UPLOADS_DIR: join(dir, 'up'), DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: `http://127.0.0.1:${fakeAi.address().port}`, X_GROK_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', (c) => reject(new Error(`server exited ${c}`))); });

// test build of the extension: content UI in an OPEN shadow root (so the test can press Allow) and host access to every site (a
// real install gets access to the shared tab through activeTab when the person clicks the extension, which a script cannot do)
const extDir = join(dir, 'ext'); mkdirSync(extDir);
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8')); manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));
const contentSrc = readFileSync(join(extDir, 'content.js'), 'utf8');
assert.ok(contentSrc.includes("const SHADOW_MODE = 'closed';"), 'production content script uses a closed shadow root');
writeFileSync(join(extDir, 'content.js'), contentSrc.replace("const SHADOW_MODE = 'closed';", "const SHADOW_MODE = 'open';"));

// a signed-in AMB user and a pairing token, over the HTTP API
let cookie = '';
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, json: j };
};
await call('POST', '/api/auth/register', { email: `ext${Date.now()}@example.com`, name: 'Ext Tester', password: 'correct-horse-battery' });
const pairing = (await call('POST', '/api/browser/pairings', { name: 'e2e' })).json;

const browser = await chromium.launch();
let ctxB; let failed = false;
try {
  // ---------------------------------------------------------------- A: the content script
  const page = await (await browser.newContext()).newPage();
  await page.goto(FORM_URL);
  await page.addScriptTag({ content: readFileSync(join(extDir, 'content.js'), 'utf8') });
  const run = (kind, payload) => page.evaluate(([k, p]) => window.__amb.run(k, p), [kind, payload]);
  let snap;

  await step('snapshot lists labelled fields, hides passwords and card numbers, skips hidden inputs', async () => {
    snap = await run('snapshot');
    const by = (l) => snap.fields.find((f) => f.label === l);
    assert.equal(snap.origin, new URL(FORM_URL).origin); assert.ok(!snap.url.includes('?')); assert.equal(snap.title, 'Checkout');
    assert.ok(by('Full name').required && by('Email').type === 'email' && by('Country').options.some((o) => o.label === 'Romania'));
    for (const l of ['Password', 'Card number']) { assert.equal(by(l).sensitive, true); assert.ok(!('value' in by(l))); }
    assert.equal(by('Order id').readonly, true);
    assert.ok(!snap.fields.some((f) => f.type === 'hidden'));
    assert.equal(by('Place order').tag, 'button');
    assert.ok(snap.text.includes('Delivery details'));
  });

  const id = (l) => snap.fields.find((f) => f.label === l).id;
  await step('fill sets values the way a user would (events fire), refuses sensitive and read-only fields, and can be undone', async () => {
    const origin = snap.origin;
    const r = await run('fill', { origin, fields: [{ id: id('Full name'), value: 'Marcus Bader' }, { id: id('Email'), value: 'm@example.com' }, { id: id('Country'), value: 'Romania' },
      { id: id('Message'), value: 'Please call first' }, { id: snap.fields.find((f) => f.type === 'checkbox').id, value: true }, { id: snap.fields.find((f) => f.type === 'radio' && f.value === 'pro').id, value: 'pro' },
      { id: id('Password'), value: 'hunter2' }, { id: id('Card number'), value: '4111111111111111' }, { id: id('Order id'), value: 'X2' }] });
    assert.equal(r.filled, 6);
    assert.deepEqual(r.results.filter((x) => !x.ok).map((x) => x.id), [id('Password'), id('Card number'), id('Order id')]);
    const v = await page.evaluate(() => ({ n: n.value, e: e.value, c: c.value, m: m.value, nl: nl.checked, plan: document.querySelector('input[name=plan]:checked')?.value, pw: pw.value, cc: cc.value, ro: ro.value, log: window.__log }));
    assert.deepEqual({ ...v, log: undefined }, { n: 'Marcus Bader', e: 'm@example.com', c: 'RO', m: 'Please call first', nl: true, plan: 'pro', pw: '', cc: '', ro: 'X1', log: undefined });
    assert.ok(v.log.includes('n:input') && v.log.includes('n:change') && v.log.includes('c:change'), 'input and change events were dispatched');
    await assert.rejects(run('fill', { origin: 'https://evil.example', fields: [{ id: id('Full name'), value: 'x' }] }), /another site/);
    await page.evaluate(() => window.__amb._undo());
    assert.equal(await page.evaluate(() => n.value + '|' + c.value + '|' + nl.checked), '||false');
  });

  await step('click needs a real click by the person on the Allow button; a script on the page cannot press it', async () => {
    const go = id('Place order');
    let settled = false;
    const p1 = run('click', { origin: snap.origin, id: go }).then((r) => { settled = true; return r; });
    await page.locator('[data-amb-ui]').getByText('Allow', { exact: true }).waitFor();
    await page.evaluate(() => document.querySelector('[data-amb-ui]').shadowRoot.querySelector('#y').click());   // untrusted: ignored
    await page.waitForTimeout(400);
    assert.equal(settled, false); assert.equal(await page.locator('#out').textContent(), '');
    await page.locator('[data-amb-ui]').getByText('Do not allow', { exact: true }).click();
    assert.deepEqual(await p1, { clicked: false, reason: 'the user did not allow the click' });
    assert.equal(await page.locator('#out').textContent(), '');
    const p2 = run('click', { origin: snap.origin, id: go });
    await page.locator('[data-amb-ui]').getByText('Allow', { exact: true }).click();
    assert.equal((await p2).clicked, true); assert.equal(await page.locator('#out').textContent(), 'ORDERED');
    await assert.rejects(run('click', { origin: snap.origin, id: id('Password') }), /sensitive/);
  });

  // ---------------------------------------------------------------- B: the real extension, the real server, the scripted assistant
  try {
    ctxB = await chromium.launchPersistentContext(join(dir, 'profile'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`] });
  } catch (e) { ctxB = null; results.push(['SKIP', 'real extension in Chromium', `could not start Chromium with the extension: ${String(e.message).split('\n')[0]}`]); }
  if (ctxB) {
    let sw = ctxB.serviceWorkers()[0] || await ctxB.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    await sw.evaluate(([server, token]) => chrome.storage.local.set({ server, token }), [base, pairing.token]);
    const formPage = await ctxB.newPage(); await formPage.goto(FORM_URL); await formPage.bringToFront();

    await step('the person shares the tab; AMB Board shows the site, and sharing is limited to that tab', async () => {
      const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0].id, FORM_URL);
      const ui = await ctxB.newPage(); await ui.goto(`chrome-extension://${extId}/popup.html`);
      const r = await ui.evaluate((t) => chrome.runtime.sendMessage({ type: 'share', tabId: t }), tabId);
      assert.equal(r.ok, true, JSON.stringify(r)); await ui.close();
      const list = (await call('GET', '/api/browser/pairings')).json;
      assert.equal(list[0].shared_origin, new URL(FORM_URL).origin); assert.equal(list[0].online, true);
    });

    const chat = (message) => call('POST', '/api/ai/assistant/chat', { message });
    await step('"fill my delivery details": the assistant looks at the page, then fills the right fields and skips the password', async () => {
      aiPlan = [
        () => ({ type: 'tool', calls: [{ tool: 'browser_snapshot', args: {} }] }),
        ({ idOf }) => ({ type: 'tool', calls: [{ tool: 'browser_fill', args: { fields: [{ id: idOf('Full name'), value: 'Marcus Bader' }, { id: idOf('Email'), value: 'm@example.com' }, { id: idOf('Country'), value: 'Romania' }, { id: idOf('Password'), value: 'nope' }] } }] }),
        ({ data }) => ({ type: 'final', answer: `Filled ${JSON.stringify(data.tool_results.at(-1).result).includes('"filled"') ? 'the fields' : 'nothing'}.`, proposals: [] }),
      ];
      const r = await chat('fill in my delivery details on this page');
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const v = await formPage.evaluate(() => ({ n: n.value, e: e.value, c: c.value, pw: pw.value }));
      assert.deepEqual(v, { n: 'Marcus Bader', e: 'm@example.com', c: 'RO', pw: '' });
      const trace = (await call('GET', `/api/ai/assistant/conversations/${r.json.conversationId}`)).json.messages.at(-1).tool_trace.map((t) => t.tool);
      assert.deepEqual(trace, ['browser_snapshot', 'browser_fill']);
    });

    await step('"place the order": nothing is clicked until the person presses Allow on the page', async () => {
      aiPlan = [
        () => ({ type: 'tool', calls: [{ tool: 'browser_snapshot', args: {} }] }),
        ({ idOf }) => ({ type: 'tool', calls: [{ tool: 'browser_click', args: { id: idOf('Place order') } }] }),
        () => ({ type: 'final', answer: 'Asked.', proposals: [] }),
      ];
      const pending = chat('place the order');
      await formPage.locator('[data-amb-ui]').getByText('Allow', { exact: true }).waitFor({ timeout: 20000 });
      assert.equal(await formPage.locator('#out').textContent(), '', 'not clicked before the person agrees');
      await formPage.locator('[data-amb-ui]').getByText('Allow', { exact: true }).click();
      assert.equal((await pending).status, 200);
      assert.equal(await formPage.locator('#out').textContent(), 'ORDERED');
    });

    await step('stopping sharing ends it: the assistant is told no tab is shared', async () => {
      const ui = await ctxB.newPage(); await ui.goto(`chrome-extension://${extId}/popup.html`);
      await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' })); await ui.close();
      assert.equal((await call('GET', '/api/browser/pairings')).json[0].shared_origin, null);
      aiPlan = [() => ({ type: 'tool', calls: [{ tool: 'browser_snapshot', args: {} }] }), ({ data }) => ({ type: 'final', answer: JSON.stringify(data.tool_results[0].result), proposals: [] })];
      const r = await chat('look at my page');
      assert.match(r.json.message.content, /no tab is shared right now/);
      assert.equal(await formPage.locator('[data-amb-ui]').count(), 0, 'the on-page banner is gone');
    });
  }
} catch { failed = true; } finally {
  await ctxB?.close().catch(() => {});
  await browser.close(); server.kill(); fakeAi.close(); pageServer.close(); rmSync(dir, { recursive: true, force: true });
  for (const r of results) console.log(r.join('  '));
  console.log(failed ? 'EXTENSION E2E FAILED' : `EXTENSION E2E OK (${results.filter((r) => r[0] === 'PASS').length} steps${results.some((r) => r[0] === 'SKIP') ? ', real-extension part SKIPPED' : ''})`);
  process.exit(failed ? 1 : 0);
}
