import { useCallback, useEffect, useRef, useState } from 'react';
import * as openpgp from 'openpgp';
import {
  Mail, Inbox, Send, Trash2, Archive, RefreshCw, Plus, ArrowLeft, Reply, Forward,
  Star, Lock, KeyRound, LogOut, X, Paperclip, ShieldCheck, AlertTriangle, FileText, Unlock,
} from 'lucide-react';
import { api } from '../api/client.js';

const FOLDER_ICONS = { Inbox: Inbox, Sent: Send, Drafts: FileText, Trash: Trash2, Junk: AlertTriangle, Archive: Archive, Flagged: Star };
const specialKey = (su) => String(su || '').replace(/^\\+/, '');
const folderIcon = (specialUse) => FOLDER_ICONS[specialKey(specialUse)] || Mail;

const fmtTime = (iso) => { if (!iso) return ''; const d = new Date(iso); const sameDay = d.toDateString() === new Date().toDateString(); return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(); };
const fmtFull = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const addr = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
const addrs = (list) => (list || []).map(addr).filter(Boolean).join(', ');
const clean = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => x.trim()).filter(Boolean);
const isPgp = (t) => /-----BEGIN PGP MESSAGE-----/.test(t || '');

// ---- OpenPGP helpers ----
let privCache = null;
async function generateKeypair({ name, email, passphrase }) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ name: name || '', email }], passphrase, format: 'armored' });
  const fingerprint = (await openpgp.readKey({ armoredKey: publicKey })).getFingerprint().toUpperCase();
  return { public_armored: publicKey, private_armored: privateKey, fingerprint };
}
async function unlockPrivate(armored, passphrase) {
  const priv = await openpgp.readPrivateKey({ armoredKey: armored });
  return openpgp.decryptKey({ privateKey: priv, passphrase });
}
async function ensurePrivate(keys) {
  if (privCache) return privCache;
  const passphrase = window.prompt('Enter your key passphrase to unlock signing and decryption:');
  if (!passphrase) throw new Error('A passphrase is needed to use your key.');
  privCache = await unlockPrivate(keys.private_armored, passphrase);
  return privCache;
}
async function encryptText({ text, armoredKeys, ownPrivate }) {
  const encryptionKeys = await Promise.all(armoredKeys.map((a) => openpgp.readKey({ armoredKey: a })));
  const message = await openpgp.createMessage({ text });
  const opts = { message, encryptionKeys, format: 'armored' };
  if (ownPrivate) opts.signingKeys = ownPrivate;
  return openpgp.encrypt(opts);
}
async function decryptText(armored, ownPrivate) {
  const message = await openpgp.readMessage({ armoredMessage: armored });
  const { data } = await openpgp.decrypt({ message, decryptionKeys: ownPrivate, format: 'utf8' });
  return data;
}

function downloadAttachment(a) {
  const bytes = Uint8Array.from(atob(a.contentBase64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: a.contentType }));
  const el = document.createElement('a'); el.href = url; el.download = a.filename; el.click(); URL.revokeObjectURL(url);
}

// ---- connect form ----
function ConnectForm({ host, onConnected }) {
  const [address, setAddress] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const submit = async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await api.webmailConnect(address, password); onConnected(); } catch (x) { setErr(x.message); } finally { setBusy(false); } };
  return (
    <section className="panel wm-connect">
      <div className="panel__title"><h2><Mail size={16} aria-hidden="true" /> Connect your mailbox</h2></div>
      <p className="muted">Read and send from your own mailbox on {host || 'this server'}. Your password is stored encrypted and used only to reach your mail.</p>
      <form className="flow-row" onSubmit={submit} aria-label="Connect mailbox">
        <label className="field"><span className="field__label">Mailbox address</span><input type="email" required autoComplete="username" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="anna@example.com" /></label>
        <label className="field"><span className="field__label">Password</span><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <div style={{ alignSelf: 'end' }}><button type="submit" className="btn btn-primary" disabled={busy}><Lock size={14} aria-hidden="true" /> {busy ? 'Connecting…' : 'Connect'}</button></div>
      </form>
      {err && <p className="form-error" role="alert">{err}</p>}
      <p className="hint">Mailboxes are created by an owner or admin under Workspace &amp; account → Email, who also hands you the password.</p>
    </section>
  );
}

