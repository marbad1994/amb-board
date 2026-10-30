// Service worker: while the person has shared a tab, fetch the assistant's commands from AMB Board and run them in that tab.
let running = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (k) => chrome.storage.local.get(k);

async function api(method, path, body) {
  const { server, token } = await get(['server', 'token']);
  return fetch(`${server.replace(/\/$/, '')}/api/browser-ext${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}

async function unshare(reason) {
  const { sharedTab } = await get('sharedTab');
  await chrome.storage.local.set({ sharedTab: null, lastNote: reason || '' });
  try { await api('POST', '/hello', { shared: false }); } catch { /* offline */ }
  if (sharedTab) { try { await chrome.scripting.executeScript({ target: { tabId: sharedTab.tabId }, func: () => window.__amb?.stop() }); } catch { /* tab gone */ } }
  chrome.action.setBadgeText({ text: '' });
}

async function share(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url || '')) throw new Error('Only web pages (http or https) can be shared.');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });   // fails unless the person just invoked the extension on this tab
  const r = await api('POST', '/hello', { shared: true, url: tab.url, title: tab.title });
  if (!r.ok) throw new Error(r.status === 401 ? 'The pairing token was rejected. Create a new one in AMB Board.' : `AMB Board answered ${r.status}`);
  await chrome.storage.local.set({ sharedTab: { tabId, origin: new URL(tab.url).origin, title: tab.title }, lastNote: '' });
  chrome.action.setBadgeText({ text: 'ON' }); chrome.action.setBadgeBackgroundColor({ color: '#0b7a70' });
  loop();
}

async function handle(command, shared) {
  try {
    const tab = await chrome.tabs.get(shared.tabId);
    if (new URL(tab.url).origin !== shared.origin) throw new Error('The shared tab moved to another site.');
    await chrome.scripting.executeScript({ target: { tabId: shared.tabId }, files: ['content.js'] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: shared.tabId }, func: (kind, payload) => window.__amb.run(kind, payload), args: [command.kind, command.payload] });
    await api('POST', `/commands/${command.id}/result`, { ok: true, data: res?.result ?? {} });
  } catch (e) {
    await api('POST', `/commands/${command.id}/result`, { ok: false, error: String(e.message || e).slice(0, 250) }).catch(() => {});
  }
}

async function loop() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const { sharedTab } = await get('sharedTab');
      const { server, token } = await get(['server', 'token']);
      if (!sharedTab || !server || !token) break;
      let tab;
      try { tab = await chrome.tabs.get(sharedTab.tabId); } catch { await unshare('The shared tab was closed.'); break; }
      if (new URL(tab.url).origin !== sharedTab.origin) { await unshare('The shared tab moved to another site, so sharing stopped.'); break; }
      let res;
      try { res = await api('GET', '/poll?wait=15'); } catch { await sleep(4000); continue; }
      if (res.status === 401) { await unshare('AMB Board no longer accepts this pairing.'); break; }
      if (!res.ok) { await sleep(4000); continue; }
      const { command } = await res.json();
      if (command) await handle(command, sharedTab);
    }
  } finally { running = false; }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'share') { await share(msg.tabId); reply({ ok: true }); }
    else if (msg.type === 'stop') { await unshare('Stopped.'); reply({ ok: true }); }
  })().catch((e) => reply({ ok: false, error: String(e.message || e) }));
  return true;   // async reply
});
// a browser restart loses the temporary permission on the tab, so sharing never survives it
chrome.runtime.onStartup.addListener(() => { chrome.storage.local.set({ sharedTab: null }); chrome.action.setBadgeText({ text: '' }); });
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => loop());
