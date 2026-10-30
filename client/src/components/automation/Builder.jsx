import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Check, FlaskConical, Info, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { api } from '../../api/client.js';
import { Field, StepFields, FREQ, PRIORITIES, WEEKDAYS, blank, cleanStep } from './fields.jsx';
import { StepIcon, describe, stepTitle, stepIconType, KIND, CATALOG } from './stepMeta.jsx';
import Picker from './Picker.jsx';

let uid = 0;
const withIds = (steps) => (steps || []).map((s) => ({ ...s, _id: `s${uid += 1}`, args: s.type === 'loop' ? { ...s.args, steps: withIds(s.args.steps) } : s.args }));
const save_as = (s) => (s.type === 'loop' ? (s.args.collect ? s.args.save_as : '') : s.args?.save_as || '');
const sigOf = (s, label) => { try { return JSON.stringify(cleanStep(s, label)); } catch { return 'invalid'; } };
const parseList = (text) => { try { const j = JSON.parse(text); return Array.isArray(j) ? j : null; } catch { return null; } };
// "1.2.1" in a loop log is: top-level step 1, item 2, step 1 inside the loop
export const logLabel = (step) => { const p = String(step).split('.'); return p.length >= 3 ? `Item ${p[1]}, step ${p[2]}` : p.length === 2 ? `Item ${p[1]}` : `Step ${p[0]}`; };
const nameIn = (over) => /\{\{\s*result\.([a-z0-9_]+)/.exec(String(over || ''))?.[1] || '';

function TriggerFields({ t, setTrigger, setKind, meta, projects }) {
  return (
    <div className="ab-form">
      <div className="seg" role="group" aria-label="Trigger kind">
        <button type="button" aria-pressed={t.type === 'schedule'} onClick={() => setKind('schedule')}>On a schedule</button>
        <button type="button" aria-pressed={t.type === 'event'} onClick={() => setKind('event')}>When something happens</button>
      </div>
      {t.type === 'schedule' ? (
        <div className="flow-row">
          <Field label="How often"><select value={t.frequency} onChange={(e) => setTrigger({ frequency: e.target.value })}>{FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          {t.frequency === 'weekly' && <Field label="Day"><select value={t.weekday} onChange={(e) => setTrigger({ weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>}
          {t.frequency === 'monthly' && <Field label="Day of month (1-28)"><input type="number" min="1" max="28" value={t.day} onChange={(e) => setTrigger({ day: Number(e.target.value) })} /></Field>}
          {t.frequency === 'once' && <Field label="Date"><input type="date" value={t.date} onChange={(e) => setTrigger({ date: e.target.value })} required /></Field>}
          <Field label="Time"><input type="time" value={t.time} onChange={(e) => setTrigger({ time: e.target.value })} required /></Field>
          <Field label="Time zone"><input value={t.timezone} onChange={(e) => setTrigger({ timezone: e.target.value })} /></Field>
        </div>
      ) : (
        <div className="flow-row">
          <Field label="Event"><select value={t.event} onChange={(e) => setTrigger({ event: e.target.value, conditions: {} })}>{Object.entries(meta?.events || {}).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          {t.event !== 'transaction_added' ? (<>
            <Field label="Only in project"><select value={t.conditions?.project_id || ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, project_id: e.target.value } })}><option value="">Any project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Only priority"><select value={t.conditions?.priority || ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, priority: e.target.value } })}><option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
          </>) : (<>
            <Field label="Only type"><select value={t.conditions?.type || ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, type: e.target.value } })}><option value="">Any</option><option>expense</option><option>income</option></select></Field>
            <Field label="At least (amount)"><input type="number" min="0" step="0.01" value={t.conditions?.min_amount_minor ? t.conditions.min_amount_minor / 100 : ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, min_amount_minor: e.target.value ? Math.round(Number(e.target.value) * 100) : undefined } })} /></Field>
            <Field label="Currency"><input maxLength={3} value={t.conditions?.currency || ''} onChange={(e) => setTrigger({ conditions: { ...t.conditions, currency: e.target.value.toUpperCase() } })} placeholder="any" /></Field>
          </>)}
        </div>
      )}
    </div>
  );
}