// ---- compose / reply / forward ----
function ComposeModal({ mode, base, keys, onClose, onSent }) {
  const [form, setForm] = useState({
    to: base?.to || '', cc: '', bcc: '', subject: base?.subject || '', body: base?.body || '',
    inReplyTo: base?.inReplyTo || '', references: base?.references || [],
  });
  const [attachments, setAttachments] = useState([]);
  const [encrypt, setEncrypt] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const fileRef = useRef(null);

  const addFiles = async (files) => {
    const next = [...attachments];
    for (const f of files) {
      if (next.length >= 10) break;
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      next.push({ filename: f.name, contentType: f.type || 'application/octet-stream', contentBase64: btoa(bin) });
    }
    setAttachments(next);
  };

  const send = async () => {
    setErr(''); setBusy(true);
    try {
      const to = clean(form.to);
      if (!to.length) throw new Error('Give at least one recipient.');
      let text = form.body;
      if (encrypt) {
        const dir = await api.webmailKeyDirectory(to);
        const missing = to.filter((a) => !dir[a.toLowerCase()]);
        if (missing.length) throw new Error(`No public key for ${missing.join(', ')}. Ask them to publish one in Mail → Encryption, or turn encryption off.`);
        let priv = null;
        if (keys?.has_key) priv = await ensurePrivate(keys);
        text = await encryptText({ text: form.body, armoredKeys: to.map((a) => dir[a.toLowerCase()].public_armored), ownPrivate: priv });
      }
      await api.webmailSend({ to, cc: clean(form.cc), bcc: clean(form.bcc), subject: form.subject, text, inReplyTo: form.inReplyTo, references: form.references, attachments });
      onSent();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <div className="ab-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ab-dialog wm-compose" role="dialog" aria-modal="true" aria-label="Compose message">
        <div className="ab-dialog__head"><div><h2>{mode === 'reply' ? 'Reply' : mode === 'forward' ? 'Forward' : 'New message'}</h2></div><button type="button" className="ab-x" aria-label="Close" onClick={onClose}><X size={18} /></button></div>
        <div className="wm-compose__fields">
          <label className="wm-row"><span>To</span><input type="text" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="anna@example.com" /></label>
          <label className="wm-row"><span>Cc</span><input type="text" value={form.cc} onChange={(e) => setForm({ ...form, cc: e.target.value })} /></label>
          <label className="wm-row"><span>Bcc</span><input type="text" value={form.bcc} onChange={(e) => setForm({ ...form, bcc: e.target.value })} /></label>
          <label className="wm-row"><span>Subject</span><input type="text" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></label>
        </div>
        <textarea className="wm-compose__body" rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Write your message…" />
        {attachments.length > 0 && (
          <ul className="plain-list wm-attach">{attachments.map((a, i) => (
            <li key={i}><Paperclip size={14} aria-hidden="true" /> {a.filename}<button type="button" className="btn btn-icon btn-ghost" aria-label={`Remove ${a.filename}`} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}><X size={14} /></button></li>
          ))}</ul>
        )}
        <div className="wm-compose__bar">
          <button type="button" className="btn btn-small" onClick={() => fileRef.current?.click()}><Paperclip size={14} aria-hidden="true" /> Attach</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
          <label className="check"><input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} /> Encrypt &amp; sign</label>
          <div className="wm-compose__spacer" />
          <button type="button" className="btn btn-primary" onClick={send} disabled={busy}><Send size={14} aria-hidden="true" /> {busy ? 'Sending…' : 'Send'}</button>
        </div>
        {encrypt && <p className="hint"><ShieldCheck size={14} aria-hidden="true" /> The message text is encrypted end-to-end to the recipients. The subject line and any attachments are not encrypted.</p>}
        {err && <p className="form-error" role="alert">{err}</p>}
      </div>
    </div>
  );
}

