import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Play, Plus, Sparkles, Trash2, Workflow, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';

const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FREQ = [['daily', 'Every day'], ['weekdays', 'Every weekday (Mon to Fri)'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['once', 'Once']];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const LABEL = { create_task: 'Create a task', update_task: 'Change the triggering task', add_comment: 'Comment on the triggering task', create_transaction: 'Record a transaction',
  create_note: 'Write a note', create_event: 'Add a calendar event', notify: 'Send me a notification', generate_report: 'Generate a report' };
const REPORTS = [['overview', 'Overview'], ['monthly_finance', 'Monthly finance'], ['workload', 'Workload'], ['project_status', 'Project status']];

const DEFAULT_ARGS = {
  create_task: { project_id: '', title: '', due_in_days: '', priority: 'medium' }, update_task: { status: '', priority: '', due_in_days: '' }, add_comment: { text: '' },
  create_transaction: { type: 'expense', amount: '', currency: 'EUR', description: '', category: '', status: 'planned' }, create_note: { title: '', body: '' },
  create_event: { title: '', in_days: 1, time: '09:00', timezone: TZ, reminder_minutes: 30 }, notify: { title: '', body: '', link: '/tasks' }, generate_report: { kind: 'overview', project_id: '' },
};

const blank = () => ({ name: '', trigger: { type: 'schedule', frequency: 'weekly', weekday: 1, day: 1, date: '', time: '08:00', timezone: TZ }, steps: [{ type: 'notify', args: { ...DEFAULT_ARGS.notify } }] });

function Field({ label, children, wide }) {
  return <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}><span className="field__label">{label}</span>{children}</label>;
}

