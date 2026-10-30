// Injected into the ONE tab the user shares. It can describe the page's fields, fill them, and ask the user to confirm a click.
// It never reads or writes password / payment / one-time-code fields and never submits anything on its own.
(() => {
  if (window.__amb) return;
  const SHADOW_MODE = 'closed';
  const SENSITIVE = /(passw|passcode|card.?(number|no)|cc.?(num|exp|csc)|cvv|cvc|iban|account.?number|routing|ssn|social.?security|otp|one.?time|2fa|secret|api.?key|token|\bpin\b)/i;
  const els = new Map();
  let counter = 0;
  const undo = [];

  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const textOf = (n) => (n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const clip = (s, n) => String(s ?? '').slice(0, n);

  function labelOf(el) {
    const aria = el.getAttribute('aria-label'); if (aria) return clip(aria, 100);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' ').trim(); if (t) return clip(t, 100); }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clip(textOf(l), 100); }
    const wrap = el.closest('label'); if (wrap) { const t = textOf(wrap); if (t) return clip(t, 100); }
    if (el.placeholder) return clip(el.placeholder, 100);
    if (el.title) return clip(el.title, 100);
    let prev = el.previousElementSibling; for (let i = 0; prev && i < 2; i += 1, prev = prev.previousElementSibling) { const t = textOf(prev); if (t && t.length < 100) return t; }
    return clip(el.name || el.id || '', 100);
  }
  function isSensitive(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (type === 'password' || ac.startsWith('cc-') || ac === 'one-time-code' || ac.includes('password')) return true;
    return SENSITIVE.test(`${el.name || ''} ${el.id || ''} ${ac} ${labelOf(el)}`);
  }
  function idOf(el) {
    if (!el.dataset.ambId) { counter += 1; el.dataset.ambId = `amb-${counter}`; }
    els.set(el.dataset.ambId, el);
    return el.dataset.ambId;
  }
  function* walk(root) {
    for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); }
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : el.isContentEditable && tag !== 'input' ? 'contenteditable' : (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
    const sensitive = (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) && isSensitive(el);
    const f = { id: idOf(el), tag, type, label: labelOf(el) };
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button' || type === 'submit' || type === 'button') { f.label = clip(textOf(el) || el.value || f.label, 100); if (tag === 'a') f.href_path = clip((() => { try { return new URL(el.href).pathname; } catch { return ''; } })(), 100); }
    if (sensitive) { f.sensitive = true; return f; }
    if (el.required || el.getAttribute('aria-required') === 'true') f.required = true;
    if (el.disabled) f.disabled = true;
    if (el.readOnly) f.readonly = true;
    if (tag === 'select') { f.options = [...el.options].slice(0, 40).map((o) => ({ value: o.value, label: clip(o.textContent.trim(), 60) })); f.value = el.value; }
    else if (type === 'checkbox' || type === 'radio') { f.checked = el.checked; f.value = clip(el.value, 60); if (type === 'radio' && el.name) f.group = el.name; }
    else if (tag === 'input' || tag === 'textarea') f.value = clip(el.value, 200);
    else if (type === 'contenteditable') f.value = clip(textOf(el), 200);
    return f;
  }

  function snapshot() {
    const fields = [];
    for (const el of walk(document)) {
      if (fields.length >= 80) break;
      const tag = el.tagName.toLowerCase();
      const isField = ['input', 'textarea', 'select'].includes(tag) || (el.isContentEditable && el.getAttribute('contenteditable') !== 'inherit' && el.hasAttribute('contenteditable'));
      const isAction = tag === 'button' || (tag === 'a' && el.hasAttribute('href')) || el.getAttribute('role') === 'button';
      if (!isField && !isAction) continue;
      if (tag === 'input' && ['hidden', 'file'].includes((el.getAttribute('type') || '').toLowerCase())) continue;
      if (!visible(el)) continue;
      fields.push(describe(el));
    }
    const text = clip((document.body?.innerText || '').replace(/\n{3,}/g, '\n\n'), 2500);
    return { origin: location.origin, url: location.origin + location.pathname, title: clip(document.title, 150), text, fields, truncated: fields.length >= 80 };
  }

  function setValue(el, value) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const prev = type === 'checkbox' || type === 'radio' ? el.checked : tag === 'select' ? el.value : (el.isContentEditable && tag !== 'input' && tag !== 'textarea') ? textOf(el) : el.value;
    const fire = (names) => names.forEach((n) => el.dispatchEvent(new Event(n, { bubbles: true })));
    el.focus?.();
    if (tag === 'select') {
      const want = String(value).toLowerCase();
      const opt = [...el.options].find((o) => o.value.toLowerCase() === want) || [...el.options].find((o) => o.textContent.trim().toLowerCase() === want);
      if (!opt) throw new Error(`no option "${clip(value, 40)}"`);
      el.value = opt.value; fire(['input', 'change']);
    } else if (type === 'checkbox') {
      const want = value === true || String(value).toLowerCase() === 'true';
      if (el.checked !== want) el.click();
    } else if (type === 'radio') {
      const group = el.name ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)] : [el];
      const target = group.find((r) => r.value.toLowerCase() === String(value).toLowerCase()) || (value === true ? el : null);
      if (!target) throw new Error(`no radio option "${clip(value, 40)}"`);
      if (!target.checked) target.click();
    } else if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));   // works with frameworks that track the value themselves
      fire(['input', 'change']);
    } else if (el.isContentEditable) { el.textContent = String(value); fire(['input']); }
    else throw new Error('not a field');
    el.blur?.();
    return { el, prev };
  }

  function mark(el) { const old = el.style.outline; el.style.outline = '2px solid #0b7a70'; el.style.outlineOffset = '1px'; setTimeout(() => { el.style.outline = old; }, 2500); }

  function fill(p) {
    if (p.origin && p.origin !== location.origin) throw new Error('the page changed to another site; nothing was filled');
    const results = []; const batch = [];
    for (const f of p.fields || []) {
      const el = els.get(String(f.id));
      try {
        if (!el || !el.isConnected) throw new Error('the field is no longer on the page');
        const tag = el.tagName.toLowerCase(); const type = (el.getAttribute('type') || '').toLowerCase();
        if (isSensitive(el) || type === 'password') throw new Error('password and payment fields are never filled');
        if (el.disabled || el.readOnly) throw new Error('the field cannot be edited');
        if (['file', 'hidden', 'submit', 'button', 'image', 'reset'].includes(type) || !(['input', 'textarea', 'select'].includes(tag) || el.isContentEditable)) throw new Error('not a fillable field');
        if (!visible(el)) throw new Error('the field is not visible');
        batch.push(setValue(el, f.value)); mark(el);
        results.push({ id: f.id, ok: true });
      } catch (e) { results.push({ id: f.id, ok: false, error: e.message }); }
    }
    if (batch.length) { undo.push(batch); showBanner(); }
    return { filled: results.filter((r) => r.ok).length, results, note: 'The user can review the highlighted fields and undo. Nothing was submitted.' };
  }

  function undoLast() {
    const batch = undo.pop(); if (!batch) return false;
    for (const { el, prev } of batch.reverse()) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      try { if (type === 'checkbox' || type === 'radio') { if (el.checked !== prev) el.click(); } else setValue(el, prev); } catch { /* the page changed; best effort */ }
    }
    return true;
  }

  // ---- UI owned by the extension (closed look, inside a shadow root so the page cannot restyle or script it) ----
  let host = null; let root = null;
  function ui() {
    if (host && host.isConnected) return root;
    host = document.createElement('div'); host.setAttribute('data-amb-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;';
    // 'closed': the page cannot reach into this UI and press Allow itself. (Test builds swap in 'open' to drive it.)
    root = host.attachShadow({ mode: SHADOW_MODE });
    root.innerHTML = `<style>
      .box{font:13px/1.4 system-ui,sans-serif;background:#101d35;color:#fff;border-radius:10px;padding:10px 12px;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:320px}
      .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap} button{font:inherit;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;background:#15baa9;color:#06231f;font-weight:600}
      button.sec{background:#2a3b5c;color:#fff} p{margin:0 0 8px} .dot{width:8px;height:8px;border-radius:50%;background:#15baa9;display:inline-block;margin-right:6px}
      .ask{border:2px solid #e0a526}</style><div class="box" id="b"></div>`;
    document.documentElement.appendChild(host);
    return root;
  }
  function showBanner() {
    const b = ui().getElementById('b'); b.className = 'box';
    b.innerHTML = `<p><span class="dot"></span>AMB Board assistant is working in this tab</p><div class="row"><button class="sec" id="u">Undo last fill</button><button class="sec" id="s">Stop sharing</button></div>`;
    b.querySelector('#u').onclick = (e) => { if (!e.isTrusted) return; undoLast(); if (!undo.length) b.querySelector('#u').disabled = true; };
    b.querySelector('#s').onclick = (e) => { if (!e.isTrusted) return; try { chrome.runtime.sendMessage({ type: 'stop' }); } catch { /* not in an extension */ } api.stop(); };
  }
  function confirmClick(el, label) {
    return new Promise((resolve) => {
      const b = ui().getElementById('b'); b.className = 'box ask';
      b.innerHTML = '<p></p><div class="row"><button id="y">Allow</button><button class="sec" id="n">Do not allow</button></div>';
      b.querySelector('p').textContent = `The AMB Board assistant wants to click "${label}" on ${location.hostname}.`;
      const done = (v) => { clearTimeout(t); showBanner(); resolve(v); };
      const t = setTimeout(() => done(false), 60_000);
      // only a real click by the person counts; a script on the page cannot synthesise one
      b.querySelector('#y').onclick = (e) => { if (e.isTrusted) done(true); }; b.querySelector('#n').onclick = (e) => { if (e.isTrusted) done(false); };
    });
  }

  async function click(p) {
    if (p.origin && p.origin !== location.origin) throw new Error('the page changed to another site; nothing was clicked');
    const el = els.get(String(p.id));
    if (!el || !el.isConnected) throw new Error('the element is no longer on the page');
    if (isSensitive(el)) throw new Error('that element is a sensitive field');
    const label = clip(textOf(el) || el.value || el.getAttribute('aria-label') || el.tagName.toLowerCase(), 80);
    el.scrollIntoView?.({ block: 'center' }); mark(el);
    if (!(await confirmClick(el, label))) return { clicked: false, reason: 'the user did not allow the click' };
    el.click();
    return { clicked: true, label };
  }

  const api = {
    async run(kind, payload) {
      if (kind === 'snapshot') return snapshot();
      if (kind === 'fill') return fill(payload);
      if (kind === 'click') return click(payload);
      throw new Error('unknown command');
    },
    stop() { host?.remove(); host = null; undo.length = 0; for (const el of els.values()) delete el.dataset.ambId; els.clear(); },
    _undo: undoLast,
  };
  Object.defineProperty(window, '__amb', { value: api, configurable: true });
})();