const triggerText = (t, meta) => (t.type === 'schedule'
  ? `${{ daily: 'Every day', weekdays: 'Every weekday', weekly: `Every ${WEEKDAYS[t.weekday]}`, monthly: `On day ${t.day} of each month`, once: `On ${t.date || '...'}` }[t.frequency]} at ${t.time}`
  : `When ${(meta?.events?.[t.event] || 'something happens').replace(/^A /, 'a ').toLowerCase()}`);

function ResultPanel({ t }) {
  const [view, setView] = useState('table');
  if (!t) return <div className="ab-res ab-res--empty"><p className="muted">Not tested yet. Press "Test this step" to see what it produces. Reading steps really run; steps that change something only describe what they would do. Nothing is saved or sent.</p></div>;
  if (t.state === 'bad') return <div className="ab-res" role="alert"><div className="ab-res__head"><h3>Test result</h3><span className="ab-badge ab-badge--bad">Failed</span></div><p className="form-error">{t.error}</p></div>;
  const list = parseList(t.output);
  const rows = list && list.length && list.every((x) => x && typeof x === 'object' && !Array.isArray(x)) ? list : null;
  const cols = rows ? [...new Set(rows.slice(0, 20).flatMap((r) => Object.keys(r)))].slice(0, 6) : [];
  let json = t.output || '';
  try { json = JSON.stringify(JSON.parse(json), null, 2); } catch { /* text */ }
  const cell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div className="ab-res" role="status" aria-label="Test result">
      <div className="ab-res__head">
        <h3>Test result</h3><span className="ab-badge">Worked</span><span className="ab-note">{t.message}</span>
        {t.output && <div className="ab-tabs" role="group" aria-label="View result">{rows && <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>}<button type="button" aria-pressed={view === 'json' || !rows} onClick={() => setView('json')}>{rows ? 'JSON' : 'Text'}</button></div>}
      </div>
      {rows && view === 'table' ? (
        <div className="ab-table"><table aria-label={`First ${Math.min(rows.length, 5)} of ${rows.length} items`}><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{cell(r[c])}</td>)}</tr>)}</tbody></table></div>
      ) : t.output ? <pre className="ab-pre" tabIndex={0}>{json.length > 6000 ? `${json.slice(0, 6000)}\n... (${json.length - 6000} more characters)` : json}</pre> : null}
      {list && <p className="ab-note">{rows ? `Showing ${Math.min(rows.length, 5)} of ${list.length} items.` : `${list.length} items.`}</p>}
      {t.log?.length > 0 && (
        <ul className="ab-log" aria-label="Items">{t.log.map((l, i) => <li key={i} className={l.ok ? '' : 'is-bad'}><b>{l.ok ? '' : 'Failed: '}{logLabel(l.step)}</b> {l.message}{l.output && l.output !== l.message && !l.message.includes(l.output) && <pre className="ab-pre ab-pre--small">{l.output.slice(0, 500)}</pre>}</li>)}</ul>
      )}
      <p className="ab-note"><Info size={13} aria-hidden="true" /> Test only: nothing was saved or sent.</p>
    </div>
  );
}

