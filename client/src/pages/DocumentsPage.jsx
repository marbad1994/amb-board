import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';

const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function DocumentsPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [docs, setDocs] = useState(null);
  const [projects, setProjects] = useState([]);
  const [privacy, setPrivacy] = useState('workspace');
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(() => api.listDocuments().then(setDocs).catch((err) => setError(err.message)), []);
  useEffect(() => { load(); api.listProjects().then(setProjects).catch(() => {}); }, [load]);

  const upload = async (e) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true); setError('');
    try { await api.uploadDocument(file, { privacy, projectId }); fileRef.current.value = ''; await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const download = async (d) => {
    try {
      const url = URL.createObjectURL(await api.downloadDocument(d.id));
      const a = document.createElement('a'); a.href = url; a.download = d.name; a.click(); URL.revokeObjectURL(url);
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">RECORDS</div>
          <h1>Documents</h1>
          <p className="page-sub">PDF, images, Word/Excel, text and CSV up to 10 MB. Files are checked on upload and only downloadable by people allowed to see them.</p>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {writable && (
        <form className="panel inline-form inline-form--wide" style={{ marginBottom: 16 }} onSubmit={upload} aria-label="Upload document">
          <input ref={fileRef} type="file" aria-label="File" required />
          <select aria-label="Visibility" value={privacy} onChange={(e) => setPrivacy(e.target.value)}><option value="workspace">Shared with workspace</option><option value="private">Only me</option></select>
          <select aria-label="Link to project" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">No project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button type="submit" className="btn btn-primary" disabled={busy}><Upload size={16} aria-hidden="true" /> Upload</button>
        </form>
      )}
      {docs && docs.length === 0 && <div className="empty-state">No documents yet.</div>}
      {docs && docs.length > 0 && (
        <section className="panel">
          <ul className="task-list">
            {docs.map((d) => (
              <li key={d.id}>
                <FileText size={18} aria-hidden="true" />
                <div className="task-list__main"><span>{d.name}</span><small>{size(d.size)} · {d.privacy === 'private' ? 'Only you' : 'Shared'}{d.project_name ? ` · ${d.project_name}` : ''} · {d.uploaded_by_name} · {new Date(d.created_at).toLocaleDateString()}</small></div>
                <button type="button" className="btn btn-icon" aria-label={`Download ${d.name}`} onClick={() => download(d)}><Download size={16} /></button>
                {(d.mine || ['owner', 'admin'].includes(active?.role)) && writable && (
                  <button type="button" className="btn btn-icon btn-ghost" aria-label={`Delete ${d.name}`} onClick={() => window.confirm(`Delete ${d.name}?`) && api.deleteDocument(d.id).then(load).catch((err) => setError(err.message))}><Trash2 size={14} color="var(--color-danger)" /></button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
