import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import AiSummaryCard from '../components/AiSummaryCard.jsx';
import { fmt } from '../lib/money.js';
import { formatDate, priorityLabel } from '../lib/labels.js';

function TaskRow({ t }) {
  return (
    <li>
      <div className="task-list__main">
        <Link to={`/projects/${t.project_id}?card=${t.id}`}>{t.title}</Link>
        <small><span className={`prio prio--${t.priority}`}>{priorityLabel(t.priority)}</span> {t.project_name}{t.due_date ? ` · ${formatDate(t.due_date)}` : ''}</small>
      </div>
    </li>
  );
}

function Section({ id, title, count, children, empty }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel__title"><h2 id={id}>{title}</h2>{count !== undefined && <span className="muted">{count}</span>}</div>
      {count === 0 ? <p className="muted">{empty}</p> : children}
    </section>
  );
}

export default function MyDayPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [local, setLocal] = useState({});
  const load = useCallback(() => api.myDay().then(setD).catch((err) => setError(err.message)), []);
  useEffect(() => { load(); }, [load]);

  const check = async (h) => {
    const next = !(local[h.id] ?? h.done_today);
    setLocal((l) => ({ ...l, [h.id]: next }));
    try { await api.checkHabit(h.id, d.today, next); await load(); } catch (err) { setError(err.message); } finally { setLocal({}); }
  };

  const long = d ? new Date(`${d.today}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">DAILY FOCUS</div>
          <h1>My Day</h1>
          <p className="page-sub">{long || 'Loading…'}. What matters today, what needs attention, and what to do next.</p>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {d && (
        <>
          <AiSummaryCard kind="daily" writable={writable} title="Daily briefing" />
          {d.budget_alerts.length > 0 && (
            <p className="notice" role="status">Budget attention: {d.budget_alerts.map((a) => `${a.project_name} (${fmt(a.actual_minor, a.currency)} of ${fmt(a.approved_minor, a.currency)} spent)`).join('; ')}.</p>
          )}
          <div className="dash-grid">
            <Section id="md-over" title="Overdue" count={d.overdue.length} empty="Nothing overdue."><ul className="task-list">{d.overdue.map((t) => <TaskRow key={t.id} t={t} />)}</ul></Section>
            <Section id="md-today" title="Due today" count={d.due_today.length} empty="Nothing due today."><ul className="task-list">{d.due_today.map((t) => <TaskRow key={t.id} t={t} />)}</ul></Section>
            <Section id="md-events" title="Appointments today" count={d.events.length} empty="No appointments today.">
              <ul className="activity">{d.events.map((e) => <li key={e.id}><b>{e.title}</b><small>{e.all_day ? 'All day' : e.start_local.slice(11, 16)} ({e.timezone})</small></li>)}</ul>
            </Section>
            <Section id="md-habits" title="Habits" count={d.habits.length} empty="No habits due. Add some under Goals & Habits.">
              <ul className="task-list">
                {d.habits.map((h) => (
                  <li key={h.id}>
                    <input type="checkbox" aria-label={`${h.title}, done today`} checked={local[h.id] ?? h.done_today} disabled={!writable} onChange={() => check(h)} />
                    <div className="task-list__main"><span>{h.title}</span>{h.frequency === 'weekly' && <small>{h.week_done}/{h.week_target} this week</small>}</div>
                  </li>
                ))}
              </ul>
            </Section>
            <Section id="md-doing" title="In progress" count={d.in_progress.length} empty="No tasks marked Doing."><ul className="task-list">{d.in_progress.map((t) => <TaskRow key={t.id} t={t} />)}</ul></Section>
            <Section id="md-ms" title="Goal milestones this week" count={d.milestones_soon.length} empty="No milestones due in the next 7 days.">
              <ul className="plain-list">{d.milestones_soon.map((m) => <li key={m.id}><Link to="/goals">{m.title}</Link><span>{m.goal_title} · {formatDate(m.due_date)}</span></li>)}</ul>
            </Section>
            <Section id="md-proj" title="Important projects" count={d.important_projects.length} empty="No high-priority projects.">
              <ul className="plain-list">{d.important_projects.map((p) => <li key={p.id}><Link to={`/projects/${p.id}`}>{p.name}</Link><span><span className={`prio prio--${p.priority}`}>{priorityLabel(p.priority)}</span>{p.target_date ? ` due ${formatDate(p.target_date)}` : ''}</span></li>)}</ul>
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