function StepFields({ step, set, projects, categories, trigger }) {
  const a = step.args; const up = (k) => (e) => set({ ...a, [k]: e.target.value });
  const projectSelect = (k) => <select value={a[k]} onChange={up(k)}><option value="">Choose a project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>;
  const days = (k, label) => <Field label={label}><input type="number" min="0" max="3650" value={a[k] ?? ''} onChange={up(k)} placeholder="no date" /></Field>;
  switch (step.type) {
    case 'create_task': return (<div className="flow-row">
      <Field label="Project">{projectSelect('project_id')}</Field><Field label="Title"><input value={a.title} onChange={up('title')} maxLength={200} placeholder="e.g. Weekly review {{date}}" /></Field>
      {days('due_in_days', 'Due in (days)')}<Field label="Priority"><select value={a.priority} onChange={up('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field></div>);
    case 'update_task': return (<div className="flow-row">
      <Field label="Set status"><select value={a.status} onChange={up('status')}><option value="">Leave as is</option>{['todo', 'doing', 'blocked', 'done'].map((s) => <option key={s}>{s}</option>)}</select></Field>
      <Field label="Set priority"><select value={a.priority} onChange={up('priority')}><option value="">Leave as is</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>{days('due_in_days', 'Due in (days)')}</div>);
    case 'add_comment': return <div className="flow-row"><Field label="Comment" wide><input value={a.text} onChange={up('text')} maxLength={2000} placeholder="e.g. Well done: {{trigger.title}}" /></Field></div>;
    case 'create_transaction': return (<div className="flow-row">
      <Field label="Type"><select value={a.type} onChange={up('type')}><option>expense</option><option>income</option></select></Field>
      <Field label="Amount"><input type="number" min="0" step="0.01" value={a.amount} onChange={up('amount')} /></Field>
      <Field label="Currency"><input value={a.currency} maxLength={3} onChange={(e) => set({ ...a, currency: e.target.value.toUpperCase() })} /></Field>
      <Field label="Description"><input value={a.description} onChange={up('description')} maxLength={200} /></Field>
      <Field label="Category"><input list="flow-cats" value={a.category} onChange={up('category')} /><datalist id="flow-cats">{categories.map((c) => <option key={c.id} value={c.name} />)}</datalist></Field>
      <Field label="Status"><select value={a.status} onChange={up('status')}><option value="planned">Planned (you confirm it)</option><option value="posted">Paid</option></select></Field></div>);
    case 'create_note': return <div className="flow-row"><Field label="Title"><input value={a.title} onChange={up('title')} maxLength={200} /></Field><Field label="Text" wide><textarea rows={2} value={a.body} onChange={up('body')} /></Field></div>;
    case 'create_event': return (<div className="flow-row"><Field label="Title"><input value={a.title} onChange={up('title')} maxLength={200} /></Field>{days('in_days', 'In (days)')}
      <Field label="Time"><input type="time" value={a.time} onChange={up('time')} /></Field><Field label="Time zone"><input value={a.timezone} onChange={up('timezone')} /></Field>
      <Field label="Remind (minutes before)"><input type="number" min="0" value={a.reminder_minutes ?? ''} onChange={up('reminder_minutes')} /></Field></div>);
    case 'notify': return (<div className="flow-row"><Field label="Title"><input value={a.title} onChange={up('title')} maxLength={200} placeholder="e.g. Plan your week" /></Field><Field label="Message"><input value={a.body} onChange={up('body')} maxLength={500} /></Field>
      <Field label="Opens"><select value={a.link} onChange={up('link')}>{[['/tasks', 'Tasks'], ['/my-day', 'My Day'], ['/finance', 'Finance'], ['/calendar', 'Calendar'], ['/reports', 'Reports'], ['/automations', 'Automations']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field></div>);
    case 'generate_report': return (<div className="flow-row"><Field label="Report"><select value={a.kind} onChange={up('kind')}>{REPORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      {a.kind === 'project_status' && <Field label="Project">{projectSelect('project_id')}</Field>}</div>);
    default: return trigger && null;
  }
}

function Builder({ initial, projects, categories, meta, onSave, onCancel }) {
  const [f, setF] = useState(initial || blank());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const t = f.trigger;
  const setTrigger = (patch) => setF((x) => ({ ...x, trigger: { ...x.trigger, ...patch } }));
  const setStep = (i, args) => setF((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, args } : s)) }));
  const move = (i, d) => setF((x) => { const s = [...x.steps]; const [it] = s.splice(i, 1); s.splice(i + d, 0, it); return { ...x, steps: s }; });
  const taskTrigger = t.type === 'event' && t.event !== 'transaction_added';
  const stepTypes = (meta?.steps || Object.keys(LABEL)).filter((s) => taskTrigger || !['update_task', 'add_comment'].includes(s));

  const preview = useMemo(() => {
    const when = t.type === 'schedule'
      ? `${{ daily: 'Every day', weekdays: 'Every weekday', weekly: `Every ${WEEKDAYS[t.weekday]}`, monthly: `On day ${t.day} of each month`, once: `On ${t.date || '...'}` }[t.frequency]} at ${t.time}`
      : `When ${(meta?.events?.[t.event] || 'something happens').replace(/^A /, 'a ').toLowerCase()}`;
    return `${when}: ${f.steps.map((s) => LABEL[s.type].toLowerCase()).join(', then ')}.`;
  }, [f, t, meta]);

  const save = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    const clean = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === '' ? (k.endsWith('_days') || k === 'reminder_minutes' ? null : v) : v]));
    const trigger = t.type === 'event' ? { type: 'event', event: t.event || 'task_done', conditions: t.conditions || {} } : t;
    try { await onSave({ name: f.name, trigger, steps: f.steps.map((s) => ({ type: s.type, args: clean(s.args) })) }); } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form className="flow-builder" onSubmit={save} aria-label="Automation builder">
      <div className="flow-section">
        <h3>1. Name</h3>
        <input aria-label="Automation name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="e.g. Monday planning" required />
      </div>
      <div className="flow-section">
        <h3>2. When should it run?</h3>
        <div className="seg" role="group" aria-label="Trigger kind">
          <button type="button" aria-pressed={t.type === 'schedule'} onClick={() => setF({ ...f, trigger: { ...blank().trigger } })}>On a schedule</button>
          <button type="button" aria-pressed={t.type === 'event'} onClick={() => setF({ ...f, trigger: { type: 'event', event: 'task_done', conditions: {} } })}>When something happens</button>
        </div>
        {t.type === 'schedule' ? (
          <div className="flow-row" style={{ marginTop: 12 }}>
            <Field label="How often"><select value={t.frequency} onChange={(e) => setTrigger({ frequency: e.target.value })}>{FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            {t.frequency === 'weekly' && <Field label="Day"><select value={t.weekday} onChange={(e) => setTrigger({ weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>}
            {t.frequency === 'monthly' && <Field label="Day of month (1-28)"><input type="number" min="1" max="28" value={t.day} onChange={(e) => setTrigger({ day: Number(e.target.value) })} /></Field>}
            {t.frequency === 'once' && <Field label="Date"><input type="date" value={t.date} onChange={(e) => setTrigger({ date: e.target.value })} required /></Field>}
            <Field label="Time"><input type="time" value={t.time} onChange={(e) => setTrigger({ time: e.target.value })} required /></Field>
            <Field label="Time zone"><input value={t.timezone} onChange={(e) => setTrigger({ timezone: e.target.value })} /></Field>
          </div>
        ) : (
          <div className="flow-row" style={{ marginTop: 12 }}>
            <Field label="Event"><select value={t.event} onChange={(e) => setTrigger({ event: e.target.value, conditions: {} })}>{Object.entries(meta?.events || {}).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            {t.event !== 'transaction_added' ? (<>
              <Field label="Only in project"><select value={t.conditions?.project_id || ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, project_id: e.target.value } })}><option value="">Any project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
              <Field label="Only priority"><select value={t.conditions?.priority || ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, priority: e.target.value } })}><option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
            </>) : (<>
              <Field label="Only type"><select value={t.conditions?.type || ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, type: e.target.value } })}><option value="">Any</option><option>expense</option><option>income</option></select></Field>
              <Field label="At least (amount)"><input type="number" min="0" step="0.01" value={t.conditions?.min_amount_minor ? t.conditions.min_amount_minor / 100 : ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, min_amount_minor: e.target.value ? Math.round(Number(e.target.value) * 100) : 0 } })} /></Field>
              <Field label="Currency"><input maxLength={3} value={t.conditions?.currency || ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, currency: e.target.value.toUpperCase() } })} placeholder="any" /></Field>
            </>)}
          </div>
        )}
      </div>
      <div className="flow-section">
        <h3>3. What should happen? <small className="muted">Steps run in order, as you.</small></h3>
        {f.steps.map((s, i) => (
          <div className="flow-step" key={i}>
            <div className="flow-step__head">
              <span className="num">{i + 1}</span>
              <select aria-label={`Step ${i + 1} action`} value={s.type} onChange={(e) => setF((x) => ({ ...x, steps: x.steps.map((y, j) => (j === i ? { type: e.target.value, args: { ...DEFAULT_ARGS[e.target.value] } } : y)) }))}>
                {stepTypes.map((st) => <option key={st} value={st}>{LABEL[st]}</option>)}
              </select>
              <button type="button" className="btn btn-icon btn-ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}><ArrowUp size={16} /></button>
              <button type="button" className="btn btn-icon btn-ghost" disabled={i === f.steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}><ArrowDown size={16} /></button>
              <button type="button" className="btn btn-icon btn-ghost" disabled={f.steps.length === 1} onClick={() => setF((x) => ({ ...x, steps: x.steps.filter((_, j) => j !== i) }))} aria-label={`Remove step ${i + 1}`}><X size={16} /></button>
            </div>
            <StepFields step={s} set={(args) => setStep(i, args)} projects={projects} categories={categories} trigger={t} />
          </div>
        ))}
        {f.steps.length < 10 && <button type="button" className="btn" onClick={() => setF((x) => ({ ...x, steps: [...x.steps, { type: 'notify', args: { ...DEFAULT_ARGS.notify } }] }))}><Plus size={16} aria-hidden="true" /> Add a step</button>}
        <p className="hint">Text fields can use placeholders: {(meta?.placeholders || []).filter((p) => taskTrigger || !p.startsWith('trigger.') || t.event === 'transaction_added' || true).map((p) => `{{${p}}}`).join('  ')}</p>
      </div>
      <div className="flow-preview" aria-live="polite"><b>Summary:</b> {preview}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="inline-form">
        <button type="submit" className="btn btn-primary" disabled={busy}>Save automation</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);

