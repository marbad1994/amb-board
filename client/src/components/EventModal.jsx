import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api/client.js';

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

// event: existing event item (has event_id) or null for new. date: preselected YYYY-MM-DD.
export default function EventModal({ event, date, writable, onClose, onSaved }) {
  const editing = !!event;
  const [projects, setProjects] = useState([]);
  const [f, setF] = useState(() => ({
    title: event?.title || '', kind: event?.kind === 'personal' ? 'personal' : 'appointment', all_day: event?.all_day || false,
    // when editing, use the stored series (not the clicked occurrence) so a repeating event keeps its start
    start: event ? (event.all_day ? '09:00' : event.series_start.slice(11, 16)) : '09:00',
    startDate: event ? event.series_start.slice(0, 10) : date,
    endTime: event?.series_end && !event.all_day ? event.series_end.slice(11, 16) : '',
    timezone: event?.timezone || browserTz(),
    recurrence: event?.recurrence || 'none', interval: event?.recurrence_interval || 1, until: event?.recurrence_until || '',
    projectId: event?.project_id || '', description: event?.description || '',
    reminder: event?.reminder_minutes != null ? String(event.reminder_minutes) : '',
  }));
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  useEffect(() => { api.listProjects().then(setProjects).catch(() => {}); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const body = {
      title: f.title, kind: f.kind, all_day: f.all_day, timezone: f.timezone, description: f.description,
      start_local: f.all_day ? f.startDate : `${f.startDate}T${f.start}`,
      end_local: f.all_day ? (event?.series_end || null) : (f.endTime ? `${f.startDate}T${f.endTime}` : null),
      recurrence: f.recurrence, recurrence_interval: Number(f.interval) || 1, recurrence_until: f.until || null, projectId: f.projectId || null,
      reminder_minutes: !f.all_day && f.reminder !== '' ? Number(f.reminder) : null,
    };
    if (editing && event.all_day && !event.series_end) body.end_local = null;
    try {
      if (editing) await api.updateEvent(event.event_id, body); else await api.createEvent(body);
      onSaved();
    } catch (err) { setError(err.message); }
  };

  const remove = async () => {
    if (!window.confirm(event.recurring ? 'Delete this event and ALL its repeats?' : 'Delete this event?')) return;
    try { await api.deleteEvent(event.event_id); onSaved(); } catch (err) { setError(err.message); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={editing ? 'Edit event' : 'New event'} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal__header">
          <h2>{editing ? 'Edit event' : 'New event'}</h2>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal__body">
          <fieldset disabled={!writable} className="plain-fieldset">
            <div className="field"><label htmlFor="ev-title">Title</label>
              <input id="ev-title" type="text" required maxLength={200} autoFocus value={f.title} onChange={set('title')} /></div>
            <div className="two-col">
              <div className="field"><label htmlFor="ev-kind">Type</label>
                <select id="ev-kind" value={f.kind} onChange={set('kind')}><option value="appointment">Appointment</option><option value="personal">Personal event</option></select></div>
              <div className="field"><label htmlFor="ev-date">Date</label>
                <input id="ev-date" type="date" required value={f.startDate} onChange={set('startDate')} /></div>
            </div>
            <label className="check"><input type="checkbox" checked={f.all_day} onChange={set('all_day')} /> All day</label>
            {!f.all_day && (
              <div className="two-col">
                <div className="field"><label htmlFor="ev-start">Starts</label><input id="ev-start" type="time" required value={f.start} onChange={set('start')} /></div>
                <div className="field"><label htmlFor="ev-end">Ends</label><input id="ev-end" type="time" value={f.endTime} onChange={set('endTime')} /></div>
              </div>
            )}
            <div className="field"><label htmlFor="ev-tz">Time zone</label>
              <input id="ev-tz" type="text" required value={f.timezone} onChange={set('timezone')} />
              <small className="hint">The wall-clock time is kept when daylight saving changes.</small></div>
            {!editing && (
              <div className="two-col">
                <div className="field"><label htmlFor="ev-rec">Repeats</label>
                  <select id="ev-rec" value={f.recurrence} onChange={set('recurrence')}>
                    <option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></div>
                {f.recurrence !== 'none' && <div className="field"><label htmlFor="ev-until">Until</label><input id="ev-until" type="date" value={f.until} onChange={set('until')} /></div>}
              </div>
            )}
            {editing && event.recurring && <p className="hint">Edits change the whole series. Recurrence settings can be changed by recreating the event.</p>}
            {!f.all_day && (
              <div className="field"><label htmlFor="ev-rem">Reminder</label>
                <select id="ev-rem" value={f.reminder} onChange={set('reminder')}>
                  <option value="">No reminder</option><option value="0">At start time</option><option value="10">10 minutes before</option>
                  <option value="30">30 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></select>
                <small className="hint">Shown in the notification bell for everyone in the workspace.</small></div>
            )}
            <div className="field"><label htmlFor="ev-project">Linked project</label>
              <select id="ev-project" value={f.projectId} onChange={set('projectId')}><option value="">None</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          </fieldset>
          {error && <p className="form-error" role="alert">{error}</p>}
          {writable && <button type="submit" className="btn btn-primary btn-block">{editing ? 'Save' : 'Add event'}</button>}
          {writable && editing && <button type="button" className="btn btn-danger btn-block" style={{ marginTop: 8 }} onClick={remove}>Delete</button>}
        </div>
      </form>
    </div>
  );
}
