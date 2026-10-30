const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; $('err').hidden = !m; };

async function render() {
  const { server, token, sharedTab, lastNote } = await chrome.storage.local.get(['server', 'token', 'sharedTab', 'lastNote']);
  $('setup').hidden = !!(server && token); $('main').hidden = !(server && token);
  if (server && token) {
    $('status').innerHTML = sharedTab ? `<span class="on">Sharing</span> ${new URL(sharedTab.origin).hostname}` : `Connected to ${new URL(server).hostname}. No tab is shared.`;
    $('share').hidden = !!sharedTab; $('stop').hidden = !sharedTab;
    if (lastNote && !sharedTab) err(lastNote);
  }
}

$('connect').onclick = async () => {
  err('');
  const server = $('server').value.trim().replace(/\/$/, ''); const token = $('token').value.trim();
  if (!/^https?:\/\//.test(server) || !token.startsWith('amb_br_')) return err('Enter the address of AMB Board and a pairing token that starts with amb_br_.');
  try {
    const r = await fetch(`${server}/api/browser-ext/hello`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ shared: false }) });
    if (!r.ok) return err(r.status === 401 ? 'AMB Board did not accept that token.' : `AMB Board answered ${r.status}.`);
  } catch { return err('Could not reach AMB Board at that address.'); }
  await chrome.storage.local.set({ server, token }); render();
};
$('share').onclick = async () => {
  err('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return err('No active tab.');
  const r = await chrome.runtime.sendMessage({ type: 'share', tabId: tab.id });
  if (!r?.ok) return err(r?.error || 'Could not share this tab.');
  render(); window.close();
};
$('stop').onclick = async () => { await chrome.runtime.sendMessage({ type: 'stop' }); render(); };
$('disconnect').onclick = async () => { await chrome.runtime.sendMessage({ type: 'stop' }); await chrome.storage.local.remove(['server', 'token', 'sharedTab']); render(); };
render();
