import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, TriangleAlert } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import EventModal from '../components/EventModal.jsx';

const KIND_LABEL = { appointment: 'Appointment', personal: 'Personal', task_due: 'Task due', project_deadline: 'Deadline', milestone: 'Milestone' };
const pad = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

function gridFor(month) { // month 'YYYY-MM' -> 42 dates starting on Monday
  const first = `${month}-01`;
  const dow = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(first, -dow);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export default function CalendarPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [view, setView] = useState('month');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // { event?, date }
  const [filter, setFilter] = useState('all');

  const dates = gridFor(month);
  const load = useCallback(() => {
    const d = gridFor(month);
    api.calendar(d[0], d[41]).then((r) => { setData(r); setError(''); }).catch((err) => setError(err.message));
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const shift = (n) => {
    const [y, m] = month.split('-').map(Number);
    const t = y * 12 + (m - 1) + n;
    setMonth(`${Math.floor(t / 12)}-${pad((t % 12) + 1)}`);
  };

  const items = (data?.items || []).filter((i) => filter === 'all' || i.kind === filter);
  const byDate = {};
  for (const i of items) (byDate[i.date] ||= []).push(i);
  const pressure = new Set((data?.pressure || []).map((p) => p.date));
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const chip = (i) => {
    const time = i.source === 'event' && !i.all_day ? `${i.start_local.slice(11, 16)} ` : '';
    const text = `${time}${i.title}`;
    const cls = `cal-chip cal-chip--${i.kind}${i.done ? ' is-done' : ''}`;
    const inner = <><span className="cal-chip__kind">{KIND_LABEL[i.kind]}</span> {text}{i.recurring && ' (repeats)'}</>;
    if (i.source === 'event') return <button key={i.id} type="button" className={cls} title={`${KIND_LABEL[i.kind]}: ${text}`} onClick={() => setModal({ event: i, date: i.date })}>{inner}</button>;
    return <Link key={i.id} className={cls} title={`${KIND_LABEL[i.kind]}: ${text}`} to={i.source === 'task' ? `/projects/${i.project_id}?card=${i.card_id}` : i.source === 'goal' ? '/goals' : `/projects/${i.project_id}`}>{inner}</Link>;
  };

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">PLANNING</div>
          <h1>Calendar</h1>
          <p className="page-sub">Appointments, task due dates and project deadlines in one place. Deadlines and due dates come from your projects and tasks; change them there.</p>
        </div>
        {writable && <button type="button" className="btn btn-primary" onClick={() => setModal({ date: today() })}><Plus size={16} aria-hidden="true" /> New event</button>}
      </div>

      <div className="filter-row">
        <div className="inline-form">
          <button type="button" className="btn btn-icon" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
          <strong aria-live="polite" style={{ minWidth: 150, textAlign: 'center' }}>{label}</strong>
          <button type="button" className="btn btn-icon" onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={16} /></button>
          <button type="button" className="btn" onClick={() => setMonth(today().slice(0, 7))}>Today</button>
        </div>
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>Month</button>
          <button type="button" aria-pressed={view === 'agenda'} onClick={() => setView('agenda')}>Agenda</button>
        </div>
        <label>Show <select aria-label="Filter calendar" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">Everything</option>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {pressure.size > 0 && (
        <p className="notice"><TriangleAlert size={14} aria-hidden="true" /> Heavy days (something due plus 3+ appointments): {[...pressure].join(', ')}. Consider moving flexible items; nothing has been changed for you.</p>
      )}

      {view === 'month' ? (
        <div className="cal-grid" role="grid" aria-label={label}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="cal-head" role="columnheader">{d}</div>)}
          {dates.map((d) => (
            <div key={d} role="gridcell" className={`cal-day ${d.slice(0, 7) !== month ? 'is-outside' : ''} ${d === today() ? 'is-today' : ''} ${pressure.has(d) ? 'is-pressure' : ''}`}>
              <div className="cal-day__num">{Number(d.slice(8))}{pressure.has(d) && <span className="sr-only"> heavy day</span>}</div>
              {(byDate[d] || []).map(chip)}
            </div>
          ))}
        </div>
      ) : (
        <section className="panel">
          {items.filter((i) => i.date.slice(0, 7) === month).length === 0 && <p className="muted">Nothing scheduled in {label}.</p>}
          {Object.entries(byDate).filter(([d]) => d.slice(0, 7) === month).map(([d, list]) => (
            <div key={d} className="agenda-day"><h3>{new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</h3>{list.map(chip)}</div>
          ))}
        </section>
      )}

      {modal && <EventModal event={modal.event} date={modal.date} writable={writable} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}
