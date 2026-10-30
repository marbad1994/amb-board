import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Info, Play, X } from 'lucide-react';
import { api } from '../../api/client.js';
import { stepTitle } from './stepMeta.jsx';
import { logLabel } from './Builder.jsx';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const secs = (a, b) => (a && b ? `${Math.max(0.1, (Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)} s` : '');
const ms = (n) => (n == null ? '' : n < 100 ? '<0.1 s' : `${(n / 1000).toFixed(1)} s`);
const WORD = { ok: 'Worked', failed: 'Stopped', skipped: 'Skipped', running: 'Running' };

export default function RunHistory({ automation, canRun, onBack, onEdit, onRun }) {
  const [runs, setRuns] = useState(null);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState('');
  const load = () => api.getAutomation(automation.id).then((a) => setRuns(a.runs || [])).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [automation.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = runs?.[sel];
  // group the flat log by top-level step ("3.2.1" belongs to step 3)
  const groups = [];
  for (const l of run?.log || []) {
    const top = Number(String(l.step).split('.')[0]) || 0;
    let g = groups.find((x) => x.top === top);
    if (!g) { g = { top, own: null, inner: [] }; groups.push(g); }
    if (String(l.step).includes('.')) g.inner.push(l); else g.own = l;
  }
  return (
    <div className="ab-runs">
      <div className="ab-runs__head">
        <button type="button" className="ab-back" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> Automations</button>
        <h1>{automation.name}: run history</h1>
        <span className="ab-grow" />
        <button type="button" className="ab-btn" onClick={onEdit}>Edit automation</button>
        {canRun && <button type="button" className="ab-btn ab-btn--primary" onClick={async () => { try { await onRun(); await load(); setSel(0); } catch (e) { setError(e.message); } }}><Play size={14} aria-hidden="true" /> Run now</button>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {runs && runs.length === 0 && <p className="muted">It has not run yet. {automation.trigger.type === 'event' ? 'It runs when its event happens.' : 'Press Run now to try it for real.'}</p>}
      {runs && runs.length > 0 && (
        <div className="ab-runs__grid">
          <ul className="ab-runlist" aria-label="Runs">
            {runs.map((r, i) => (
              <li key={r.id}><button type="button" className={i === sel ? 'is-sel' : ''} aria-current={i === sel} onClick={() => setSel(i)}>
                <i className={`ab-dot ab-dot--${r.status}`} /><span><b>{when(r.started_at)}</b><small>{WORD[r.status] || r.status}{secs(r.started_at, r.finished_at) ? ` · ${secs(r.started_at, r.finished_at)}` : ''}{r.slot.startsWith('manual:') ? ' · run by you' : ''}</small></span></button></li>
            ))}
          </ul>
          {run && (
            <section className="ab-runbody" aria-label="Run details">
              <div className="ab-runbody__h"><h2>{when(run.started_at)}</h2><span className={`ab-badge ab-badge--${run.status}`}>{WORD[run.status] || run.status}</span><small>{secs(run.started_at, run.finished_at)}</small></div>
              <ol className="ab-tl">
                {groups.map((g) => {
                  const step = automation.steps[g.top - 1];
                  const ok = !g.own || g.own.ok;
                  return (
                    <li key={g.top} className={ok ? '' : 'is-bad'}>
                      <span className="ab-tl__pt">{ok ? <Check size={12} strokeWidth={3.4} aria-hidden="true" /> : <X size={12} strokeWidth={3.4} aria-hidden="true" />}</span>
                      <div>
                        <div className="ab-tl__t"><b>{g.top ? `${g.top}. ${step ? stepTitle(step) : 'Step'}` : 'Run'}</b>{g.own?.ms != null && <em>{ms(g.own.ms)}</em>}</div>
                        {g.own && <p>{g.own.message}</p>}
                        {g.own?.link && <Link to={g.own.link}>Open</Link>}
                        {g.own?.output && <details className="ab-det"><summary>Output</summary><pre className="ab-pre">{g.own.output}</pre></details>}
                        {g.inner.length > 0 && <details className="ab-det"><summary>{g.inner.length} step{g.inner.length === 1 ? '' : 's'} inside the loop</summary>
                          <ul className="ab-log">{g.inner.map((l, i) => <li key={i} className={l.ok ? '' : 'is-bad'}><b>{logLabel(l.step)}</b> {l.message}{l.ms != null && <em> {ms(l.ms)}</em>}</li>)}</ul></details>}
                        {!ok && step && <button type="button" className="ab-btn ab-btn--small" onClick={() => onEdit(g.top - 1)}>Open this step</button>}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="ab-note"><Info size={13} aria-hidden="true" /> A failed step shows what stopped it and what was not done. The last 20 runs are kept.</p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
