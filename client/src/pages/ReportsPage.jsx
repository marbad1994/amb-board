import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, FileBarChart, Trash2, ArrowLeft } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';

const KIND_LABEL = { overview: 'Overview', monthly_finance: 'Monthly finance', project_status: 'Project status', workload: 'Workload', custom: 'Custom' };
const save = (blob, name) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); };

export function ReportView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.getReport(id).then(setR).catch((err) => setError(err.message)); }, [id]);
  return (
    <div className="page page--wide">
      <div className="page-header">
        <div className="inline-form">
          <button type="button" className="btn btn-icon btn-ghost" aria-label="Back to reports" onClick={() => navigate('/reports')}><ArrowLeft size={18} /></button>
          <h1>{r?.title || 'Report'}</h1>
        </div>
        {r && <button type="button" className="btn btn-primary" onClick={() => api.downloadReport(id).then((b) => save(b, `${r.title.replace(/[^\w -]+/g, '').trim() || 'report'}.html`)).catch((e) => setError(e.message))}><Download size={16} aria-hidden="true" /> Download HTML</button>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="hint">This is a standalone file: download it to share or print. Reports are private to you.</p>
      {/* sandbox="" disables scripts, forms and same-origin access: the report is inert content */}
      {r && <iframe className="report-frame" title={r.title} sandbox="" srcDoc={r.html} />}
    </div>
  );
}

export default function ReportsPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({ kind: 'overview', month: new Date().toISOString().slice(0, 7), project_id: '', narrative: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('new');
  const ordered = [...(items || [])].sort((a, b) => (sort === 'old' ? a.created_at.localeCompare(b.created_at) : sort === 'title' ? a.title.localeCompare(b.title) : sort === 'type' ? (KIND_LABEL[a.kind] || a.kind).localeCompare(KIND_LABEL[b.kind] || b.kind) || b.created_at.localeCompare(a.created_at) : b.created_at.localeCompare(a.created_at)));
  const load = useCallback(() => api.listReports().then((r) => setItems(r.items)).catch((err) => setError(err.message)), []);
  useEffect(() => { load(); api.listProjects().then(setProjects).catch(() => {}); }, [load]);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { kind: form.kind, narrative: form.narrative };
      if (form.kind === 'monthly_finance') body.month = form.month;
      if (form.kind === 'project_status') body.project_id = form.project_id;
      const r = await api.createReport(body);
      navigate(`/reports/${r.id}`);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">SHARE & ANALYSE</div>
          <h1>Reports</h1>
          <p className="page-sub">Standalone HTML reports with charts, built from your data. Download one to share or print. You can also ask the assistant to create one.</p>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {writable && (
        <form className="panel inline-form inline-form--wide" style={{ marginBottom: 16 }} onSubmit={create} aria-label="New report">
          <select aria-label="Report type" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(KIND_LABEL).filter(([k]) => k !== 'custom').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {form.kind === 'monthly_finance' && <input type="month" aria-label="Report month" value={form.month} onChange={(e) => e.target.value && setForm({ ...form, month: e.target.value })} />}
          {form.kind === 'project_status' && <select aria-label="Report project" required value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}><option value="">Choose a project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          <label className="check"><input type="checkbox" checked={form.narrative} onChange={(e) => setForm({ ...form, narrative: e.target.checked })} /> Add AI commentary</label>
          <button type="submit" className="btn btn-primary" disabled={busy || (form.kind === 'project_status' && !form.project_id)}><FileBarChart size={16} aria-hidden="true" /> Create report</button>
        </form>
      )}
      {items && items.length === 0 && <div className="empty-state">No reports yet.</div>}
      {items && items.length > 1 && (
        <label className="field report-sort"><span className="field__label">Sort by</span>
          <select aria-label="Sort reports" value={sort} onChange={(e) => setSort(e.target.value)}><option value="new">Newest first</option><option value="old">Oldest first</option><option value="title">Title A to Z</option><option value="type">Type</option></select></label>
      )}
      {items && items.length > 0 && (
        <section className="panel">
          <ul className="task-list">
            {ordered.map((r) => (
              <li key={r.id}>
                <FileBarChart size={18} aria-hidden="true" />
                <div className="task-list__main"><Link to={`/reports/${r.id}`}>{r.title}</Link><small>{KIND_LABEL[r.kind] || r.kind} · {new Date(r.created_at).toLocaleString()} · {Math.round(r.size / 1024)} KB</small></div>
                <button type="button" className="btn btn-icon" aria-label={`Download ${r.title}`} onClick={() => api.downloadReport(r.id).then((b) => save(b, `${r.title.replace(/[^\w -]+/g, '').trim() || 'report'}.html`)).catch((e) => setError(e.message))}><Download size={16} /></button>
                {writable && <button type="button" className="btn btn-icon btn-ghost" aria-label={`Delete ${r.title}`} onClick={() => window.confirm('Delete this report?') && api.deleteReport(r.id).then(load).catch((e) => setError(e.message))}><Trash2 size={14} color="var(--color-danger)" /></button>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