// ---- encryption / key settings ----
function KeysModal({ session, onClose, onSaved }) {
  const [info, setInfo] = useState(null);
  const [gen, setGen] = useState({ name: '', email: session?.address || '', passphrase: '' });
  const [imp, setImp] = useState({ armored: '', passphrase: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  useEffect(() => { api.webmailKeys().then(setInfo).catch(() => setInfo({ has_key: false, addresses: [] })); }, []);

  const generate = async () => {
    setBusy(true); setErr('');
    try {
      if (gen.passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      const key = await generateKeypair(gen);
      await api.webmailSaveKeys(key);
      setMsg(`Key generated and published for ${session.address}. Fingerprint ${key.fingerprint.slice(0, 16)}…`);
      api.webmailKeys().then(setInfo); onSaved();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const importKey = async () => {
    setBusy(true); setErr('');
    try {
      const priv = await openpgp.readPrivateKey({ armoredKey: imp.armored });
      await openpgp.decryptKey({ privateKey: priv, passphrase: imp.passphrase });
      const public_armored = priv.toPublic().armor();
      const fingerprint = priv.toPublic().getFingerprint().toUpperCase();
      await api.webmailSaveKeys({ public_armored, private_armored: imp.armored, fingerprint });
      setMsg('Key imported and published.');
      api.webmailKeys().then(setInfo); onSaved();
    } catch (x) { setErr('Could not read that key: ' + x.message); } finally { setBusy(false); }
  };
  const remove = async () => { if (!window.confirm('Remove your key? Messages encrypted to you can no longer be decrypted from this app.')) return; try { await api.webmailDeleteKeys(); api.webmailKeys().then(setInfo); onSaved(); } catch (x) { setErr(x.message); } };

  return (
    <div className="ab-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ab-dialog wm-keys" role="dialog" aria-modal="true" aria-label="Encryption">
        <div className="ab-dialog__head"><div><h2><KeyRound size={16} aria-hidden="true" /> Encryption (OpenPGP)</h2></div><button type="button" className="ab-x" aria-label="Close" onClick={onClose}><X size={18} /></button></div>
        <p className="hint">A key lets you read messages encrypted to you and send end-to-end encrypted mail. Your private key is protected by a passphrase and stored encrypted; only the passphrase unlocks it.</p>
        {info?.has_key ? (
          <div className="wm-keys__have">
            <p><b>Key ready.</b> Fingerprint <code>{info.fingerprint}</code></p>
            <p className="muted">Published for {info.addresses.length ? info.addresses.join(', ') : 'no mailbox yet'}. Your public key is shared in this workspace so others can encrypt to you.</p>
            <button type="button" className="btn btn-danger" onClick={remove}>Remove key</button>
          </div>
        ) : (
          <>
            <div className="wm-keys__gen">
              <h3 className="sub-h">Generate a new key</h3>
              <div className="flow-row">
                <label className="field"><span className="field__label">Name</span><input value={gen.name} onChange={(e) => setGen({ ...gen, name: e.target.value })} placeholder="Your name" /></label>
                <label className="field"><span className="field__label">Email</span><input value={gen.email} onChange={(e) => setGen({ ...gen, email: e.target.value })} placeholder="anna@example.com" /></label>
                <label className="field"><span className="field__label">Passphrase</span><input type="password" autoComplete="new-password" value={gen.passphrase} onChange={(e) => setGen({ ...gen, passphrase: e.target.value })} /></label>
                <div style={{ alignSelf: 'end' }}><button type="button" className="btn btn-primary" onClick={generate} disabled={busy}><KeyRound size={14} aria-hidden="true" /> Generate key</button></div>
              </div>
            </div>
            <div className="wm-keys__imp">
              <h3 className="sub-h">Or import an existing private key</h3>
              <label className="field"><span className="field__label">Armored private key</span><textarea rows={5} value={imp.armored} onChange={(e) => setImp({ ...imp, armored: e.target.value })} placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----" /></label>
              <label className="field"><span className="field__label">Its passphrase</span><input type="password" value={imp.passphrase} onChange={(e) => setImp({ ...imp, passphrase: e.target.value })} /></label>
              <button type="button" className="btn" onClick={importKey} disabled={busy || !imp.armored.trim()}>Import</button>
            </div>
          </>
        )}
        {msg && <p className="form-ok" role="status">{msg}</p>}
        {err && <p className="form-error" role="alert">{err}</p>}
      </div>
    </div>
  );
}

// ---- reading pane ----
function ReadPane({ msg, keys, onBack, onReply, onForward, onDelete, onToggleFlag }) {
  const [plain, setPlain] = useState(null); const [pgpErr, setPgpErr] = useState(''); const [busy, setBusy] = useState(false);
  const decrypt = async () => { setBusy(true); setPgpErr(''); try { const priv = await ensurePrivate(keys); const t = await decryptText(msg.text, priv); setPlain(t); } catch (x) { setPgpErr(x.message); } finally { setBusy(false); } };
  const body = plain ?? msg.text;
  const encrypted = isPgp(msg.text) && plain === null;
  return (
    <div className="wm-read">
      <div className="wm-read__bar">
        <button type="button" className="btn btn-icon btn-ghost wm-back" onClick={onBack} aria-label="Back to list"><ArrowLeft size={18} /></button>
        <button type="button" className="btn btn-icon btn-ghost" onClick={onReply} aria-label="Reply"><Reply size={16} /></button>
        <button type="button" className="btn btn-icon btn-ghost" onClick={onForward} aria-label="Forward"><Forward size={16} /></button>
        <button type="button" className={`btn btn-icon btn-ghost${msg.flagged ? ' is-on' : ''}`} onClick={onToggleFlag} aria-label="Flag"><Star size={16} /></button>
        <button type="button" className="btn btn-icon btn-ghost" onClick={onDelete} aria-label="Delete"><Trash2 size={16} color="var(--color-danger)" /></button>
      </div>
      <div className="wm-read__head">
        <h2>{msg.subject}</h2>
        <div className="wm-read__meta"><b>{addrs(msg.from) || '(no sender)'}</b> <span className="muted">to {addrs(msg.to) || 'me'}{msg.cc?.length ? `, cc ${addrs(msg.cc)}` : ''}</span><span className="muted wm-read__date">{fmtFull(msg.date)}</span></div>
      </div>
      {encrypted ? (
        <div className="wm-pgp">
          <p><Lock size={16} aria-hidden="true" /> This message is encrypted. Enter your key passphrase to read it.</p>
          <button type="button" className="btn btn-primary" onClick={decrypt} disabled={busy || !keys?.has_key}><Unlock size={14} aria-hidden="true" /> {busy ? 'Decrypting…' : 'Decrypt'}</button>
          {!keys?.has_key && <p className="hint">Set up a key under Encryption to decrypt it.</p>}
          {pgpErr && <p className="form-error" role="alert">{pgpErr}</p>}
        </div>
      ) : (
        <pre className="wm-read__body" tabIndex={0}>{body || '(no message body)'}</pre>
      )}
      {msg.attachments?.length > 0 && (
        <ul className="plain-list wm-attach" aria-label="Attachments">
          {msg.attachments.map((a, i) => <li key={i}><Paperclip size={14} aria-hidden="true" /> <span>{a.filename} <small className="muted">({Math.max(1, Math.round(a.size / 1024))} KB)</small></span><button type="button" className="btn btn-small" onClick={() => downloadAttachment(a)}>Download</button></li>)}
        </ul>
      )}
    </div>
  );
}

// ---- main page ----
export default function MailPage() {
  const [session, setSession] = useState(undefined);   // undefined = loading, null = not connected, {address} = connected
  const [host, setHost] = useState('');
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState(null);
  const [list, setList] = useState(null);
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState(null);
  const [compose, setCompose] = useState(null);
  const [keys, setKeys] = useState(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadSession = useCallback(() => {
    api.webmailSession().then((r) => { setHost(r.host || ''); setSession(r.session ? { address: r.session.address } : null); })
      .catch((e) => { setError(e.message); setSession(null); });
  }, []);
  useEffect(() => { loadSession(); }, [loadSession]);

  const loadFolders = useCallback(() => api.webmailFolders().then(setFolders).catch((e) => setError(e.message)), []);
  useEffect(() => { if (!session) return; loadFolders(); api.webmailKeys().then(setKeys).catch(() => setKeys(null)); }, [session, loadFolders]);

  const loadMessages = useCallback((f, p = 1) => {
    setBusy(true);
    api.webmailMessages(f, p, 30).then((r) => { setList(r); setPage(p); }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, []);

  const selectFolder = (f) => { setFolder(f); setMsg(null); loadMessages(f, 1); };
  const openMessage = (m) => { setMsg(null); api.webmailMessage(m.folder, m.uid).then(setMsg).catch((e) => setError(e.message)); };
  const refresh = () => { if (folder) loadMessages(folder, page); loadFolders(); };

  const reply = (m) => {
    const to = m.from.map((a) => a.address).filter(Boolean).join(', ');
    const subject = (m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`);
    const quote = `\n\nOn ${fmtFull(m.date)}, ${addrs(m.from)} wrote:\n` + String(m.text || '').split('\n').map((l) => `> ${l}`).join('\n');
    setCompose({ mode: 'reply', base: { to, subject, body: quote, inReplyTo: m.messageId, references: [...(m.references || []), m.messageId].filter(Boolean) } });
  };
  const forward = (m) => {
    const subject = (m.subject.startsWith('Fwd:') ? m.subject : `Fwd: ${m.subject}`);
    const quote = `\n\n---------- Forwarded message ----------\nFrom: ${addrs(m.from)}\nDate: ${fmtFull(m.date)}\nSubject: ${m.subject}\n\n` + (m.text || '');
    setCompose({ mode: 'forward', base: { subject, body: quote } });
  };

  const trashFolder = folders.find((f) => specialKey(f.specialUse) === 'Trash')?.name || 'Trash';
  const doDelete = async () => { try { await api.webmailDelete(msg.folder, msg.uid); setMsg(null); refresh(); } catch (e) { setError(e.message); } };
  const doFlag = async () => { try { await api.webmailSetFlags(msg.folder, msg.uid, { flagged: !msg.flagged }); setMsg({ ...msg, flagged: !msg.flagged }); refresh(); } catch (e) { setError(e.message); } };

  const disconnect = async () => { if (!window.confirm('Disconnect this mailbox? Your stored password is removed from the server.')) return; try { await api.webmailDisconnect(); setSession(null); setFolders([]); setFolder(null); setList(null); setMsg(null); } catch (e) { setError(e.message); } };

  if (session === undefined) return <div className="page page--wide"><p className="muted">Loading…</p></div>;
  if (session === null) {
    return (
      <div className="page page--wide">
        <div className="page-header"><div><div className="eyebrow">COMMUNICATE</div><h1>Mail</h1><p className="page-sub">Your mailbox, in the app.</p></div></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <ConnectForm host={host} onConnected={loadSession} />
      </div>
    );
  }

  const reading = msg !== null;
  return (
    <div className="page page--wm">
      <div className="wm-head">
        <div className="wm-head__title"><Mail size={20} aria-hidden="true" /><h1>Mail</h1><span className="role-tag">{session.address}</span></div>
        <div className="wm-head__actions">
          <button type="button" className="btn btn-icon btn-ghost" onClick={refresh} aria-label="Refresh"><RefreshCw size={18} className={busy ? 'spin' : ''} /></button>
          <button type="button" className="btn btn-icon btn-ghost" onClick={() => setKeysOpen(true)} aria-label="Encryption" title="Encryption"><KeyRound size={18} /></button>
          <button type="button" className="btn btn-icon btn-ghost" onClick={disconnect} aria-label="Disconnect mailbox" title="Disconnect"><LogOut size={18} /></button>
          <button type="button" className="btn btn-primary" onClick={() => setCompose({ mode: 'new', base: {} })}><Plus size={16} aria-hidden="true" /> Compose</button>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className={`wm${reading ? ' wm--reading' : folder ? ' wm--list' : ''}`}>
        <aside className="wm-folders" aria-label="Folders">
          <ul className="wm-folders__list">
            {folders.map((f) => {
              const Icon = folderIcon(f.specialUse);
              return (
                <li key={f.name}>
                  <button type="button" className={`wm-folder${folder === f.name ? ' active' : ''}`} onClick={() => selectFolder(f.name)}>
                    <Icon size={16} aria-hidden="true" /><span>{f.name}</span>{f.unseen ? <em className="wm-folder__count">{f.unseen}</em> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="wm-list" aria-label="Messages">
          <div className="wm-list__head">
            <button type="button" className="btn btn-icon btn-ghost wm-back" onClick={() => { setFolder(null); setList(null); setMsg(null); }} aria-label="Back to folders"><ArrowLeft size={18} /></button>
            <b>{folder || ''}</b>
          </div>
          {!folder ? <div className="empty-state">Pick a folder.</div> : list && list.messages.length === 0 ? <div className="empty-state">No messages.</div> : (
            <ul className="wm-list__items">
              {list?.messages.map((m) => (
                <li key={m.uid}>
                  <button type="button" className={`wm-item${!m.seen ? ' unread' : ''}`} onClick={() => openMessage(m)}>
                    <span className="wm-item__from">{m.fromText}</span>
                    <span className="wm-item__subj">{m.subject}</span>
                    <span className="wm-item__date">{fmtTime(m.date)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list && list.hasMore && <button type="button" className="btn btn-small wm-list__more" onClick={() => loadMessages(folder, page + 1)}>Older</button>}
        </section>

        <section className="wm-reader" aria-label="Message">
          {reading && msg ? <ReadPane msg={msg} keys={keys} onBack={() => setMsg(null)} onReply={() => reply(msg)} onForward={() => forward(msg)} onDelete={doDelete} onToggleFlag={doFlag} />
            : <div className="empty-state">{folder ? 'Select a message.' : 'Select a folder and a message.'}</div>}
        </section>
      </div>

      {compose && <ComposeModal {...compose} keys={keys} onClose={() => setCompose(null)} onSent={() => { setCompose(null); refresh(); }} />}
      {keysOpen && <KeysModal session={session} onClose={() => setKeysOpen(false)} onSaved={() => api.webmailKeys().then(setKeys).catch(() => {})} />}
    </div>
  );
}
