import { useEffect, useState } from 'react';
import { Copy, Globe, KeyRound, Mail, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';

const STATUS = { ok: ['Correct', 'status-done'], missing: ['Missing', ''], mismatch: ['Needs attention', ''] };

function CopyField({ label, value }) {
  const [done, setDone] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* the field is selectable */ } };
  return (
    <label className="field"><span className="field__label">{label}</span>
      <span className="mail-copy"><input readOnly value={value} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn btn-icon btn-ghost" onClick={copy} aria-label={`Copy ${label}`}><Copy size={16} aria-hidden="true" /></button>{done && <small role="status">Copied</small>}</span></label>
  );
}

// A password the server generated is shown exactly once.
function OnceBox({ what, password, onClose }) {
  return (
    <div className="mail-once" role="status">
      <p><b>{what}</b> The password is shown only now. Copy it and hand it over safely; it cannot be read again, only replaced.</p>
      <CopyField label="Password" value={password} />
      <button type="button" className="btn" onClick={onClose}>I have saved it</button>
    </div>
  );
}

function Mailboxes({ d, info, reload }) {
  const [list, setList] = useState(null); const [form, setForm] = useState({ local_part: '', password: '', quota_mb: 1024 });
  const [once, setOnce] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const { active } = useAuth(); const [members, setMembers] = useState([]);
  const load = () => api.mailAccounts(d.id).then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); api.listMembers(active.id).then(setMembers).catch(() => {}); }, [d.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const add = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api.mailAddAccount(d.id, { ...form, password: form.password || undefined }); setForm({ local_part: '', password: '', quota_mb: 1024 }); if (r.password) setOnce({ what: `Mailbox ${r.address} created.`, password: r.password }); load(); reload(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const act = async (fn) => { setErr(''); try { await fn(); load(); reload(); } catch (x) { setErr(x.message); } };
  return (
    <div>
      {once && <OnceBox {...once} onClose={() => setOnce(null)} />}
      <p className="hint">"Encrypt at rest" stores the mailbox's mail encrypted on the server disk (Dovecot mail_crypt). It needs the server prepared with deploy/mail/setup-mail.sh; turning it on here applies at the next sync.</p>
      {list && list.length === 0 && <p className="muted">No mailboxes yet.</p>}
      {list && list.length > 0 && (
        <ul className="plain-list" aria-label={`Mailboxes of ${d.domain}`}>{list.map((a) => (
          <li key={a.id}><span><b>{a.address}</b> {!a.enabled && <span className="badge">Login off</span>} {a.encrypt_at_rest && <span className="badge status-done">Encrypted at rest</span>}<br /><small className="muted">{a.quota_mb} MB{a.sent_today !== null && ` · sent ${a.sent_today} today (limit ${info.sending.per_mailbox_day})`}</small></span>
            <span className="mail-actions">
              {info.features.new_mail_notifications && (
                <label className="mail-notify"><span>Tell</span>
                  <select aria-label={`Who is told about new mail in ${a.address}`} value={a.notify_user_id || ''} onChange={(e) => act(() => api.mailUpdateAccount(a.id, { notify_user_id: e.target.value || null }))}>
                    <option value="">nobody</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
              )}
              <button type="button" className="btn btn-small" onClick={() => act(() => api.mailUpdateAccount(a.id, { encrypt_at_rest: !a.encrypt_at_rest }))}>{a.encrypt_at_rest ? 'Encryption on' : 'Encrypt at rest'}</button>
              <button type="button" className="btn btn-small" onClick={() => act(() => api.mailUpdateAccount(a.id, { enabled: !a.enabled }))}>{a.enabled ? 'Turn login off' : 'Turn login on'}</button>
              <button type="button" className="btn btn-small" onClick={async () => { if (!window.confirm(`Set a new password for ${a.address}? The old one stops working.`)) return; setErr(''); try { const r = await api.mailAccountPassword(a.id); setOnce({ what: `New password for ${a.address}.`, password: r.password }); } catch (x) { setErr(x.message); } }}><KeyRound size={14} aria-hidden="true" /> New password</button>
              <button type="button" className="btn btn-icon btn-ghost" aria-label={`Delete ${a.address}`} onClick={() => window.confirm(`Delete ${a.address}? It can no longer log in or receive mail. Its stored messages are removed from the server after ${info.features.trash_days} days (kept in a trash folder until then in case this was a mistake).`) && act(() => api.mailDeleteAccount(a.id))}><Trash2 size={16} color="var(--color-danger)" aria-hidden="true" /></button></span></li>
        ))}</ul>
      )}
      <form className="flow-row" onSubmit={add} aria-label="Add a mailbox">
        <label className="field"><span className="field__label">Name</span><span className="mail-at"><input value={form.local_part} onChange={(e) => setForm({ ...form, local_part: e.target.value })} placeholder="anna" required maxLength={64} /><span>@{d.domain}</span></span></label>
        <label className="field"><span className="field__label">Password (empty = generate one)</span><input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="at least 12 characters" /></label>
        <label className="field"><span className="field__label">Size limit (MB)</span><input type="number" min="50" max="51200" value={form.quota_mb} onChange={(e) => setForm({ ...form, quota_mb: e.target.value })} /></label>
        <div style={{ alignSelf: 'end' }}><button type="submit" className="btn btn-primary" disabled={busy}><Plus size={14} aria-hidden="true" /> Add mailbox</button></div>
      </form>
      {err && <p className="form-error" role="alert">{err}</p>}
    </div>
  );
}

function Aliases({ d, reload }) {
  const [list, setList] = useState(null); const [form, setForm] = useState({ local_part: '', destinations: '' }); const [err, setErr] = useState('');
  const load = () => api.mailAliases(d.id).then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [d.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn) => { setErr(''); try { await fn(); load(); reload(); } catch (x) { setErr(x.message); } };
  return (
    <div>
      <p className="hint">An alias is an address that forwards to one to five others, in this domain or anywhere. Use <b>*</b> as the name to catch everything sent to addresses that do not exist (expect spam).</p>
      {list && list.length === 0 && <p className="muted">No aliases yet.</p>}
      {list && list.length > 0 && (
        <ul className="plain-list" aria-label={`Aliases of ${d.domain}`}>{list.map((a) => (
          <li key={a.id}><span><b>{a.address}</b> {a.catch_all && <span className="badge">Catch-all</span>} {!a.enabled && <span className="badge">Off</span>}<br /><small className="muted">forwards to {a.destinations.join(', ')}</small></span>
            <span className="mail-actions">
              <button type="button" className="btn btn-small" onClick={() => act(() => api.mailUpdateAlias(a.id, { enabled: !a.enabled }))}>{a.enabled ? 'Turn off' : 'Turn on'}</button>
              <button type="button" className="btn btn-small" onClick={() => { const v = window.prompt(`Forward ${a.address} to (separate with commas):`, a.destinations.join(', ')); if (v) act(() => api.mailUpdateAlias(a.id, { destinations: v })); }}>Change</button>
              <button type="button" className="btn btn-icon btn-ghost" aria-label={`Delete ${a.address}`} onClick={() => window.confirm(`Delete the alias ${a.address}?`) && act(() => api.mailDeleteAlias(a.id))}><Trash2 size={16} color="var(--color-danger)" aria-hidden="true" /></button></span></li>
        ))}</ul>
      )}
      <form className="flow-row" aria-label="Add an alias" onSubmit={(e) => { e.preventDefault(); act(async () => { await api.mailAddAlias(d.id, form); setForm({ local_part: '', destinations: '' }); }); }}>
        <label className="field"><span className="field__label">Alias</span><span className="mail-at"><input value={form.local_part} onChange={(e) => setForm({ ...form, local_part: e.target.value })} placeholder="info" required maxLength={64} /><span>@{d.domain}</span></span></label>
        <label className="field"><span className="field__label">Forward to (separate with commas)</span><input value={form.destinations} onChange={(e) => setForm({ ...form, destinations: e.target.value })} placeholder={`anna@${d.domain}, me@gmail.com`} required /></label>
        <div style={{ alignSelf: 'end' }}><button type="submit" className="btn btn-primary"><Plus size={14} aria-hidden="true" /> Add alias</button></div>
      </form>
      {err && <p className="form-error" role="alert">{err}</p>}
    </div>
  );
}

function DnsRecords({ d }) {
  const [recs, setRecs] = useState(null); const [note, setNote] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const check = async () => { setBusy(true); setErr(''); try { const r = await api.mailDns(d.id); setRecs(r.records); setNote(r.note); } catch (x) { setErr(x.message); } finally { setBusy(false); } };
  useEffect(() => { check(); }, [d.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <p className="hint">Add these records at the company that runs the DNS for {d.domain}. Mail only arrives here once the MX record points to this server.</p>
      <button type="button" className="btn btn-small" onClick={check} disabled={busy}><RefreshCw size={14} aria-hidden="true" /> {busy ? 'Checking...' : 'Check again'}</button>
      {err && <p className="form-error" role="alert">{err}</p>}
      {recs && (
        <ul className="mail-dns" aria-label="DNS records">{recs.map((r) => (
          <li key={r.key}>
            <div className="mail-dns__head"><b>{r.type} record</b> <span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span></div>
            <CopyField label="Name" value={r.name} /><CopyField label="Value" value={r.value} />
            <p className={`hint${r.status === 'mismatch' ? ' mail-warn' : ''}`}>{r.note}{r.found?.length > 0 && r.status !== 'ok' ? ` Found now: ${r.found.join(' | ')}` : ''}</p>
          </li>
        ))}</ul>
      )}
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

function Connect({ info, d }) {
  const c = { ...info.client, webmail: info.features.webmail };
  return (
    <div>
      {c.webmail && <p><a className="btn btn-primary" href={c.webmail} target="_blank" rel="noreferrer">Open webmail</a> <span className="hint">Read and send mail in the browser; log in with the full address and the mailbox password.</span></p>}
      <p className="hint">Or add a mailbox to any mail app (Thunderbird, Apple Mail, Outlook, a phone) with these settings. The user name is the full address, for example anna@{d.domain}, and the password is the mailbox password.</p>
      <ul className="plain-list">
        <li><span><b>Incoming (IMAP)</b><br /><small className="muted">Server {c.imap.host || '(set MAIL_HOST)'}, port {c.imap.port}, {c.imap.security}</small></span></li>
        <li><span><b>Outgoing (SMTP)</b><br /><small className="muted">Server {c.smtp.host || '(set MAIL_HOST)'}, port {c.smtp.port}, {c.smtp.security}, log in with the same user name and password</small></span></li>
      </ul>
    </div>
  );
}

function DomainCard({ d, info, reload }) {
  const [tab, setTab] = useState('mailboxes'); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const verify = async () => { setBusy(true); setErr(''); try { await api.mailVerify(d.id); reload(); } catch (x) { setErr(x.message); } finally { setBusy(false); } };
  const TABS = [['mailboxes', 'Mailboxes'], ['aliases', 'Aliases'], ['dns', 'DNS records'], ['connect', 'Mail app settings']];
  return (
    <section className="panel mail-domain" aria-label={d.domain}>
      <div className="panel__title">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Globe size={16} aria-hidden="true" /> {d.domain} {d.verified ? <span className="badge status-done">Verified</span> : <span className="badge">Waiting for DNS</span>}</h3>
        <button type="button" className="btn btn-icon btn-ghost" aria-label={`Remove ${d.domain}`} onClick={() => window.confirm(`Remove ${d.domain}? Its mailboxes and aliases are deleted and mail stops being accepted. Stored messages are removed from the server after ${info.features.trash_days} days.`) && api.mailDeleteDomain(d.id).then(reload).catch((e) => setErr(e.message))}><Trash2 size={16} color="var(--color-danger)" aria-hidden="true" /></button>
      </div>
      {!d.verified ? (
        <div>
          <p>To use {d.domain} here, prove that you control it. Add this TXT record at your DNS provider, wait a few minutes, then press Check. Until then no mail is accepted for the domain.</p>
          <CopyField label="Name" value={d.verify.name} /><CopyField label="Value" value={d.verify.value} />
          <button type="button" className="btn btn-primary" onClick={verify} disabled={busy}>{busy ? 'Checking...' : 'Check now'}</button>
        </div>
      ) : (
        <>
          <div className="seg seg--tabs" role="group" aria-label={`${d.domain} sections`}>{TABS.map(([v, l]) => <button key={v} type="button" aria-pressed={tab === v} onClick={() => setTab(v)}>{l}</button>)}</div>
          <div style={{ marginTop: 14 }}>
            {tab === 'mailboxes' && <Mailboxes d={d} info={info} reload={reload} />}
            {tab === 'aliases' && <Aliases d={d} reload={reload} />}
            {tab === 'dns' && <DnsRecords d={d} />}
            {tab === 'connect' && <Connect info={info} d={d} />}
          </div>
        </>
      )}
      {err && <p className="form-error" role="alert">{err}</p>}
    </section>
  );
}

export default function MailSettings() {
  const [info, setInfo] = useState(null); const [domain, setDomain] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const reload = () => api.mailInfo().then(setInfo).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, []);
  const add = async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await api.mailAddDomain(domain); setDomain(''); reload(); } catch (x) { setErr(x.message); } finally { setBusy(false); } };
  if (!info) return <section className="panel"><p className="muted">{err || 'Loading...'}</p></section>;
  if (!info.available) return (
    <section className="panel" aria-labelledby="mail-h">
      <div className="panel__title"><h2 id="mail-h"><Mail size={16} aria-hidden="true" /> Email hosting</h2></div>
      <p>{info.enabled ? 'Email hosting is not turned on for this workspace on this server.' : 'Email hosting is not set up on this server yet.'}</p>
      <p className="hint">The server administrator prepares it once with deploy/mail/setup-mail.sh and sets MAIL_ENABLED=true (see docs/MAIL.md). After that, owners and admins attach their own domains here and create mailboxes and aliases.</p>
    </section>
  );
  const { usage, limits, sync } = info;
  return (
    <div className="mail">
      <section className="panel" aria-labelledby="mail-h">
        <div className="panel__title"><h2 id="mail-h"><Mail size={16} aria-hidden="true" /> Email hosting</h2></div>
        <p className="hint">Attach your own domains and create mailboxes and aliases for them. A domain only works after you prove you own it with a DNS record. {usage.domains} of {limits.domains} domains, {usage.accounts} of {limits.accounts} mailboxes, {usage.aliases} of {limits.aliases} aliases used.</p>
        <p className="hint">{info.features.spam_filter ? 'Spam filter on: suspected spam goes to the Junk folder of each mailbox. ' : ''}Sending limits keep one mailbox or domain from using up the reputation every workspace on this server shares: {info.sending.per_mailbox_hour} recipients per mailbox per hour, {info.sending.per_mailbox_day} per mailbox per day, {info.sending.per_domain_day} per domain per day. A mailbox can only send as its own address or its aliases.</p>
        <p className="hint" role="status">{sync === null ? 'Waiting for the mail server helper. If this stays, run deploy/mail/setup-mail.sh on the server.' : sync.ok ? `Applied to the mail server ${new Date(sync.at).toLocaleString()}.` : `The mail server rejected the last change: ${sync.error}`}</p>
        <form className="flow-row" onSubmit={add} aria-label="Attach a domain">
          <label className="field"><span className="field__label">Domain</span><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" required maxLength={253} /></label>
          <div style={{ alignSelf: 'end' }}><button type="submit" className="btn btn-primary" disabled={busy || usage.domains >= limits.domains}><Plus size={14} aria-hidden="true" /> Attach domain</button></div>
        </form>
        {err && <p className="form-error" role="alert">{err}</p>}
      </section>
      {info.domains.map((d) => <DomainCard key={d.id} d={d} info={info} reload={reload} />)}
    </div>
  );
}
