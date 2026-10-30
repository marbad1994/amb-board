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

function NotificationPrefs() {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => { api.notificationPrefs().then(setPrefs).catch(() => {}); }, []);
  const set = (k, v) => { setPrefs((p) => ({ ...p, [k]: v })); api.setNotificationPrefs({ [k]: v }).then(setPrefs).catch(() => {}); };
  const rows = [['event_reminders', 'Event reminders'], ['task_due', 'Tasks due today or overdue'], ['budget_alerts', 'Budget alerts']];
  return (
    <section className="panel" aria-labelledby="np-h">
      <div className="panel__title"><h2 id="np-h">Notifications</h2></div>
      {!prefs ? <p className="muted">Loading…</p> : rows.map(([k, l]) => (
        <label key={k} className="check"><input type="checkbox" checked={prefs[k]} onChange={(e) => set(k, e.target.checked)} /> {l}</label>
      ))}
      <p className="hint">In-app only for now. Email and push delivery are not set up.</p>
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
