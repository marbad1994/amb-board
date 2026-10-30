import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CalendarDays, ChevronDown, ChevronUp, FolderKanban, Layers, ListChecks, Sparkles, TriangleAlert, Wallet, Activity } from 'lucide-react';
import { fmt } from '../../lib/money.js';
import { LifeAreaIcon } from '../../lib/lifeAreaIcons.jsx';
import AiSummaryCard from '../AiSummaryCard.jsx';

const ACTION_LABELS = {
  'project.create': 'created a project', 'project.archive': 'archived a project', 'project.restore': 'restored a project',
  'project.delete': 'deleted a project', 'project.status_change': 'changed a project status', 'idea.convert': 'turned an idea into a project', 'ai.project_summary': 'generated an AI project summary', 'ai.action_executed': 'approved an AI suggestion', 'ai.action_rejected': 'rejected an AI suggestion', 'transaction.create': 'recorded a transaction', 'transaction.void': 'voided a transaction', 'budget.set': 'set a project budget', 'event.create': 'added a calendar event', 'event.update': 'updated a calendar event', 'event.delete': 'deleted a calendar event', 'lifearea.create': 'added a life area', 'lifearea.update': 'updated a life area',
  'lifearea.archive': 'archived a life area', 'lifearea.restore': 'restored a life area', 'workspace.create': 'created this workspace',
  'invitation.create': 'invited someone', 'invitation.accept': 'joined the workspace', 'member.role_change': 'changed a role',
  'member.remove': 'removed a member', 'member.leave': 'left the workspace', 'workspace.rename': 'renamed the workspace',
};
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
export function relTime(iso) {
  const d = new Date(iso); const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  const y = new Date(); y.setDate(y.getDate() - 1);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === y.toDateString() ? `Yesterday, ${t}` : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const ROWS = { hero: 10, normal: 5, compact: 5 };
const BUDGET_TEXT = { warning: 'Approaching limit', forecast_over: 'Forecast over budget', over: 'Over budget' };

function TaskRows({ rows, kind, limit }) {
  return (
    <ul className="activity dw-rows">
      {rows.slice(0, limit).map((t) => (
        <li key={t.id}><Link to={`/projects/${t.project_id}?card=${t.id}`}><b>{t.title}</b></Link>
          <small>{kind === 'overdue' ? <span className="is-overdue">Overdue since {dueLabel(t.due_date)}</span> : 'Due today'} · {t.project_name}</small></li>
      ))}
    </ul>
  );
}

// id -> { title, icon, link, summary(data) -> the one line shown while small, body({data, size, ...}) }
export const WIDGETS = {
  today: { title: 'Due today', icon: ListChecks, link: ['/tasks', 'All tasks'],
    summary: (d) => (d.counts.dueToday ? `${d.counts.dueToday} due today` : 'Nothing is due today'),
    body: ({ data, size }) => (data.dueTodayList.length === 0 ? <p className="muted">Nothing is due today.</p> : <TaskRows rows={data.dueTodayList} kind="today" limit={ROWS[size]} />) },
  attention: { title: 'Needs attention', icon: TriangleAlert, link: ['/tasks', 'All tasks'],
    summary: (d) => (d.counts.overdueTasks ? `${d.counts.overdueTasks} overdue` : 'Nothing is overdue'),
    body: ({ data, size }) => (data.overdueList.length === 0 ? <p className="muted">Nothing is overdue. Nice work.</p> : (
      <>
        <TaskRows rows={data.overdueList} kind="overdue" limit={ROWS[size]} />
        {data.counts.overdueTasks > Math.min(ROWS[size], data.overdueList.length) && <p className="hint"><Link to="/tasks">{data.counts.overdueTasks - Math.min(ROWS[size], data.overdueList.length)} more overdue</Link></p>}
      </>
    )) },
  events: { title: 'Upcoming events', icon: CalendarClock, link: ['/calendar', 'Calendar'],
    summary: (d) => (d.upcomingEvents.length ? `${d.upcomingEvents.length} in the next 7 days` : 'Nothing in the next 7 days'),
    body: ({ data, size }) => (data.upcomingEvents.length === 0 ? <p className="muted">Nothing in the next 7 days.</p> : (
      <ul className="activity dw-rows">{data.upcomingEvents.slice(0, ROWS[size]).map((e) => <li key={e.id}><b>{e.title}</b><small>{eventWhen(e)}</small></li>)}</ul>
    )) },
  budget: { title: 'Budget alerts', icon: Wallet, link: ['/finance', 'Finance'],
    summary: (d) => (d.budgetAlerts.length ? `${d.budgetAlerts.length} to look at` : 'No budget alerts'),
    body: ({ data, size }) => (data.budgetAlerts.length === 0 ? <p className="muted">No project is near or over its budget.</p> : (
      <ul className="plain-list">
        {data.budgetAlerts.slice(0, ROWS[size]).map((a) => (
          <li key={a.project_id}><Link to={`/projects/${a.project_id}`}>{a.project_name}</Link>
            <span>{BUDGET_TEXT[a.status]}: {fmt(a.actual_minor, a.currency)} of {fmt(a.approved_minor, a.currency)} spent{a.forecast_overrun_minor > 0 ? `, forecast overrun ${fmt(a.forecast_overrun_minor, a.currency)}` : ''}</span></li>
        ))}
      </ul>
    )) },
  briefing: { title: 'Daily briefing', icon: Sparkles, bare: true,
    summary: (d) => (d.counts.openTasks ? `${d.counts.openTasks} open tasks to brief on` : 'Nothing to brief yet'),
    body: ({ writable }) => <AiSummaryCard kind="daily" writable={writable} title="Daily briefing" /> },
  projects: { title: 'Recent projects', icon: FolderKanban, link: ['/projects', 'View all'],
    summary: (d) => (d.counts.activeProjects ? `${d.counts.activeProjects} active` : 'No project yet'),
    body: ({ data, size }) => (data.recentProjects.length === 0 ? <p className="muted">No projects yet. <Link to="/projects">Create your first project.</Link></p> : (
      data.recentProjects.slice(0, ROWS[size]).map((p) => (
        <Link key={p.id} to={`/projects/${p.id}`} className="row-link">
          <span className="dot" style={{ background: p.color }} aria-hidden="true" />
          <span><b>{p.name}</b><small>{p.life_area_name || 'No life area'} · {p.card_count} {p.card_count === 1 ? 'task' : 'tasks'}</small></span>
        </Link>
      ))
    )) },
  areas: { title: 'Life areas', icon: Layers, link: ['/life-areas', 'Manage'],
    summary: (d) => { const n = d.lifeAreas.filter((a) => a.project_count > 0).length; return n ? `${n} in use` : 'None in use yet'; },
    body: ({ data, size }) => {
      const used = [...data.lifeAreas].filter((a) => a.project_count > 0).sort((x, y) => y.project_count - x.project_count);
      return used.length === 0 ? <p className="muted">No project is assigned to a life area yet. Give a project a life area to see it here.</p> : (
        <ul className="area-list">{used.slice(0, ROWS[size] + 3).map((a) => <li key={a.id}><Link to={`/projects?lifeArea=${a.id}`}><LifeAreaIcon name={a.icon} size={16} /><span>{a.name}</span><b>{a.project_count}</b></Link></li>)}</ul>
      );
    } },
  activity: { title: 'Recent activity', icon: Activity,
    summary: (d) => (d.activity.length ? `Last change ${relTime(d.activity[0].created_at)}` : 'No activity yet'),
    body: ({ data, size }) => (data.activity.length === 0 ? <p className="muted">No activity yet.</p> : (
      <ul className="activity dw-rows">{data.activity.slice(0, ROWS[size] + 2).map((a, i) => (
        <li key={i}><span><b>{a.user_name || 'Someone'}</b> {humanAction(a.action)}</span><small title={new Date(a.created_at).toLocaleString()}>{relTime(a.created_at)}</small></li>
      ))}</ul>
    )) },
};

// One widget. hero and normal show their content; compact shows one line and opens on request.
export function Widget({ id, size, reason, data, writable }) {
  const w = WIDGETS[id]; const Icon = w.icon;
  const [open, setOpen] = useState(false);
  const small = size === 'compact' && !open;
  const heading = `dw-h-${id}`;
  if (w.bare && !small && size !== 'compact') return <div className={`dw dw--${size} dw--bare`} data-widget={id}>{w.body({ data, size, writable })}</div>;
  return (
    <section className={`dw dw--${size === 'compact' && open ? 'normal' : size} ${small ? 'dw--small' : 'panel'}`} aria-labelledby={heading} data-widget={id} data-size={size}>
      <div className="dw__head">
        <h2 id={heading}><Icon size={16} aria-hidden="true" /> {w.title}</h2>
        {small ? <span className="dw__line">{reason || w.summary(data)}</span> : w.link && <Link to={w.link[0]}>{w.link[1]}</Link>}
        {size === 'compact' && (
          <button type="button" className="dw__toggle" aria-expanded={open} aria-controls={`dw-b-${id}`} onClick={() => setOpen(!open)}>
            {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}<span className="sr-only">{open ? `Collapse ${w.title}` : `Show ${w.title}`}</span>
          </button>
        )}
      </div>
      {size === 'hero' && reason && <p className="dw__why"><CalendarDays size={14} aria-hidden="true" /> Larger today: {reason}</p>}
      {!small && <div id={`dw-b-${id}`}>{w.body({ data, size: size === 'compact' ? 'normal' : size, writable })}</div>}
    </section>
  );
}