export default function AutomationsPage() {
  const { active, user } = useAuth();
  const writable = canWrite(active?.role);
  const [items, setItems] = useState(null);
  const [meta, setMeta] = useState(null);
  const [projects, setProjects] = useState([]);
  const [categories, setCategories] = useState([]);
  const [editing, setEditing] = useState(null);   // null | 'new' | automation
  const [error, setError] = useState('');
  const [result, setResult] = useState({});

  const load = useCallback(() => api.listAutomations().then(setItems).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
    api.automationMeta().then(setMeta).catch(() => {});
    api.listProjects().then(setProjects).catch(() => {});
    api.listCategories().then(setCategories).catch(() => {});
  }, [load]);

  const save = async (body) => {
    if (editing && editing !== 'new') await api.updateAutomation(editing.id, body); else await api.createAutomation(body);
    setEditing(null); load();
  };
  const toggle = async (a) => { try { await api.updateAutomation(a.id, { enabled: !a.enabled }); load(); } catch (e) { setError(e.message); } };
  const remove = async (a) => { if (!window.confirm(`Delete "${a.name}"? Its run history is deleted too.`)) return; try { await api.deleteAutomation(a.id); load(); } catch (e) { setError(e.message); } };
  const run = async (a) => { setError(''); try { const r = await api.runAutomation(a.id); setResult((x) => ({ ...x, [a.id]: r })); load(); } catch (e) { setError(e.message); } };
  const askAssistant = () => window.dispatchEvent(new CustomEvent('amb:open-assistant'));

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">AUTOMATION</div>
          <h1>Automations</h1>
          <p className="page-sub">Flows that run on a schedule or when something happens, as you. Build one here or ask the assistant to propose it.</p>
        </div>
        {writable && !editing && <div className="inline-form">
          <button type="button" className="btn" onClick={askAssistant}><Sparkles size={16} aria-hidden="true" /> Ask the assistant</button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> New automation</button>
        </div>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      {editing && <Builder initial={editing === 'new' ? null : { name: editing.name, trigger: editing.trigger, steps: editing.steps }} projects={projects} categories={categories} meta={meta} onSave={save} onCancel={() => setEditing(null)} />}

      {!editing && items === null && !error && <p>Loading...</p>}
      {!editing && items && items.length === 0 && (
        <div className="empty-state"><Workflow size={32} aria-hidden="true" /><p>No automations yet. Try "every Monday at 08:00, create a task to plan the week" or "when a high priority task is done, notify me".</p></div>
      )}
      {!editing && items && items.length > 0 && (
        <div className="flow-grid">
          {items.map((a) => {
            const mine = a.user_id === user?.id; const canEdit = writable && (mine || ['owner', 'admin'].includes(active?.role));
            const last = a.runs?.[0]; const shown = result[a.id];
            return (
              <article key={a.id} className={`flow-card ${a.enabled ? '' : 'is-off'}`} aria-label={a.name}>
                <div className="flow-card__head">
                  <h3>{a.name}</h3>
                  {a.created_via === 'assistant' && <span className="badge">Suggested by assistant</span>}
                  <label className="check"><input type="checkbox" checked={a.enabled} disabled={!canEdit} onChange={() => toggle(a)} aria-label={`${a.name} enabled`} /> {a.enabled ? 'On' : 'Off'}</label>
                  {canEdit && <button type="button" className="btn" onClick={() => setEditing(a)}>Edit</button>}
                  {mine && writable && a.trigger.type === 'schedule' && <button type="button" className="btn" onClick={() => run(a)}><Play size={14} aria-hidden="true" /> Run now</button>}
                  {canEdit && <button type="button" className="btn btn-icon btn-ghost" onClick={() => remove(a)} aria-label={`Delete ${a.name}`}><Trash2 size={16} color="var(--color-danger)" /></button>}
                </div>
                <p style={{ margin: '6px 0 0' }}><b>{a.summary}</b></p>
                <ol className="flow-steps" aria-label="Steps">{a.steps.map((s, i) => <li key={i}>{i + 1}. {LABEL[s.type]}</li>)}</ol>
                <div className="flow-meta">
                  {a.enabled && a.next_run_at && <span>Next run: {when(a.next_run_at)}</span>}
                  {last && <span className={`flow-run--${last.status}`}>Last run: {last.status} ({when(last.started_at)})</span>}
                  {!last && a.trigger.type === 'event' && <span>Runs when it happens</span>}
                </div>
                {(shown || (last && last.status !== 'ok')) && (
                  <ul className="flow-log" aria-label="Last run log">{(shown?.log || last.log).map((l, i) => <li key={i} className={l.ok ? '' : 'flow-run--failed'}>{l.step ? `Step ${l.step}: ` : ''}{l.message}{l.link && <> <Link to={l.link}>Open</Link></>}</li>)}</ul>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
