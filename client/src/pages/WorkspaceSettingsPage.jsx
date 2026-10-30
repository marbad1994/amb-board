import { useCallback, useEffect, useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canManage } from '../context/AuthContext.jsx';

function MembersSection({ ws, me }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [form, setForm] = useState({ email: '', role: 'member' });
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState('');
  const manage = canManage(ws.role);
  const shared = ws.kind === 'shared';

  const load = useCallback(async () => {
    try {
      setMembers(await api.listMembers(ws.id));
      setInvites(manage && shared ? await api.listInvitations(ws.id) : []);
    } catch (err) {
      setError(err.message);
    }
  }, [ws.id, manage, shared]);

  useEffect(() => { load(); }, [load]);

  const act = async (fn) => {
    setError('');
    try { await fn(); await load(); } catch (err) { setError(err.message); }
  };

  const invite = (e) => {
    e.preventDefault();
    act(async () => {
      setIssued(await api.invite(ws.id, form.email, form.role));
      setForm({ ...form, email: '' });
    });
  };

  return (
    <section className="panel" aria-labelledby="members-h">
      <div className="panel__title"><h2 id="members-h">Members</h2></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <table className="table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.name}{m.id === me.id && ' (you)'}</td>
              <td>{m.email}</td>
              <td>
                {manage && m.role !== 'owner' && m.id !== me.id ? (
                  <select aria-label={`Role for ${m.name}`} value={m.role}
                    onChange={(e) => act(() => api.setMemberRole(ws.id, m.id, e.target.value))}>
                    {['admin', 'member', 'viewer'].map((r) => <option key={r} value={r} disabled={r === 'admin' && ws.role !== 'owner'}>{r}</option>)}
                  </select>
                ) : m.role}
              </td>
              <td>
                {m.role !== 'owner' && (manage || m.id === me.id) && (
                  <button type="button" className="btn btn-icon btn-ghost" aria-label={m.id === me.id ? 'Leave workspace' : `Remove ${m.name}`}
                    onClick={() => window.confirm(m.id === me.id ? 'Leave this workspace?' : `Remove ${m.name}?`) && act(() => api.removeMember(ws.id, m.id))}>
                    <Trash2 size={16} color="var(--color-danger)" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {manage && shared && (
        <>
          <h3 className="sub-h">Invite someone</h3>
          <form className="inline-form inline-form--wide" onSubmit={invite}>
            <input type="email" aria-label="Invitee email" placeholder="email@example.com" required value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <select aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="viewer">viewer (read only)</option>
              <option value="member">member</option>
              {ws.role === 'owner' && <option value="admin">admin</option>}
            </select>
            <button type="submit" className="btn btn-primary"><UserPlus size={16} /> Invite</button>
          </form>
          {issued && (
            <div className="notice" role="status">
              <p>Invitation code for <b>{issued.email}</b> ({issued.role}). Email delivery is not set up, so send this code yourself. It is shown only once and expires in 7 days.</p>
              <input type="text" readOnly aria-label="Invitation code" value={issued.token} onFocus={(e) => e.target.select()} />
            </div>
          )}
          {invites.length > 0 && (
            <ul className="plain-list">
              {invites.map((i) => (
                <li key={i.id}><span>{i.email} · {i.role} · pending</span>
                  <button type="button" className="btn btn-ghost" onClick={() => act(() => api.revokeInvitation(ws.id, i.id))}>Revoke</button></li>
              ))}
            </ul>
          )}
        </>
      )}
      {!shared && <p className="muted">Personal workspaces are single-user. Create a shared workspace below to collaborate.</p>}
    </section>
  );
}

function McpTokens() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.listTokens().then(setTokens).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const url = `${window.location.origin}/api/mcp`;
  return (
    <section className="panel" aria-labelledby="mcp-h">
      <div className="panel__title"><h2 id="mcp-h">Connect other AI tools (MCP)</h2></div>
      <p className="muted">External AI clients that support MCP can use the same skills as the assistant: read and analyse your data, create reports, and propose changes that still wait for your approval here. A token works in the current workspace only and acts as you.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <form className="inline-form inline-form--wide" onSubmit={async (e) => { e.preventDefault(); try { setIssued(await api.createToken(name.trim())); setName(''); load(); } catch (err) { setError(err.message); } }}>
        <input type="text" aria-label="Token name" placeholder="e.g. Claude Desktop" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Create token</button>
      </form>
      {issued && (
        <div className="notice" role="status">
          <p>Copy this token now. It is shown only once.</p>
          <input type="text" readOnly aria-label="New token" value={issued.token} onFocus={(e) => e.target.select()} />
          <p className="hint">Endpoint: <code>{url}</code> with header <code>Authorization: Bearer &lt;token&gt;</code> (JSON-RPC 2.0 over HTTP POST).</p>
        </div>
      )}
      {tokens.length > 0 && (
        <ul className="plain-list">{tokens.map((t) => <li key={t.id}><span>{t.name} · {t.prefix}… · {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleString()}` : 'never used'}</span>
          <button type="button" className="btn btn-ghost" onClick={() => window.confirm('Revoke this token?') && api.revokeToken(t.id).then(load)}>Revoke</button></li>)}</ul>
      )}
    </section>
  );
}

const AUTO_LABEL = { create_task: 'Create tasks', update_task: 'Change tasks', reschedule_task: 'Reschedule tasks', add_subtask: 'Add subtasks', add_comment: 'Add comments',
  create_note: 'Write notes', create_event: 'Add calendar events', create_habit: 'Create habits', add_milestone: 'Add goal milestones' };

function AssistantSettings() {
  const [auto, setAuto] = useState(null);
  const [conns, setConns] = useState(null);
  const [form, setForm] = useState({ name: '', url: '', token: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.listConnections().then(setConns).catch(() => setConns([]));
  useEffect(() => { api.assistantSettings().then(setAuto).catch(() => {}); load(); }, []);
  const toggle = (t, on) => { const next = on ? [...auto.auto_approve, t] : auto.auto_approve.filter((x) => x !== t); setAuto({ ...auto, auto_approve: next }); api.setAssistantSettings({ auto_approve: next }).then(setAuto).catch((e) => setMsg(e.message)); };
  const add = async (e) => {
    e.preventDefault(); setBusy(true); setMsg('');
    try { const r = await api.addConnection(form); setMsg(r.warning || `Connected "${r.name}": ${r.tools} tools found.`); setForm({ name: '', url: '', token: '' }); load(); } catch (err) { setMsg(err.message); } finally { setBusy(false); }
  };
  return (
    <section className="panel" aria-labelledby="as-h" style={{ gridColumn: '1 / -1' }}>
      <div className="panel__title"><h2 id="as-h">Assistant: autonomy and connected tools</h2></div>
      <h3 style={{ fontSize: 14 }}>Apply these changes without asking</h3>
      <p className="hint">Routine, easily undone changes only. Everything else (money, projects, automations, plans, outside tools) always waits for your approval. Applied changes are listed in the activity log.</p>
      {!auto ? <p className="muted">Loading...</p> : <div className="notify-prefs">{auto.available.map((t) => (
        <label key={t} className="check"><input type="checkbox" checked={auto.auto_approve.includes(t)} onChange={(e) => toggle(t, e.target.checked)} /> {AUTO_LABEL[t] || t}</label>
      ))}</div>}
      <h3 style={{ fontSize: 14, marginTop: 18 }}>Connected tools (MCP servers)</h3>
      <p className="hint">Let the assistant use other tools, for example a notes app or a calendar, through their MCP address (https only). Read-only tools run directly; anything that changes data outside AMB Board asks you first. Connections are private to you and the token is stored encrypted.</p>
      {conns && conns.length > 0 && (
        <ul className="plain-list" aria-label="Connected servers">{conns.map((c) => (
          <li key={c.id}><span><b>{c.name}</b> <small className="muted">{c.url}</small>{c.last_error && <small className="form-error"> {c.last_error}</small>}</span>
            <button type="button" className="btn" onClick={async () => { try { const r = await api.testConnection(c.id); setMsg(`${c.name}: ${r.tools.length} tools (${r.tools.filter((t) => t.read_only).length} read-only).`); } catch (e) { setMsg(`${c.name}: ${e.message}`); } load(); }}>Test</button>
            <button type="button" className="btn btn-icon btn-ghost" aria-label={`Disconnect ${c.name}`} onClick={async () => { await api.deleteConnection(c.id); load(); }}><Trash2 size={16} color="var(--color-danger)" /></button></li>
        ))}</ul>
      )}
      <form className="flow-row" onSubmit={add} aria-label="Connect a tool">
        <label className="field"><span className="field__label">Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={40} placeholder="e.g. Notes" required /></label>
        <label className="field"><span className="field__label">Server address</span><input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://..." required /></label>
        <label className="field"><span className="field__label">Access token (optional)</span><input type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} /></label>
        <div style={{ alignSelf: 'end' }}><button type="submit" className="btn btn-primary" disabled={busy}>Connect</button></div>
      </form>
      {msg && <p className="hint" role="status">{msg}</p>}
    </section>
  );
}

function NotificationPrefs() {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => { api.notificationPrefs().then(setPrefs).catch(() => {}); }, []);
  const [msg, setMsg] = useState('');
  const { user } = useAuth();
  const set = (k, v) => { setMsg(''); setPrefs((p) => ({ ...p, [k]: v })); api.setNotificationPrefs({ [k]: v }).then(setPrefs).catch((e) => { setMsg(e.message); api.notificationPrefs().then(setPrefs).catch(() => {}); }); };
  const test = async () => { setMsg('Sending...'); try { const r = await api.sendTestEmail(); setMsg(`Test email sent to ${r.sent_to}.`); } catch (e) { setMsg(e.message); } };
  const rows = [['event_reminders', 'Event reminders'], ['task_due', 'Tasks due today or overdue'], ['budget_alerts', 'Budget alerts']];
  return (
    <section className="panel" aria-labelledby="np-h">
      <div className="panel__title"><h2 id="np-h">Notifications</h2></div>
      {!prefs ? <p className="muted">Loading…</p> : <div className="notify-prefs">{rows.map(([k, l]) => (
        <label key={k} className="check"><input type="checkbox" checked={prefs[k]} onChange={(e) => set(k, e.target.checked)} /> {l}</label>
      ))}
        <label className="check"><input type="checkbox" checked={prefs.email} disabled={!prefs.email_available && !prefs.email} onChange={(e) => set('email', e.target.checked)} /> Also email me these notifications{user?.email ? ` (${user.email})` : ''}</label>
        {prefs.email && <div><button type="button" className="btn" onClick={test}>Send a test email</button></div>}
      </div>}
      {prefs && !prefs.email_available && <p className="hint">Email delivery is not set up on this server yet. The administrator adds the SMTP settings to the server environment.</p>}
      {msg && <p className="hint" role="status">{msg}</p>}
      <p className="hint">Only notifications from the moment you switch email on are sent, grouped into one message at a time. Push delivery is not available.</p>
    </section>
  );
}

export default function WorkspaceSettingsPage() {
  const { user, active, refreshWorkspaces, setActiveWorkspace, logoutAll } = useAuth();
  const [newName, setNewName] = useState('');
  const [code, setCode] = useState('');
  const [rename, setRename] = useState(active?.name || '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const run = async (fn, success) => {
    setError(''); setMsg('');
    try { await fn(); if (success) setMsg(success); } catch (err) { setError(err.message); }
  };

  if (!active) return null;

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">SYSTEM</div>
          <h1>Workspace &amp; account</h1>
          <p className="page-sub">Your role here: <b>{active.role}</b>. {active.kind === 'personal' ? 'Personal workspace.' : 'Shared workspace.'}</p>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {msg && <p className="form-ok" role="status">{msg}</p>}

      <div className="settings-grid">
        <MembersSection key={active.id} ws={active} me={user} />

        {active.role === 'owner' && (
          <section className="panel" aria-labelledby="rename-h">
            <div className="panel__title"><h2 id="rename-h">Rename workspace</h2></div>
            <form className="inline-form inline-form--wide" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.renameWorkspace(active.id, rename); await refreshWorkspaces(); }, 'Workspace renamed.'); }}>
              <input type="text" aria-label="Workspace name" value={rename} maxLength={80} onChange={(e) => setRename(e.target.value)} />
              <button type="submit" className="btn" disabled={!rename.trim()}>Save</button>
            </form>
          </section>
        )}

        <section className="panel" aria-labelledby="new-ws-h">
          <div className="panel__title"><h2 id="new-ws-h">Shared workspaces</h2></div>
          <form className="inline-form inline-form--wide" onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const ws = await api.createWorkspace(newName.trim());
              await refreshWorkspaces();
              setActiveWorkspace(ws.id);
              setNewName('');
            }, 'Shared workspace created.');
          }}>
            <input type="text" aria-label="New shared workspace name" placeholder="e.g. Family" maxLength={80} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={!newName.trim()}>Create</button>
          </form>
          <h3 className="sub-h">Join with an invitation code</h3>
          <form className="inline-form inline-form--wide" onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const res = await api.acceptInvitation(code.trim());
              await refreshWorkspaces();
              setActiveWorkspace(res.workspaceId);
              setCode('');
            }, 'Joined workspace.');
          }}>
            <input type="text" aria-label="Invitation code" placeholder="Paste code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="submit" className="btn" disabled={!code.trim()}>Join</button>
          </form>
        </section>

        <NotificationPrefs />

        <McpTokens />
        <AssistantSettings />

        <section className="panel" aria-labelledby="sec-h">
          <div className="panel__title"><h2 id="sec-h">Security</h2></div>
          <form onSubmit={(e) => {
            e.preventDefault();
            run(async () => { await api.changePassword(pw.currentPassword, pw.newPassword); setPw({ currentPassword: '', newPassword: '' }); },
              'Password changed. Other devices were signed out.');
          }}>
            <div className="field"><label htmlFor="pw-cur">Current password</label>
              <input id="pw-cur" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></div>
            <div className="field"><label htmlFor="pw-new">New password (10+ characters)</label>
              <input id="pw-new" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></div>
            <button type="submit" className="btn" disabled={!pw.currentPassword || pw.newPassword.length < 10}>Change password</button>
          </form>
          <h3 className="sub-h">Sessions</h3>
          <button type="button" className="btn btn-danger" onClick={() => window.confirm('Sign out on all devices?') && logoutAll()}>Sign out everywhere</button>
          <p className="muted">Multi-factor authentication, email verification and password recovery are not available yet.</p>
        </section>
      </div>
    </div>
  );
}