export default function Builder({ initial, enabledInitial = true, projects, categories, meta, tools, templates, onSave, onCancel, onDelete, openStep }) {
  const [f, setF] = useState(() => { const b = initial || blank(); return { ...b, steps: withIds(b.steps) }; });
  const [enabled, setEnabled] = useState(enabledInitial);
  const [sel, setSel] = useState(() => (openStep != null && initial?.steps?.[openStep] ? String(openStep) : initial?.steps?.length ? '0' : 'trigger'));
  const [sheet, setSheet] = useState(false);
  const [picker, setPicker] = useState(null);       // { parent: null | step index, at: index }
  const [tests, setTests] = useState({});            // step _id -> { state, message, output, log, sig, error }
  const [vars, setVars] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  const lastField = useRef(null);
  const t = f.trigger;
  const taskTrigger = t.type === 'event' && t.event !== 'transaction_added';
  const hasServers = !!tools?.servers?.length;
  const trigPayload = t.type === 'event' ? { type: 'event', event: t.event || 'task_done', conditions: t.conditions || {} } : t;

  // ---- finding and changing steps by key: "trigger", "2" (top level) or "2.1" (inside the loop at 2)
  const at = useCallback((key, steps = f.steps) => { const [i, j] = String(key).split('.').map(Number); const top = steps[i]; return j == null || Number.isNaN(j) ? top : top?.args?.steps?.[j]; }, [f.steps]);
  const mapStep = (key, fn) => setF((x) => {
    const [i, j] = String(key).split('.').map(Number);
    return { ...x, steps: x.steps.map((s, a) => (a !== i ? s : j == null || Number.isNaN(j) ? fn(s) : { ...s, args: { ...s.args, steps: s.args.steps.map((c, b) => (b === j ? fn(c) : c)) } })) };
  });
  const setArgs = (key, args) => mapStep(key, (s) => ({ ...s, args }));
  const setTrigger = (patch) => setF((x) => ({ ...x, trigger: { ...x.trigger, ...patch } }));
  const setKind = (kind) => setF((x) => ({ ...x, trigger: kind === 'schedule' ? { ...blank().trigger } : { type: 'event', event: 'task_done', conditions: {} } }));

  const select = (key) => { setSel(key); setSheet(true); };
  const insert = (parent, index, step) => {
    const made = withIds([step])[0];
    setF((x) => ({ ...x, steps: parent == null ? [...x.steps.slice(0, index), made, ...x.steps.slice(index)]
      : x.steps.map((s, i) => (i === parent ? { ...s, args: { ...s.args, steps: [...s.args.steps.slice(0, index), made, ...s.args.steps.slice(index)] } } : s)) }));
    setSel(parent == null ? String(index) : `${parent}.${index}`); setSheet(true); setPicker(null);
  };
  const remove = (key) => {
    const [i, j] = String(key).split('.').map(Number);
    setF((x) => ({ ...x, steps: j == null || Number.isNaN(j) ? x.steps.filter((_, a) => a !== i) : x.steps.map((s, a) => (a === i ? { ...s, args: { ...s.args, steps: s.args.steps.filter((_, b) => b !== j) } } : s)) }));
    setSel('trigger'); setSheet(false);
  };
  const move = (key, d) => {
    const [i, j] = String(key).split('.').map(Number);
    const swap = (arr, k) => { const c = [...arr]; [c[k], c[k + d]] = [c[k + d], c[k]]; return c; };
    setF((x) => ({ ...x, steps: j == null || Number.isNaN(j) ? swap(x.steps, i) : x.steps.map((s, a) => (a === i ? { ...s, args: { ...s.args, steps: swap(s.args.steps, j) } } : s)) }));
    setSel(j == null || Number.isNaN(j) ? String(i + d) : `${i}.${j + d}`);
  };

  // ---- testing
  const record = (step, res) => setTests((m) => ({ ...m, [step._id]: res }));
  const runTest = async (key, local) => {
    const step = at(key); if (!step) return false;
    const parent = String(key).includes('.') ? at(String(key).split('.')[0]) : null;
    try {
      const sig = sigOf(step, key);
      const r = await api.testAutomationStep({ step: cleanStep(step, key), trigger: trigPayload, vars: local ?? vars, item_from: parent ? parent.args.over : undefined });
      if (local) Object.assign(local, r.vars || {}); else setVars((v) => ({ ...v, ...(r.vars || {}) }));
      record(step, { state: 'ok', message: r.message, output: r.output, log: r.log, sig });
      return true;
    } catch (err) { record(step, { state: 'bad', error: err.message }); return false; }
  };
  const testOne = async () => { if (sel === 'trigger') return; setBusy(true); try { await runTest(sel); } finally { setBusy(false); } };
  const testAll = async () => {
    setAllBusy(true); const local = { ...vars };
    try {
      for (let i = 0; i < f.steps.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await runTest(String(i), local))) { setSel(String(i)); setSheet(true); break; }
      }
      setVars(local);
    } finally { setAllBusy(false); }
  };

  const statusOf = (s, key) => { const r = tests[s._id]; if (!r) return 'no'; if (r.state === 'bad') return 'bad'; return r.sig === sigOf(s, key) ? 'ok' : 'stale'; };
  const STAT = { no: ['Not tested', 'no'], ok: ['Tested', 'ok'], bad: ['Failed', 'bad'], stale: ['Edited since test', 'stale'] };
  const outInfo = (s) => {
    const n = save_as(s); if (!n) return null;
    const txt = vars[n]; const list = txt != null ? parseList(txt) : null;
    return { name: n, extra: txt == null ? '' : list ? ` · ${list.length} item${list.length === 1 ? '' : 's'}` : ' · text' };
  };

  // names the selected step can use
  const earlier = useMemo(() => {
    if (sel === 'trigger') return [];
    const [i, j] = String(sel).split('.').map(Number);
    const out = [];
    f.steps.slice(0, i).forEach((s) => { const n = save_as(s); if (n) out.push(n); });
    if (!Number.isNaN(j) && j != null) f.steps[i].args.steps.slice(0, j).forEach((s) => { if (s.args?.save_as) out.push(s.args.save_as); });
    return out;
  }, [sel, f.steps]);
  const itemFields = useMemo(() => {
    if (!String(sel).includes('.')) return null;
    const loop = f.steps[Number(String(sel).split('.')[0])];
    const list = parseList(vars[nameIn(loop?.args?.over)]);
    const first = list?.[0];
    return first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : [];
  }, [sel, f.steps, vars]);

  const insertAtCaret = (text) => {
    const el = lastField.current;
    if (!el || !el.isConnected) { navigator.clipboard?.writeText(text).catch(() => {}); return; }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const a = el.selectionStart ?? el.value.length; const b = el.selectionEnd ?? a;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, el.value.slice(0, a) + text + el.value.slice(b));
    el.dispatchEvent(new Event('input', { bubbles: true })); el.focus();
    const pos = a + text.length; try { el.setSelectionRange(pos, pos); } catch { /* not supported for this type */ }
  };

  const save = async (e) => {
    e?.preventDefault(); setBusy(true); setError('');
    try {
      if (!f.name.trim()) throw new Error('Give the automation a name.');
      if (!f.steps.length) throw new Error('Add at least one step.');
      const steps = f.steps.map((s, i) => cleanStep(s, i + 1));
      await onSave({ name: f.name, trigger: trigPayload, steps, enabled });
    } catch (err) { setError(err.message); setBusy(false); }
  };

  const untested = f.steps.filter((s, i) => statusOf(s, String(i)) !== 'ok').length;
  const summaryWhen = triggerText(t, meta);
  const summarySteps = `${f.steps.map((s) => stepTitle(s).toLowerCase()).join(', ') || 'no steps yet'}.`;

  // ---- what the picker suggests next
  const pickerSuggest = (p) => {
    if (!p) return null;
    const prev = (p.parent == null ? f.steps : f.steps[p.parent].args.steps)[p.at - 1];
    const n = prev && save_as(prev); const list = n && parseList(vars[n]);
    if (p.parent == null && list && !f.steps.some((s) => s.type === 'loop')) return { item: CATALOG[1].items[1], over: `{{result.${n}}}`, why: `Step ${p.at} saved a list of ${list.length} items as result.${n}, so you can run steps on each one.` };
    if (p.parent == null && prev && KIND[prev.type] !== 'act' && !f.steps.some((s) => s.type === 'send_email')) return { item: CATALOG[2].items[0], why: 'Send what you found to yourself by email.' };
    return null;
  };
  const loopIndex = picker?.parent;

  const renderNode = (s, key, label) => {
    const st = STAT[statusOf(s, key)]; const out = outInfo(s);
    return (
      <button type="button" className={`ab-node${sel === key ? ' is-sel' : ''}`} aria-current={sel === key ? 'step' : undefined} onClick={() => select(key)}>
        <StepIcon type={stepIconType(s)} />
        <span className="ab-node__body"><span className="ab-node__t"><small>{label}</small>{stepTitle(s)}</span><span className="ab-node__d">{describe(s) || ' '}</span>
          {out && <span className="ab-out">{s.type === 'loop' ? 'collects' : 'saves'} <b>result.{out.name}</b>{out.extra}</span>}</span>
        <span className={`ab-stat ab-stat--${st[1]}`}><i />{st[0]}</span>
      </button>
    );
  };
  const plus = (parent, index, name) => (
    <div className="ab-link"><span /><button type="button" className="ab-plus" aria-label={name} onClick={() => setPicker({ parent, at: index })}><i><Plus size={14} aria-hidden="true" /></i></button><span /></div>
  );

  const cur = sel === 'trigger' ? null : at(sel);
  const curTest = cur ? tests[cur._id] : null;
  const isLoop = cur?.type === 'loop';
  const [ci, cj] = sel === 'trigger' ? [] : String(sel).split('.').map(Number);
  const inner = cj != null && !Number.isNaN(cj);
  const lastIdx = inner ? f.steps[ci].args.steps.length - 1 : f.steps.length - 1;
  const num = inner ? `${ci + 1}.${cj + 1}` : String(ci + 1);

  return (
    <form className="ab" onSubmit={save} aria-label="Automation builder">
      <div className="ab-top">
        <button type="button" className="ab-back" onClick={onCancel}><ArrowLeft size={16} aria-hidden="true" /> Automations</button>
        <input className="ab-name" aria-label="Automation name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="Name this automation" />
        <span className="ab-grow" />
        <label className="ab-switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span className="ab-switch__t" aria-hidden="true" />{enabled ? 'On' : 'Off'}<span className="sr-only"> (automation enabled)</span></label>
        {onDelete && <button type="button" className="ab-btn ab-btn--danger" onClick={onDelete}><Trash2 size={14} aria-hidden="true" /> Delete automation</button>}
        <button type="button" className="ab-btn" onClick={testAll} disabled={allBusy || !f.steps.length}><FlaskConical size={16} aria-hidden="true" /> {allBusy ? 'Testing...' : 'Test all steps'}</button>
        <button type="submit" className="ab-btn ab-btn--primary" disabled={busy}>Save automation</button>
      </div>
      {error && <p className="form-error ab-error" role="alert">{error}</p>}
      <div className="ab-main">
        <div className="ab-flow" aria-label="Flow">
          <p className="ab-lab">Flow</p>
          <button type="button" className={`ab-node${sel === 'trigger' ? ' is-sel' : ''}`} aria-current={sel === 'trigger' ? 'step' : undefined} onClick={() => select('trigger')}>
            <StepIcon type={t.type === 'event' ? 'event' : 'trigger'} />
            <span className="ab-node__body"><span className="ab-node__t"><small>When</small>{triggerText(t, meta)}</span><span className="ab-node__d">{t.type === 'schedule' ? t.timezone : 'Runs when it happens'}</span></span>
            <span className="ab-stat ab-stat--link">Change</span>
          </button>
          {f.steps.length === 0 && <button type="button" className="ab-add" onClick={() => setPicker({ parent: null, at: 0 })}><Plus size={16} aria-hidden="true" /> Add the first step</button>}
          {f.steps.map((s, i) => (
            <div key={s._id}>
              {plus(null, i, `Add a step ${i === 0 ? 'after the trigger' : `after step ${i}`}`)}
              {s.type !== 'loop' ? renderNode(s, String(i), i + 1) : (
                <div className={`ab-loop${sel === String(i) ? ' is-sel' : ''}`}>
                  {renderNode(s, String(i), i + 1)}
                  <div className="ab-inner">
                    {s.args.steps.map((c, j) => (
                      <div key={c._id}>{j > 0 && plus(i, j, `Add a step after step ${i + 1}.${j}`)}{renderNode(c, `${i}.${j}`, `${i + 1}.${j + 1}`)}</div>
                    ))}
                    <button type="button" className="ab-btn ab-btn--small" onClick={() => setPicker({ parent: i, at: s.args.steps.length })}><Plus size={14} aria-hidden="true" /> Add a step to the loop</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {f.steps.length > 0 && (<>{plus(null, f.steps.length, `Add a step after step ${f.steps.length}`)}<button type="button" className="ab-add" onClick={() => setPicker({ parent: null, at: f.steps.length })}><Plus size={16} aria-hidden="true" /> Add a step</button></>)}
        </div>

        <section className={`ab-insp${sheet ? ' is-open' : ''}`} aria-label={sel === 'trigger' ? 'Trigger settings' : `Step ${num} settings`} onFocusCapture={(e) => { if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox') lastField.current = e.target; }}>
          <div className="ab-grab" aria-hidden="true" />
          {sel === 'trigger' ? (<>
            <div className="ab-insp__head"><StepIcon type={t.type === 'event' ? 'event' : 'trigger'} /><div className="ab-grow"><h2>When should it run?</h2><small>The flow runs as you</small></div><button type="button" className="ab-x ab-x--sheet" onClick={() => setSheet(false)} aria-label="Close settings"><X size={18} aria-hidden="true" /></button></div>
            <div className="ab-insp__body"><TriggerFields t={t} setTrigger={setTrigger} setKind={setKind} meta={meta} projects={projects} /></div>
          </>) : cur ? (<>
            <div className="ab-insp__head">
              <StepIcon type={stepIconType(cur)} />
              <div className="ab-grow"><h2>Step {num}: {stepTitle(cur)}</h2><small>{{ get: 'Gets data', mix: 'Shapes data', act: 'Does something' }[KIND[cur.type]]}{inner ? ', inside the loop' : ''}</small></div>
              <button type="button" className="ab-btn ab-btn--small" aria-label="Move up" disabled={(inner ? cj : ci) === 0} onClick={() => move(sel, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" className="ab-btn ab-btn--small" aria-label="Move down" disabled={(inner ? cj : ci) === lastIdx} onClick={() => move(sel, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
              <button type="button" className="ab-btn ab-btn--small" onClick={() => remove(sel)}><Trash2 size={14} aria-hidden="true" /> Remove</button>
              <button type="button" className="ab-btn ab-btn--primary" onClick={testOne} disabled={busy}><FlaskConical size={16} aria-hidden="true" /> {busy ? 'Testing...' : isLoop ? 'Test the loop' : 'Test this step'}</button>
              <button type="button" className="ab-x ab-x--sheet" onClick={() => setSheet(false)} aria-label="Close settings"><X size={18} aria-hidden="true" /></button>
            </div>
            <div className="ab-insp__body">
              <StepFields step={cur} set={(args) => setArgs(sel, args)} projects={projects} categories={categories} trigger={t} tools={tools} templates={templates} meta={meta} before={earlier} />
              {isLoop && <p className="hint">Select a step inside the loop in the flow to change it. Use the item as {'{{item}}'} or {'{{item.field}}'}.</p>}
              {(earlier.length > 0 || itemFields) && (
                <div className="ab-data" role="group" aria-label="Data you can use">
                  <span className="ab-note">Data you can use. Click to insert into the field you last edited:</span>
                  {itemFields?.map((k) => <button key={k} type="button" className="ab-pill" onClick={() => insertAtCaret(`{{item.${k}}}`)}><b>item.{k}</b></button>)}
                  {itemFields && itemFields.length === 0 && <button type="button" className="ab-pill" onClick={() => insertAtCaret('{{item}}')}><b>item</b></button>}
                  {earlier.map((n) => { const l = parseList(vars[n]); return <button key={n} type="button" className="ab-pill" onClick={() => insertAtCaret(`{{result.${n}}}`)}><b>result.{n}</b>{l ? ` ${l.length} items` : vars[n] != null ? ' text' : ''}</button>; })}
                  <button type="button" className="ab-pill" onClick={() => insertAtCaret('{{date}}')}>date</button><button type="button" className="ab-pill" onClick={() => insertAtCaret('{{owner.name}}')}>owner.name</button>
                </div>
              )}
            </div>
            <ResultPanel t={curTest} />
          </>) : null}
        </section>
      </div>
      <div className="ab-bar">
        <p className="ab-sum"><b>{summaryWhen}:</b> {summarySteps}</p>
        {f.steps.length > 0 && untested > 0 && <span className="ab-warn"><TriangleAlert size={14} aria-hidden="true" /> {untested} step{untested === 1 ? '' : 's'} not tested yet</span>}
        {f.steps.length > 0 && untested === 0 && <span className="ab-ok"><Check size={14} aria-hidden="true" /> All steps tested</span>}
        <button type="button" className="ab-btn" onClick={onCancel}>Cancel</button>
      </div>
      {picker && <Picker title={picker.parent != null ? 'Add a step to the loop' : picker.at === 0 ? 'Add the first step' : `Add a step after step ${picker.at}`} taskTrigger={taskTrigger} hasServers={hasServers} insideLoop={loopIndex != null} suggest={pickerSuggest(picker)}
        onPick={(step) => insert(picker.parent, picker.at, step)} onClose={() => setPicker(null)} />}
    </form>
  );
}
