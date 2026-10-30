import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, ListChecks, StickyNote, Layers } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { LifeAreaIcon } from '../lib/lifeAreaIcons.jsx';

const ACTION_LABELS = {
  'project.create': 'created a project', 'project.archive': 'archived a project', 'project.restore': 'restored a project',
  'project.delete': 'deleted a project', 'project.status_change': 'changed a project status', 'idea.convert': 'turned an idea into a project', 'lifearea.create': 'added a life area', 'lifearea.update': 'updated a life area',
  'lifearea.archive': 'archived a life area', 'lifearea.restore': 'restored a life area', 'workspace.create': 'created this workspace',
  'invitation.create': 'invited someone', 'invitation.accept': 'joined the workspace', 'member.role_change': 'changed a role',
  'member.remove': 'removed a member', 'member.leave': 'left the workspace', 'workspace.rename': 'renamed the workspace',
};

export default function DashboardPage() {
  const { user, active } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.dashboard().then(setData).catch((err) => setError(err.message));
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

          <div className="dash-grid">
            <section className="panel" aria-labelledby="dash-projects">
              <div className="panel__title"><h2 id="dash-projects">Recent projects</h2><Link to="/projects">View all</Link></div>
              {data.recentProjects.length === 0 ? (
                <p className="muted">No projects yet. <Link to="/projects">Create your first project.</Link></p>
              ) : data.recentProjects.map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="row-link">
                  <span className="dot" style={{ background: p.color }} aria-hidden="true" />
                  <span><b>{p.name}</b><small>{p.life_area_name || 'No life area'} · {p.card_count} tasks</small></span>
                </Link>
              ))}
            </section>

            <section className="panel" aria-labelledby="dash-areas">
              <div className="panel__title"><h2 id="dash-areas">Life areas</h2><Link to="/life-areas">Manage</Link></div>
              <ul className="area-list">
                {data.lifeAreas.map((a) => (
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
                    <li key={i}><b>{a.user_name || 'Someone'}</b> {ACTION_LABELS[a.action] || a.action}
                      <small>{new Date(a.created_at).toLocaleString()}</small></li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel panel--note" aria-labelledby="dash-soon">
              <div className="panel__title"><h2 id="dash-soon">Coming next</h2></div>
              <p className="muted">My Day, Calendar, Finance, Notes and the AI Assistant are planned but not built yet. They are shown disabled in the sidebar and will appear here as they ship.</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
