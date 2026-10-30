import { useEffect, useState } from 'react';
import { FolderKanban, ListChecks, CalendarCheck, TriangleAlert, Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import { Widget, WIDGETS, relTime } from '../components/dashboard/widgets.jsx';

const SIZE_TEXT = { hero: 'Larger', normal: 'Normal', compact: 'Quiet' };
// If the arrangement cannot be fetched the dashboard still works: every widget at normal size in a fixed order.
const FALLBACK = { source: 'fallback', headline: '', widgets: ['attention', 'today', 'events', 'budget', 'briefing', 'projects', 'areas', 'activity'].map((id) => ({ id, size: 'normal', reason: '' })) };

function Skeleton() {
  return (
    <div className="dw-skeleton" aria-busy="true" aria-label="Loading your dashboard">
      {[0, 1, 2, 3].map((i) => <div key={i} className="dw-skeleton__box" />)}
    </div>
  );
}

export default function DashboardPage() {
  const { user, active } = useAuth();
  const [data, setData] = useState(null);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const writable = canWrite(active?.role);

  useEffect(() => {
    api.dashboard().then(setData).catch((err) => setError(err.message));
    api.dashboardPlan().then(setPlan).catch(() => setPlan(FALLBACK));
  }, []);

  const rearrange = async () => {
    setBusy(true); setNote('');
    try { const p = await api.refreshDashboardPlan(); setPlan(p); setNote(p.source === 'ai' ? 'Rearranged.' : 'The AI could not be reached, so the simple rules arranged it.'); } catch (err) { setNote(err.message); } finally { setBusy(false); }
  };

  const c = data?.counts;
  const stats = data && [
    { label: 'Active projects', value: c.activeProjects, icon: FolderKanban, sub: `${c.archivedProjects} archived` },
    { label: 'Open tasks', value: c.openTasks, icon: ListChecks, sub: `${c.tasks} total` },
    { label: 'Due today', value: c.dueToday, icon: CalendarCheck, sub: c.dueToday ? 'On your boards' : 'Nothing due' },
    { label: 'Overdue', value: c.overdueTasks, icon: TriangleAlert, sub: c.overdueTasks ? 'Needs attention' : 'Nothing late', alert: c.overdueTasks > 0 },
  ];

  const items = plan?.widgets || [];
  const heroes = items.filter((w) => w.size === 'hero'); const normals = items.filter((w) => w.size === 'normal'); const quiet = items.filter((w) => w.size === 'compact');
  const render = (w) => <Widget key={w.id} id={w.id} size={w.size} reason={w.reason} data={data} writable={writable} />;

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">{active?.name?.toUpperCase()}</div>
          <h1>Hello, {user?.name?.split(' ')[0]}</h1>
          <p className="page-sub">{plan?.headline || 'Your workspace at a glance. Figures below come from your saved records.'}</p>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <Skeleton />}

      {data && (
        <>
          <div className="stat-grid">
            {stats.map(({ label, value, icon: Icon, sub, alert }) => (
              <div key={label} className={`stat-card${alert ? ' stat-card--alert' : ''}`}>
                <div className="stat-card__head"><span>{label}</span><span className="stat-card__icon"><Icon size={18} aria-hidden="true" /></span></div>
                <div className="stat-card__num">{value}</div>
                <div className="stat-card__sub">{sub}</div>
              </div>
            ))}
          </div>

          {!plan ? <Skeleton /> : (
            <>
              <div className="dw-bar">
                <p className="dw-bar__who">
                  <Sparkles size={14} aria-hidden="true" />
                  {plan.source === 'ai' ? 'Arranged for today by the AI' : plan.source === 'rules' ? 'Arranged for today by simple rules' : 'Standard layout'}
                  {plan.generated_at && <span className="muted"> · {relTime(plan.generated_at)}</span>}
                  {plan.adjusted && <span className="muted"> · adjusted for what changed since</span>}
                </p>
                {writable && plan.ai_available && plan.refreshes_left !== undefined && (
                  <button type="button" className="btn btn-small" onClick={rearrange} disabled={busy || plan.refreshes_left === 0} title={plan.refreshes_left === 0 ? 'You can rearrange 5 times a day' : undefined}>
                    {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Rearrange ({plan.refreshes_left} left)
                  </button>
                )}
              </div>
              <p className="sr-only" role="status">{note}</p>
              {note && <p className="hint" aria-hidden="true">{note}</p>}
              {plan.source !== 'fallback' && (
                <details className="dw-why">
                  <summary>Why this layout</summary>
                  <ul>{items.map((w) => <li key={w.id}><b>{WIDGETS[w.id].title}</b> <span className={`dw-tag dw-tag--${w.size}`}>{SIZE_TEXT[w.size]}</span> {w.reason}</li>)}</ul>
                  <p className="hint">Nothing is ever removed: quiet parts shrink to one line and open with a click. A part that gets something new during the day grows again.</p>
                </details>
              )}

              {heroes.length > 0 && <div className="dw-heroes">{heroes.map(render)}</div>}
              {normals.length > 0 && <div className="dw-grid">{normals.map(render)}</div>}
              {quiet.length > 0 && (
                <section className="dw-quiet" aria-label="Quiet today">
                  <h2 className="dw-quiet__title">Quiet today</h2>
                  <div className="dw-quiet__list">{quiet.map(render)}</div>
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
