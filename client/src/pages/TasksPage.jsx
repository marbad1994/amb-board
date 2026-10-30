import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import { formatDate, priorityLabel } from '../lib/labels.js';

const VIEWS = [
  { value: 'open', label: 'Open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'mine', label: 'Assigned to me' },
  { value: 'done', label: 'Completed' },
];

export default function TasksPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [view, setView] = useState('open');
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stale = false;
    api.listTasks(view)
      .then((t) => { if (!stale) { setTasks(t); setError(''); } })
      .catch((err) => { if (!stale) setError(err.message); });
    return () => { stale = true; };
  }, [view]);

  const switchView = (v) => { setTasks(null); setView(v); };

  // Optimistic: flip the checkbox at once, then drop the row from this filtered view shortly after.
  const toggle = async (task) => {
    const next = task.status === 'done' ? 'todo' : 'done';
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: next } : t)));
    try {
      await api.updateCard(task.id, { status: next });
      setTimeout(() => setTasks((prev) => prev && prev.filter((t) => t.id !== task.id)), 500);
    } catch (err) {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: task.status } : t)));
      setError(err.message);
    }
  };

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">TASK MANAGER</div>
          <h1>Tasks</h1>
          <p className="page-sub">Every task across your active projects, soonest due first.</p>
        </div>
      </div>
      <div className="seg seg--tabs" role="group" aria-label="Task views">
        {VIEWS.map((v) => (
          <button key={v.value} type="button" aria-pressed={view === v.value} onClick={() => switchView(v.value)}>{v.label}</button>
        ))}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {tasks === null && !error && <p>Loading…</p>}
      {tasks && tasks.length === 0 && <div className="empty-state">Nothing here.</div>}
      {tasks && tasks.length > 0 && (
        <section className="panel">
          <ul className="task-list">
            {tasks.map((t) => (
              <li key={t.id}>
                <label className="hit"><input type="checkbox" aria-label={`${t.status === 'done' ? 'Reopen' : 'Complete'} ${t.title}`}
                  checked={t.status === 'done'} disabled={!writable} onChange={() => toggle(t)} /></label>
                <div className="task-list__main">
                  <Link to={`/projects/${t.project_id}?card=${t.id}`} className={t.status === 'done' ? 'is-done' : ''}>{t.title}</Link>
                  <small>
                    <span className="dot" style={{ background: t.project_color }} aria-hidden="true" /> {t.project_name}
                    {t.owner && ` · ${t.owner}`}
                    {t.subtask_count > 0 && ` · ${t.subtask_done}/${t.subtask_count} subtasks`}
                  </small>
                </div>
                {t.due_date && (
                  <span className={`card__due ${t.overdue ? 'is-overdue' : ''}`}>{formatDate(t.due_date)}{t.overdue && ' (overdue)'}</span>
                )}
                <span className={`prio prio--${t.priority}`}>{priorityLabel(t.priority)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
