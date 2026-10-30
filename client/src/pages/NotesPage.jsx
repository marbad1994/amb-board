import { useCallback, useEffect, useState } from 'react';
import { Lock, Trash2, Users } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';

const today = () => new Date().toISOString().slice(0, 10);

export default function NotesPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [kind, setKind] = useState('note');
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', body: '', privacy: 'workspace', entry_date: today() });
  const [editing, setEditing] = useState(null); // { id, title, body }

  const load = useCallback(() => {
    const params = { kind };
    if (q.trim().length >= 1) params.q = q.trim();
    api.listNotes(params).then((r) => { setItems(r); setError(''); }).catch((err) => setError(err.message));
  }, [kind, q]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const act = async (fn) => { setError(''); try { await fn(); load(); } catch (err) { setError(err.message); } };
  const journal = kind === 'journal';

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">YOUR SPACE</div>
          <h1>Notes &amp; Journal</h1>
          <p className="page-sub">Notes can be shared with your workspace or kept private. Journal entries are always private to you: no one else can read them, and they are never sent to the AI.</p>
        </div>
      </div>
      <div className="filter-row">
        <div className="seg" role="group" aria-label="Type">
          <button type="button" aria-pressed={!journal} onClick={() => { setItems(null); setKind('note'); }}>Notes</button>
          <button type="button" aria-pressed={journal} onClick={() => { setItems(null); setKind('journal'); }}>Journal</button>
        </div>
        <input type="search" aria-label="Search notes" placeholder="Search" style={{ maxWidth: 260 }} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      {writable && (
        <form className="panel" style={{ marginBottom: 16 }} aria-label={journal ? 'New journal entry' : 'New note'}
          onSubmit={(e) => { e.preventDefault(); act(async () => { await api.createNote({ kind, title: form.title, body: form.body, privacy: form.privacy, entry_date: journal ? form.entry_date : undefined }); setForm({ ...form, title: '', body: '' }); }); }}>
          {!journal && <div className="field"><label htmlFor="n-title">Title</label><input id="n-title" type="text" maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>}
          {journal && <div className="field"><label htmlFor="n-date">Date</label><input id="n-date" type="date" value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} /></div>}
          <div className="field"><label htmlFor="n-body">{journal ? 'Entry' : 'Text'}</label><textarea id="n-body" rows={4} maxLength={50000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
          <div className="inline-form inline-form--wide">
            {!journal && <select aria-label="Visibility" value={form.privacy} onChange={(e) => setForm({ ...form, privacy: e.target.value })}><option value="workspace">Shared with workspace</option><option value="private">Only me</option></select>}
            {journal && <span className="hint"><Lock size={12} aria-hidden="true" /> Private to you</span>}
            <button type="submit" className="btn btn-primary" disabled={!form.body.trim() && !form.title.trim()}>Save</button>
          </div>
        </form>
      )}

      {items && items.length === 0 && <div className="empty-state">{q ? 'No matches.' : journal ? 'No journal entries yet.' : 'No notes yet.'}</div>}
      <div className="area-grid">
        {items?.map((n) => (
          <article key={n.id} className="panel note">
            <div className="panel__title">
              <h2>{journal ? n.entry_date : (n.title || 'Untitled')}</h2>
              <span className="role-tag">{n.privacy === 'private' ? <><Lock size={10} aria-hidden="true" /> Private</> : <><Users size={10} aria-hidden="true" /> Shared</>}</span>
            </div>
            {editing?.id === n.id ? (
              <form onSubmit={(e) => { e.preventDefault(); act(async () => { await api.updateNote(n.id, { title: editing.title, body: editing.body }); setEditing(null); }); }}>
                {!journal && <input type="text" aria-label="Edit title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />}
                <textarea aria-label="Edit text" rows={5} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                <div className="inline-form"><button type="submit" className="btn btn-primary">Save</button><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button></div>
              </form>
            ) : <p className="note__body">{n.body}</p>}
            <small className="hint">{n.mine ? 'You' : n.author_name}{n.project_name ? ` · ${n.project_name}` : ''}{n.goal_title ? ` · ${n.goal_title}` : ''}</small>
            {n.mine && writable && editing?.id !== n.id && (
              <div className="inline-form">
                <button type="button" className="btn" onClick={() => setEditing({ id: n.id, title: n.title, body: n.body })}>Edit</button>
                {!journal && <button type="button" className="btn" onClick={() => act(() => api.updateNote(n.id, { privacy: n.privacy === 'private' ? 'workspace' : 'private' }))}>{n.privacy === 'private' ? 'Share' : 'Make private'}</button>}
                <button type="button" className="btn btn-icon btn-ghost" aria-label={`Delete ${journal ? n.entry_date : n.title || 'note'}`} onClick={() => window.confirm('Delete permanently?') && act(() => api.deleteNote(n.id))}><Trash2 size={14} color="var(--color-danger)" /></button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
