import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { api } from '../api/client.js';
import { PRIORITIES } from '../lib/labels.js';

export default function QuickAddTask({ onClose, prefill }) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState(null);
  const [form, setForm] = useState({ title: prefill?.title || '', projectId: prefill?.projectId || '', due_date: prefill?.due_date || '', priority: prefill?.priority || 'medium' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    api.listProjects().then((list) => {
      setProjects(list);
      setForm((f) => ({ ...f, projectId: f.projectId && list.some((p) => p.id === f.projectId) ? f.projectId : list[0]?.id || '' }));
    }).catch((err) => setError(err.message));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const columns = await api.listColumns(form.projectId);
      if (!columns.length) throw new Error('That project has no columns. Add one on its board first.');
      await api.createCard(columns[0].id, { title: form.title.trim(), due_date: form.due_date || null, priority: form.priority });
      window.dispatchEvent(new Event('amb:tasks-changed'));
      onClose();
      navigate(`/projects/${form.projectId}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-label="Quick add task" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal__header">
          <h2>Quick add task</h2>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal__body">
          {projects && projects.length === 0 ? (
            <p className="muted">Create a project first; tasks live inside projects.</p>
          ) : (
            <>
              <div className="field"><label htmlFor="qa-title">Task</label>
                <input id="qa-title" type="text" autoFocus required maxLength={200} value={form.title} onChange={set('title')} /></div>
              <div className="field"><label htmlFor="qa-project">Project</label>
                <select id="qa-project" value={form.projectId} onChange={set('projectId')}>
                  {(projects || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
              <div className="two-col">
                <div className="field"><label htmlFor="qa-due">Due date</label>
                  <input id="qa-due" type="date" value={form.due_date} onChange={set('due_date')} /></div>
                <div className="field"><label htmlFor="qa-prio">Priority</label>
                  <select id="qa-prio" value={form.priority} onChange={set('priority')}>
                    {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></div>
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-block" disabled={busy || !form.title.trim() || !form.projectId}>Add task</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
