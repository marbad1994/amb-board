import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, TriangleAlert } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import EventModal from '../components/EventModal.jsx';
import TimeGrid from '../components/TimeGrid.jsx';

const KIND_LABEL = { appointment: 'Appointment', personal: 'Personal', task_due: 'Task due', project_deadline: 'Deadline', milestone: 'Milestone' };
const pad = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const addMonths = (d, n) => { const [y, m] = d.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}-01`; };
const today = () => new Date().toISOString().slice(0, 10);
const mondayOf = (d) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const long = (d, opts) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });

// visible dates and fetch range for each view
function rangeFor(view, cursor) {
  if (view === 'day') return [cursor];
  if (view === 'week') { const s = mondayOf(cursor); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); }
  const first = `${cursor.slice(0, 7)}-01`;
  const s = mondayOf(first);
  return Array.from({ length: 42 }, (_, i) => addDays(s, i));
}

export default function CalendarPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [cursor, setCursor] = useState(today());
  const [view, setView] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 600 ? 'agenda' : 'month')); // a phone cannot read a month grid
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [filter, setFilter] = useState('all');
  const location = useLocation();
  const navigate = useNavigate();
  // "Edit first" from the assistant: open the new-event form with the proposed values filled in
  useEffect(() => {
    const pre = location.state?.prefillEvent;
    if (pre) { setModal({ date: pre.start_local?.slice(0, 10) || today(), prefill: pre }); navigate('/calendar', { replace: true, state: null }); }
  }, [location.state, navigate]);

  const dates = rangeFor(view, cursor);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const load = useCallback(() => {
    api.calendar(from, to).then((r) => { setData(r); setError(''); }).catch((err) => setError(err.message));
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const shift = (n) => setCursor((c) => (view === 'day' ? addDays(c, n) : view === 'week' ? addDays(c, 7 * n) : addMonths(c, n)));
  const items = (data?.items || []).filter((i) => filter === 'all' || i.kind === filter);
  const byDate = {};
  for (const i of items) (byDate[i.date] ||= []).push(i);
  const pressure = new Set((data?.pressure || []).map((p) => p.date));
  const month = cursor.slice(0, 7);
  const label = view === 'day' ? long(cursor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : view === 'week' ? `${long(from, { day: 'numeric', month: 'short' })} - ${long(to, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : long(`${month}-01`, { month: 'long', year: 'numeric' });

  const chip = (i) => {
    const time = i.source === 'event' && !i.all_day ? `${i.start_local.slice(11, 16)} ` : '';
    const text = `${time}${i.title}`;
    const cls = `cal-chip cal-chip--${i.kind}${i.done ? ' is-done' : ''}`;
    const inner = <><span className={`cal-chip__kind${view === 'month' ? ' sr-only' : ''}`}>{KIND_LABEL[i.kind]}</span> {text}{i.recurring && ' (repeats)'}{i.reminder_minutes != null && ' (reminder)'}</>;
    const title = `${KIND_LABEL[i.kind]}: ${text}`;
    if (i.source === 'event') return <button key={i.id} type="button" className={cls} title={title} onClick={() => setModal({ event: i, date: i.date })}>{inner}</button>;
    return <Link key={i.id} className={cls} title={title} to={i.source === 'task' ? `/projects/${i.project_id}?card=${i.card_id}` : i.source === 'goal' ? '/goals' : `/projects/${i.project_id}`}>{inner}</Link>;
  };

  const dayCell = (d, extra = '') => (
    <div key={d} role="gridcell" className={`cal-day ${extra} ${view === 'month' && d.slice(0, 7) !== month ? 'is-outside' : ''} ${d === today() ? 'is-today' : ''} ${pressure.has(d) ? 'is-pressure' : ''}`}>
      <div className="cal-day__num">{view === 'month' ? Number(d.slice(8)) : long(d, { weekday: 'short', day: 'numeric' })}{pressure.has(d) && <span className="sr-only"> heavy day</span>}</div>
      {(byDate[d] || []).map(chip)}
      {writable && view !== 'month' && <button type="button" className="cal-add" aria-label={`Add event on ${d}`} onClick={() => setModal({ date: d })}><Plus size={12} aria-hidden="true" /></button>}
    </div>
  );

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">PLANNING</div>
          <h1>Calendar</h1>
          <p className="page-sub">Appointments, task due dates, milestones and project deadlines in one place. Deadlines and due dates come from your projects and tasks; change them there.</p>
        </div>
        {writable && <button type="button" className="btn btn-primary" onClick={() => setModal({ date: cursor })}><Plus size={16} aria-hidden="true" /> New event</button>}
      </div>

      <div className="filter-row">
        <div className="inline-form">
          <button type="button" className="btn btn-icon" onClick={() => shift(-1)} aria-label={`Previous ${view === 'agenda' ? 'month' : view}`}><ChevronLeft size={16} /></button>
          <strong aria-live="polite" style={{ minWidth: 190, textAlign: 'center' }}>{label}</strong>
          <button type="button" className="btn btn-icon" onClick={() => shift(1)} aria-label={`Next ${view === 'agenda' ? 'month' : view}`}><ChevronRight size={16} /></button>
          <button type="button" className="btn" onClick={() => setCursor(today())}>Today</button>
        </div>
        <div className="seg" role="group" aria-label="View">
          {['month', 'week', 'day', 'agenda'].map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
        </div>
        <label>Show <select aria-label="Filter calendar" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">Everything</option>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {pressure.size > 0 && (
        <p className="notice"><TriangleAlert size={14} aria-hidden="true" /> Heavy days (something due plus 3+ appointments): {[...pressure].join(', ')}. Consider moving flexible items; nothing has been changed for you.</p>
      )}

      {view === 'month' && (
        <div className="cal-grid" role="grid" aria-label={label}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="cal-head" role="columnheader">{d}</div>)}
          {dates.map((d) => dayCell(d))}
        </div>
      )}
      {(view === 'week' || view === 'day') && (
        <TimeGrid dates={dates} byDate={byDate} today={today()} label={label} pressure={pressure} writable={writable} chip={chip} longDate={long}
          onAdd={(d, hour) => setModal({ date: d, prefill: hour == null ? undefined : { start_local: `${d}T${pad(hour)}:00` } })}
          onOpen={(i) => setModal({ event: i, date: i.date })} />
      )}
      {view === 'agenda' && (
        <section className="panel">
          {items.filter((i) => i.date.slice(0, 7) === month).length === 0 && <p className="muted">Nothing scheduled in {label}.</p>}
          {Object.entries(byDate).filter(([d]) => d.slice(0, 7) === month).map(([d, list]) => (
            <div key={d} className="agenda-day"><h3>{long(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>{list.map(chip)}</div>
          ))}
        </section>
      )}

      {modal && <EventModal event={modal.event} prefill={modal.prefill} date={modal.date} writable={writable} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}
