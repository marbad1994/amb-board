import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CalendarDays, Check, ChevronDown, ChevronUp, Flame, FolderKanban, Lightbulb, Layers, ListChecks, Sparkles, Swords, Target, TriangleAlert, Wallet, Activity, Plus } from 'lucide-react';
import { fmt } from '../../lib/money.js';
import { LifeAreaIcon } from '../../lib/lifeAreaIcons.jsx';
import AiSummaryCard from '../AiSummaryCard.jsx';
import { api } from '../../api/client.js';

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
const ROWS = { hero: 8, normal: 4, compact: 4 };
const BUDGET_TEXT = { warning: 'Approaching limit', forecast_over: 'Forecast over budget', over: 'Over budget' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const todayIso = () => new Date().toISOString().slice(0, 10);

function Bar({ pct, label, tone }) {
  const v = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return <div className={`dw-bar-track${tone ? ` dw-bar-track--${tone}` : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={label}><span style={{ width: `${v}%` }} /></div>;
}

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

// Habits can be ticked right here; the page keeps one copy of the data so the tiles and the arrangement notes stay true.
function HabitsBody({ data, size, writable, patch }) {
  const [err, setErr] = useState('');
  const list = data.habits; const done = list.filter((h) => h.done_today).length;
  const toggle = async (h) => {
    setErr('');
    const next = !h.done_today;
    patch((d) => ({ ...d, habits: d.habits.map((x) => (x.id === h.id ? { ...x, done_today: next, streak: Math.max(0, x.streak + (next ? 1 : -1)) } : x)) }));
    try { const r = await api.checkHabit(h.id, todayIso(), next); patch((d) => ({ ...d, habits: d.habits.map((x) => (x.id === h.id ? { ...x, done_today: r.done_today, done_this_week: r.done_this_week, streak: r.streak.current, longest_streak: r.streak.longest } : x)) })); }
    catch (e) { setErr(e.message); patch((d) => ({ ...d, habits: d.habits.map((x) => (x.id === h.id ? h : x)) })); }
  };
  if (!list.length) return <p className="muted">No habits yet. <Link to="/goals">Start one.</Link></p>;
  return (
    <>
      <div className="dw-meter"><b>{done} of {list.length}</b><span>done today</span></div>
      <Bar pct={(done / list.length) * 100} label="Habits done today" />
      <ul className={`dw-habits${size === 'hero' ? ' dw-habits--two' : ''}`}>
        {list.slice(0, ROWS[size] + 2).map((h) => (
          <li key={h.id}>
            <button type="button" className={`dw-check${h.done_today ? ' is-done' : ''}`} aria-pressed={h.done_today} disabled={!writable} onClick={() => toggle(h)}>
              <span className="dw-check__box" aria-hidden="true">{h.done_today && <Check size={14} />}</span>
              <span className="dw-check__text"><b>{h.title}</b>
                <small>{h.frequency === 'weekly' ? `${h.done_this_week} of ${h.target_per_week} this week` : h.streak > 0 ? <><Flame size={12} aria-hidden="true" /> {plural(h.streak, 'day')} in a row</> : 'Not started yet'}</small></span>
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="form-error" role="alert">{err}</p>}
    </>
  );
}

function IdeasBody({ data, size, writable, patch }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const add = async (e) => {
    e.preventDefault(); const t = text.trim(); if (!t) return;
    setBusy(true); setErr('');
    try { const n = await api.createIdea({ text: t, author: 'dashboard' }); patch((d) => ({ ...d, ideas: { total: d.ideas.total + 1, new_7d: d.ideas.new_7d + 1, latest: [n, ...d.ideas.latest].slice(0, 6) } })); setText(''); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <>
      {writable && (
        <form className="dw-quick" onSubmit={add} aria-label="Capture an idea">
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Capture an idea" aria-label="Capture an idea" />
          <button type="submit" className="btn btn-small" disabled={busy || !text.trim()}><Plus size={14} aria-hidden="true" /> Add</button>
        </form>
      )}
      {err && <p className="form-error" role="alert">{err}</p>}
      {data.ideas.latest.length === 0 ? <p className="muted">The board is empty. Anything you capture lands here first.</p> : (
        <ul className="dw-ideas">{data.ideas.latest.slice(0, ROWS[size] + 1).map((i) => <li key={i.id}><span className="dw-ideas__dot" style={{ background: i.color }} aria-hidden="true" /><span>{i.text}</span><small>{relTime(i.created_at)}</small></li>)}</ul>
      )}
    </>
  );
}

// id -> { title, icon, link, summary(data), body({data, size, writable, patch}) }
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
  habits: { title: 'Habits today', icon: Flame, link: ['/goals', 'All habits'],
    summary: (d) => (d.habits.length ? `${d.habits.filter((h) => h.done_today).length} of ${d.habits.length} done` : 'No habits yet'), body: HabitsBody },
  goals: { title: 'Goals', icon: Target, link: ['/goals', 'All goals'],
    summary: (d) => (d.goals.length ? `${d.goals.length} active` : 'No active goals'),
    body: ({ data, size }) => (data.goals.length === 0 ? <p className="muted">No active goals. <Link to="/goals">Set one.</Link></p> : (
      <ul className="dw-goals">{data.goals.slice(0, ROWS[size]).map((g) => (
        <li key={g.id}><div className="dw-goals__top"><Link to="/goals"><b>{g.title}</b></Link><span>{g.progress}%</span></div>
          <Bar pct={g.progress} label={`${g.title} progress`} />
          <small>{g.days_left === null ? 'No target date' : g.days_left < 0 ? <span className="is-overdue">{plural(-g.days_left, 'day')} past the target date</span> : g.days_left === 0 ? 'Target date is today' : `${plural(g.days_left, 'day')} left`}{g.next_milestone ? ` · next: ${g.next_milestone}` : ''}</small></li>
      ))}</ul>
    )) },
  challenges: { title: 'Challenges', icon: Swords, link: ['/goals', 'All challenges'],
    summary: (d) => (d.challenges.length ? `${d.challenges.length} running` : 'No challenge running'),
    body: ({ data, size }) => (data.challenges.length === 0 ? <p className="muted">No challenge is running. <Link to="/goals">Start one.</Link></p> : (
      <ul className="dw-goals">{data.challenges.slice(0, ROWS[size]).map((c) => (
        <li key={c.id}><div className="dw-goals__top"><b>{c.title}</b><span>{c.completed_days} of {c.total_days}</span></div>
          <Bar pct={c.progress} label={`${c.title} progress`} />
          <small>Day {c.elapsed_days} of {c.total_days}{c.days_left === 0 ? ' · last day' : ` · ${plural(c.days_left, 'day')} left`}</small></li>
      ))}</ul>
    )) },
  money: { title: 'Money this month', icon: Wallet, link: ['/finance', 'Finance'],
    summary: (d) => (d.money ? `${fmt(d.money.spent_minor, d.money.currency)} spent${d.money.used_pct !== null ? `, ${d.money.used_pct}% of budget` : ''}` : 'Nothing tracked this month'),
    body: ({ data, size }) => {
      const m = data.money;
      if (!m && data.budgetAlerts.length === 0) return <p className="muted">Nothing recorded this month. <Link to="/finance">Add a transaction.</Link></p>;
      const tone = m?.used_pct >= 100 ? 'danger' : m?.used_pct >= 80 ? 'warn' : '';
      const max = Math.max(1, ...(m?.top || []).map((t) => t.total_minor));
      return (
        <>
          {m && (
            <>
              <div className="dw-money"><b>{fmt(m.spent_minor, m.currency)}</b><span>spent{m.income_minor ? ` · ${fmt(m.income_minor, m.currency)} in` : ''}</span></div>
              {m.used_pct !== null && (<><Bar pct={m.used_pct} tone={tone} label="Share of the monthly budget used" /><p className="dw-note">{m.used_pct}% of your {fmt(m.budget_minor, m.currency)} budget{m.used_pct >= 100 ? ', over' : ''}</p></>)}
              {m.top.length > 0 && size !== 'compact' && (
                <ul className="dw-cats">{m.top.map((t) => <li key={t.name}><span>{t.name}</span><Bar pct={(t.total_minor / max) * 100} label={`${t.name} share`} /><b>{fmt(t.total_minor, m.currency)}</b></li>)}</ul>
              )}
            </>
          )}
          {data.budgetAlerts.length > 0 && (
            <ul className="plain-list dw-alerts" aria-label="Budget alerts">
              {data.budgetAlerts.slice(0, ROWS[size]).map((a) => (
                <li key={a.project_id}><Link to={`/projects/${a.project_id}`}>{a.project_name}</Link>
                  <span>{BUDGET_TEXT[a.status]}: {fmt(a.actual_minor, a.currency)} of {fmt(a.approved_minor, a.currency)} spent{a.forecast_overrun_minor > 0 ? `, forecast overrun ${fmt(a.forecast_overrun_minor, a.currency)}` : ''}</span></li>
              ))}
            </ul>
          )}
        </>
      );
    } },
  ideas: { title: 'Idea board', icon: Lightbulb, link: ['/ideas', 'Open board'],
    summary: (d) => (d.ideas.total ? `${plural(d.ideas.total, 'idea')}${d.ideas.new_7d ? `, ${d.ideas.new_7d} new this week` : ''}` : 'No ideas yet'), body: IdeasBody },
  briefing: { title: 'Daily briefing', icon: Sparkles, bare: true,
    summary: (d) => (d.counts.openTasks ? `${d.counts.openTasks} open tasks to brief on` : 'Nothing to brief yet'),
    body: ({ writable }) => <AiSummaryCard kind="daily" writable={writable} title="Daily briefing" brief /> },
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
        <ul className="area-list">{used.slice(0, ROWS[size] + 2).map((a) => <li key={a.id}><Link to={`/projects?lifeArea=${a.id}`}><LifeAreaIcon name={a.icon} size={16} /><span>{a.name}</span><b>{a.project_count}</b></Link></li>)}</ul>
      );
    } },
  activity: { title: 'Recent activity', icon: Activity,
    summary: (d) => (d.activity.length ? `Last change ${relTime(d.activity[0].created_at)}` : 'No activity yet'),
    body: ({ data, size }) => (data.activity.length === 0 ? <p className="muted">No activity yet.</p> : (
      <ul className="activity dw-rows">{data.activity.slice(0, ROWS[size] + 1).map((a, i) => (
        <li key={i}><span><b>{a.user_name || 'Someone'}</b> {humanAction(a.action)}</span><small title={new Date(a.created_at).toLocaleString()}>{relTime(a.created_at)}</small></li>
      ))}</ul>
    )) },
};

// One widget. hero and normal show their content; compact shows one line and opens on request.
export function Widget({ id, size, reason, data, writable, patch }) {
  const w = WIDGETS[id]; const Icon = w.icon; const Body = w.body;
  const [open, setOpen] = useState(false);
  const small = size === 'compact' && !open;
  const heading = `dw-h-${id}`; const shown = size === 'compact' ? 'normal' : size;
  if (w.bare && !small && size !== 'compact') return <div className={`dw dw--${size} dw--bare`} data-widget={id} data-size={size}><Body data={data} size={size} writable={writable} patch={patch} /></div>;
  return (
    <section className={`dw dw--${size === 'compact' && open ? 'normal' : size} ${small ? 'dw--small' : 'panel'}`} aria-labelledby={heading} data-widget={id} data-size={size}>
      <div className="dw__head">
        <span className="dw__icon" aria-hidden="true"><Icon size={16} /></span>
        <h2 id={heading}>{w.title}</h2>
        {small ? <span className="dw__line">{reason || w.summary(data)}</span> : w.link && <Link to={w.link[0]}>{w.link[1]}</Link>}
        {size === 'compact' && (
          <button type="button" className="dw__toggle" aria-expanded={open} aria-controls={`dw-b-${id}`} onClick={() => setOpen(!open)}>
            {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}<span className="sr-only">{open ? `Collapse ${w.title}` : `Show ${w.title}`}</span>
          </button>
        )}
      </div>
      {size === 'hero' && reason && <p className="dw__why"><CalendarDays size={14} aria-hidden="true" /> {reason}</p>}
      {!small && <div id={`dw-b-${id}`} className="dw__body"><Body data={data} size={shown} writable={writable} patch={patch} /></div>}
    </section>
  );
}
