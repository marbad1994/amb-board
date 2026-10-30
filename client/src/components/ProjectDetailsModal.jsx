import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api/client.js';
import { PROJECT_STATUSES, PRIORITIES } from '../lib/labels.js';
import AiSummaryCard from './AiSummaryCard.jsx';
import ProjectBudgetCard from './ProjectBudgetCard.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function ProjectDetailsModal({ project, writable, onClose, onSaved }) {
  const { active } = useAuth();
  const [areas, setAreas] = useState([]);
  const [form, setForm] = useState({
    name: project.name, description: project.description || '', lifeAreaId: project.life_area_id || '',
    status: project.status, priority: project.priority,
    start_date: project.start_date || '', target_date: project.target_date || '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    api.listLifeAreas().then(setAreas).catch(() => {});
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const updated = await api.updateProject(project.id, {
        name: form.name, description: form.description, lifeAreaId: form.lifeAreaId || null,
        status: form.status, priority: form.priority,
        start_date: form.start_date || null, target_date: form.target_date || null,
      });
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Project details" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Project details</h2>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal__body">
          <div className="field">
            <label htmlFor="pd-progress">Progress</label>
            <div className="progress" id="pd-progress" role="progressbar" aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${project.progress}%` }} />
            </div>
            <small className="hint">{project.done_count} of {project.card_count} tasks done{project.overdue_count ? `, ${project.overdue_count} overdue` : ''}. Calculated from task status.</small>
          </div>
          <ProjectBudgetCard projectId={project.id} role={active?.role} writable={writable} />
          <AiSummaryCard kind="project" projectId={project.id} writable={writable} title="AI project summary" />
          <form onSubmit={save}>
          <fieldset disabled={!writable} className="plain-fieldset">
            <div className="field"><label htmlFor="pd-name">Name</label>
              <input id="pd-name" type="text" required maxLength={120} value={form.name} onChange={set('name')} /></div>
            <div className="field"><label htmlFor="pd-desc">Description</label>
              <textarea id="pd-desc" rows={3} maxLength={5000} value={form.description} onChange={set('description')} /></div>
            <div className="two-col">
              <div className="field"><label htmlFor="pd-status">Status</label>
                <select id="pd-status" value={form.status} onChange={set('status')}>
                  {PROJECT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
              <div className="field"><label htmlFor="pd-prio">Priority</label>
                <select id="pd-prio" value={form.priority} onChange={set('priority')}>
                  {PRIORITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
            </div>
            <div className="field"><label htmlFor="pd-area">Life area</label>
              <select id="pd-area" value={form.lifeAreaId} onChange={set('lifeAreaId')}>
                <option value="">No life area</option>
                {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
            <div className="two-col">
              <div className="field"><label htmlFor="pd-start">Start date</label>
                <input id="pd-start" type="date" value={form.start_date} onChange={set('start_date')} /></div>
              <div className="field"><label htmlFor="pd-target">Target date</label>
                <input id="pd-target" type="date" value={form.target_date} onChange={set('target_date')} /></div>
            </div>
          </fieldset>
          {error && <p className="form-error" role="alert">{error}</p>}
          {writable && <button type="submit" className="btn btn-primary btn-block" disabled={busy || !form.name.trim()}>Save</button>}
          </form>
        </div>
      </div>
    </div>
  );
}
