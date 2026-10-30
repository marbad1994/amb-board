import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, ListChecks, StickyNote, Layers } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { fmt } from '../lib/money.js';
import AiSummaryCard from '../components/AiSummaryCard.jsx';
import { canWrite } from '../context/AuthContext.jsx';
import { LifeAreaIcon } from '../lib/lifeAreaIcons.jsx';

const ACTION_LABELS = {
  'project.create': 'created a project', 'project.archive': 'archived a project', 'project.restore': 'restored a project',
  'project.delete': 'deleted a project', 'project.status_change': 'changed a project status', 'idea.convert': 'turned an idea into a project', 'ai.project_summary': 'generated an AI project summary', 'ai.action_executed': 'approved an AI suggestion', 'ai.action_rejected': 'rejected an AI suggestion', 'transaction.create': 'recorded a transaction', 'transaction.void': 'voided a transaction', 'budget.set': 'set a project budget', 'event.create': 'added a calendar event', 'event.update': 'updated a calendar event', 'event.delete': 'deleted a calendar event', 'lifearea.create': 'added a life area', 'lifearea.update': 'updated a life area',
  'lifearea.archive': 'archived a life area', 'lifearea.restore': 'restored a life area', 'workspace.create': 'created this workspace',
  'invitation.create': 'invited someone', 'invitation.accept': 'joined the workspace', 'member.role_change': 'changed a role',
  'member.remove': 'removed a member', 'member.leave': 'left the workspace', 'workspace.rename': 'renamed the workspace',
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const VERBS = { create: 'added', update: 'updated', delete: 'deleted', archive: 'archived', restore: 'restored', complete: 'completed', move: 'moved' };
const humanAction = (a) => {
  if (ACTION_LABELS[a]) return ACTION_LABELS[a];
  const [entity, verb] = a.split('.');
  return verb ? `${VERBS[verb] || verb.replace(/_/g, ' ')} ${/^[aeiou]/i.test(entity) ? 'an' : 'a'} ${entity.replace(/_/g, ' ')}` : a.replace(/_/g, ' ');
};
// "2026-10-31T09:00" -> "Sat 31 Oct, 09:00" (wall-clock text is kept, nothing is shifted between time zones)
function eventWhen(e) {
  const [d, t] = String(e.start_local).split('T');
  const label = new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return e.all_day || !t ? `${label}, all day` : `${label}, ${t.slice(0, 5)}`;
}
const dueLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// "5 min ago", "Yesterday, 14:05", "Oct 29": people read when, not timestamps with seconds
function relTime(iso) {
  const d = new Date(iso); const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  const y = new Date(); y.setDate(y.getDate() - 1);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === y.toDateString() ? `Yesterday, ${t}` : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function DashboardPage() {
  const { user, active } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [attention, setAttention] = useState(null);

  useEffect(() => {
    api.dashboard().then(setData).catch((err) => setError(err.message));
    api.listTasks('overdue').then((t) => setAttention(t.slice(0, 5))).catch(() => setAttention([]));
  }, []);

  const stats = data && [
    { label: 'Active projects', value: data.counts.activeProjects, icon: FolderKanban, sub: `${data.counts.archivedProjects} archived` },
    { label: 'Open tasks', value: data.counts.openTasks, icon: ListChecks, sub: `${data.counts.overdueTasks} overdue · ${data.counts.tasks} total` },
    { label: 'Ideas', value: data.counts.ideas, icon: StickyNote, sub: 'Not yet committed' },
    { label: 'Life areas', value: data.counts.lifeAreas, icon: Layers, sub: 'Active' },
  ];

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">{active?.name?.toUpperCase()}</div>
          <h1>Hello, {user?.name?.split(' ')[0]}</h1>
          <p className="page-sub">Your workspace at a glance. Figures below come from your saved records.</p>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <p>Loading…</p>}

      {data && (
        <>
          <div className="stat-grid">
            {stats.map(({ label, value, icon: Icon, sub }) => (
              <div key={label} className="stat-card">
                <div className="stat-card__head"><span>{label}</span><span className="stat-card__icon"><Icon size={18} aria-hidden="true" /></span></div>
                <div className="stat-card__num">{value}</div>
                <div className="stat-card__sub">{sub}</div>
              </div>
            ))}
          </div>

          <AiSummaryCard kind="daily" writable={canWrite(active?.role)} title="Daily briefing" />

          {data.budgetAlerts.length > 0 && (
            <section className="panel" aria-labelledby="dash-alerts" style={{ marginBottom: 16 }}>
              <div className="panel__title"><h2 id="dash-alerts">Budget alerts</h2></div>
              <ul className="plain-list">
                {data.budgetAlerts.map((a) => (
                  <li key={a.project_id}><Link to={`/projects/${a.project_id}`}>{a.project_name}</Link>
                    <span>{{ warning: 'Approaching limit', forecast_over: 'Forecast over budget', over: 'Over budget' }[a.status]}: {fmt(a.actual_minor, a.currency)} of {fmt(a.approved_minor, a.currency)} spent{a.forecast_overrun_minor > 0 ? `, forecast overrun ${fmt(a.forecast_overrun_minor, a.currency)}` : ''}</span></li>
                ))}
              </ul>
            </section>
          )}

          <div className="dash-grid">
            <section className="panel attention dash-wide" aria-labelledby="dash-attention">
              <div className="panel__title"><h2 id="dash-attention">Needs attention</h2><Link to="/tasks">All tasks</Link></div>
              {attention === null ? <p className="muted">Loading...</p> : attention.length === 0 ? <p className="muted">Nothing is overdue. Nice work.</p> : (
                <ul className="activity">
                  {attention.map((t) => (
                    <li key={t.id}><Link to={`/projects/${t.project_id}?card=${t.id}`}><b>{t.title}</b></Link>
                      <small><span className="is-overdue">Overdue since {dueLabel(t.due_date)}</span> · {t.project_name}</small></li>
                  ))}
                </ul>
              )}
            </section>
            <section className="panel" aria-labelledby="dash-events">
              <div className="panel__title"><h2 id="dash-events">Upcoming events</h2><Link to="/calendar">Calendar</Link></div>
              {data.upcomingEvents.length === 0 ? <p className="muted">Nothing in the next 7 days.</p> : (
                <ul className="activity">{data.upcomingEvents.map((e) => (
                  <li key={e.id}><b>{e.title}</b><small>{eventWhen(e)}</small></li>
                ))}</ul>
              )}
            </section>

            <section className="panel" aria-labelledby="dash-projects">
              <div className="panel__title"><h2 id="dash-projects">Recent projects</h2><Link to="/projects">View all</Link></div>
              {data.recentProjects.length === 0 ? (
                <p className="muted">No projects yet. <Link to="/projects">Create your first project.</Link></p>
              ) : data.recentProjects.map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="row-link">
                  <span className="dot" style={{ background: p.color }} aria-hidden="true" />
                  <span><b>{p.name}</b><small>{p.life_area_name || 'No life area'} · {plural(p.card_count, 'task')}</small></span>
                </Link>
              ))}
            </section>

            <section className="panel" aria-labelledby="dash-areas">
              <div className="panel__title"><h2 id="dash-areas">Life areas</h2><Link to="/life-areas">Manage</Link></div>
              {data.lifeAreas.every((a) => !a.project_count) && <p className="muted">No project is assigned to a life area yet. Give a project a life area to see it here.</p>}
              <ul className="area-list">
                {[...data.lifeAreas].filter((a) => a.project_count > 0).sort((x, y) => y.project_count - x.project_count).slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <Link to={`/projects?lifeArea=${a.id}`}>
                      <LifeAreaIcon name={a.icon} size={16} /><span>{a.name}</span><b>{a.project_count}</b>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel" aria-labelledby="dash-activity">
              <div className="panel__title"><h2 id="dash-activity">Recent activity</h2></div>
              {data.activity.length === 0 ? <p className="muted">No activity yet.</p> : (
                <ul className="activity">
                  {data.activity.map((a, i) => (
                    <li key={i}><b>{a.user_name || 'Someone'}</b> {humanAction(a.action)}
                      <small title={new Date(a.created_at).toLocaleString()}>{relTime(a.created_at)}</small></li>
                  ))}
                </ul>
              )}
            </section>

          </div>
        </>
      )}
    </div>
  );
}
