import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Plus, Sparkles, Workflow } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import { blank } from '../components/automation/fields.jsx';
import { StepIcon, stepIconType } from '../components/automation/stepMeta.jsx';
import Builder from '../components/automation/Builder.jsx';
import RunHistory from '../components/automation/RunHistory.jsx';
import EmailTemplates from '../components/automation/EmailTemplates.jsx';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);
const FILTERS = [['all', 'All'], ['on', 'On'], ['off', 'Off'], ['attention', 'Needs attention']];

const TEMPLATES = [
  { name: 'Morning news by email', desc: 'Search the web, summarise it, mail it to you every morning.',
    flow: { name: 'Morning news by email', trigger: { type: 'schedule', frequency: 'daily', weekday: 1, day: 1, date: '', time: '07:30' }, steps: [
      { type: 'use_tool', args: { tool: 'web_search', args: { query: '' }, save_as: 'news' } },
      { type: 'ai_text', args: { instruction: 'Summarise in 5 bullet points', input: '{{result.news}}', save_as: 'summary' } },
      { type: 'send_email', args: { to: ['me'], template: 'news_summary', subject: '', body: '' } }] } },
  { name: 'Deals or price watcher', desc: 'Scrape a page, keep title and price, mail what you found.',
    flow: { name: 'Deals digest', trigger: { type: 'schedule', frequency: 'weekly', weekday: 5, day: 1, date: '', time: '08:00' }, steps: [
      { type: 'scrape', args: { url: '', format: 'links', contains: '', max: 50, save_as: 'links' } },
      { type: 'parse', args: { input: '{{result.links}}', parser: 'json', prompt: '', fieldsText: 'text, url', output_format: 'json', save_as: 'items' } },
      { type: 'send_email', args: { to: ['me'], template: '', subject: 'Deals {{date}}', body: '{{result.items | pretty}}' } }] } },
  { name: 'Weekly review to your inbox', desc: 'Project health and the week ahead, every Monday.',
    flow: { name: 'Weekly review', trigger: { type: 'schedule', frequency: 'weekly', weekday: 1, day: 1, date: '', time: '08:00' }, steps: [
      { type: 'use_tool', args: { tool: 'project_health', args: {}, save_as: 'review' } },
      { type: 'send_email', args: { to: ['me'], template: 'weekly_review', subject: '', body: '' } }] } },
  { name: 'Alert on a big expense', desc: 'Tell me when one transaction crosses an amount.',
    flow: { name: 'Big expense alert', trigger: { type: 'event', event: 'transaction_added', conditions: { type: 'expense', min_amount_minor: 100000 } }, steps: [
      { type: 'send_email', args: { to: ['me'], template: '', subject: 'Big expense: {{trigger.amount}} {{trigger.currency}}', body: '{{trigger.title | default:"An expense"}} was recorded.' } }] } },
];

function Chain({ a }) {
  return (
    <div className="ab-chain" aria-label="Steps">
      <StepIcon type={a.trigger.type === 'event' ? 'event' : 'trigger'} size={16} />
      {a.steps.map((s, i) => (<span key={i} className="ab-chain__s"><ChevronRight size={14} aria-hidden="true" /><StepIcon type={stepIconType(s)} size={16} /></span>))}
    </div>
  );
}

export default function AutomationsPage() {
  const { active, user } = useAuth();
  const writable = canWrite(active?.role);
  const [items, setItems] = useState(null);
  const [meta, setMeta] = useState(null);
  const [projects, setProjects] = useState([]);
  const [categories, setCategories] = useState([]);
  const [tools, setTools] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [view, setView] = useState({ mode: 'list' });   // list | edit { auto, flow, openStep } | runs { auto }
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');

  const load = useCallback(() => api.listAutomations().then(setItems).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
    api.automationMeta().then(setMeta).catch(() => {});
    api.listProjects().then(setProjects).catch(() => {});
    api.listCategories().then(setCategories).catch(() => {});
    api.automationTools().then(setTools).catch(() => {});
    api.emailTemplates().then(setTemplates).catch(() => {});
  }, [load]);

  const save = async (body) => {
    if (view.auto) await api.updateAutomation(view.auto.id, body); else await api.createAutomation(body);
    setView({ mode: 'list' }); load();
  };
  const toggle = async (a) => { try { await api.updateAutomation(a.id, { enabled: !a.enabled }); load(); } catch (e) { setError(e.message); } };
  const remove = async (a) => { if (!window.confirm(`Delete "${a.name}"? Its run history is deleted too.`)) return; try { await api.deleteAutomation(a.id); load(); } catch (e) { setError(e.message); } };
  const runNow = async (a) => { setError(''); await api.runAutomation(a.id); load(); };
  const askAssistant = () => window.dispatchEvent(new CustomEvent('amb:open-assistant'));
  const failure = (a) => { const l = a.runs?.[0]; if (!l || l.status !== 'failed') return null; const bad = (l.log || []).find((x) => !x.ok); return { message: bad?.message || 'It stopped with an error.', step: bad ? Number(String(bad.step).split('.')[0]) || 0 : 0 }; };
  const counts = useMemo(() => ({ all: items?.length ?? 0, on: items?.filter((a) => a.enabled).length ?? 0, off: items?.filter((a) => !a.enabled).length ?? 0, attention: items?.filter((a) => failure(a)).length ?? 0 }), [items]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (items || []).filter((a) => (filter === 'all' ? true : filter === 'on' ? a.enabled : filter === 'off' ? !a.enabled : !!failure(a)));
  const startNew = (flow) => setView({ mode: 'edit', auto: null, flow: flow ? { ...flow, trigger: flow.trigger.type === 'schedule' ? { ...blank().trigger, ...flow.trigger } : flow.trigger } : { name: '', trigger: blank().trigger, steps: [] } });
  const edit = (a, openStep) => setView({ mode: 'edit', auto: a, flow: { name: a.name, trigger: a.trigger, steps: a.steps }, openStep });

  if (view.mode === 'edit') {
    return (
      <div className="page page--wide">
        <Builder key={view.auto?.id || 'new'} initial={view.flow} enabledInitial={view.auto ? view.auto.enabled : true} openStep={view.openStep} projects={projects} categories={categories} meta={meta} tools={tools} templates={templates}
          onSave={save} onCancel={() => setView({ mode: 'list' })} />
      </div>
    );
  }
  if (view.mode === 'runs') {
    const a = view.auto;
    return (
      <div className="page page--wide">
        <RunHistory automation={a} canRun={writable && a.user_id === user?.id && a.trigger.type === 'schedule'} onBack={() => { setView({ mode: 'list' }); load(); }} onEdit={(i) => edit(a, typeof i === 'number' ? i : undefined)} onRun={() => runNow(a)} />
      </div>
    );
  }

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">AUTOMATION</div>
          <h1>Automations</h1>
          <p className="page-sub">Flows that run on a schedule or when something happens, as you. Build one here, or describe it to the assistant and it builds it with you.</p>
        </div>
        {writable && <div className="inline-form">
          <button type="button" className="btn" onClick={askAssistant}><Sparkles size={16} aria-hidden="true" /> Describe it to the assistant</button>
          <button type="button" className="btn btn-primary" onClick={() => startNew()}><Plus size={16} aria-hidden="true" /> New automation</button>
        </div>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {items === null && !error && <p>Loading...</p>}
      {items && items.length > 0 && (
        <div className="ab-filters" role="group" aria-label="Filter automations">
          {FILTERS.map(([v, l]) => <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>{l} <em>{counts[v]}</em></button>)}
        </div>
      )}
      {items && items.length === 0 && (
        <div className="empty-state"><Workflow size={32} aria-hidden="true" /><p>No automations yet. Start from a template below, build one from scratch, or describe it to the assistant.</p></div>
      )}
      {items && items.length > 0 && (
        <div className="ab-cards">
          {shown.map((a) => {
            const mine = a.user_id === user?.id; const canEdit = writable && (mine || ['owner', 'admin'].includes(active?.role));
            const last = a.runs?.[0]; const fail = failure(a);
            return (
              <article key={a.id} className={`ab-card${fail ? ' is-bad' : ''}${a.enabled ? '' : ' is-off'}`} aria-label={a.name}>
                <div className="ab-card__t"><h3>{a.name}</h3>
                  {a.created_via === 'assistant' && <span className="badge">Suggested by assistant</span>}
                  <span className={`ab-chip ab-chip--${fail ? 'bad' : a.enabled ? 'on' : 'off'}`}>{fail ? 'Last run failed' : a.enabled ? 'On' : 'Off'}</span></div>
                <p className="ab-card__when">{a.summary}</p>
                <Chain a={a} />
                <ol className="sr-only" aria-label="Steps">{a.steps.map((s, i) => <li key={i}>{i + 1}. {s.type}</li>)}</ol>
                <div className="ab-meta">
                  {a.enabled && a.next_run_at && <span>Next run <b>{when(a.next_run_at)}</b></span>}
                  {last && !fail && <span>Last run <b>{last.status === 'ok' ? 'OK' : last.status}</b>, {when(last.started_at)}</span>}
                  {!last && a.trigger.type === 'event' && <span>Runs <b>when it happens</b></span>}
                  {!a.enabled && <span>Paused. It will not run until you switch it on.</span>}
                </div>
                {fail && <p className="ab-fail" role="alert"><b>{fail.step ? `Step ${fail.step} stopped:` : 'It stopped:'}</b> {fail.message}</p>}
                <div className="ab-card__acts">
                  {canEdit && fail?.step > 0 && <button type="button" className="ab-btn ab-btn--small ab-btn--primary" onClick={() => edit(a, fail.step - 1)}>Open step {fail.step}</button>}
                  {canEdit && <button type="button" className="ab-btn ab-btn--small" onClick={() => edit(a)}>Edit</button>}
                  {mine && writable && a.trigger.type === 'schedule' && <button type="button" className="ab-btn ab-btn--small" onClick={async () => { try { await runNow(a); setView({ mode: 'runs', auto: a }); } catch (e) { setError(e.message); } }}>Run now</button>}
                  <button type="button" className="ab-btn ab-btn--small" onClick={() => setView({ mode: 'runs', auto: a })}>Run history</button>
                  <label className="ab-switch ab-card__sw"><input type="checkbox" checked={a.enabled} disabled={!canEdit} onChange={() => toggle(a)} aria-label={`${a.name} enabled`} /><span className="ab-switch__t" aria-hidden="true" />{a.enabled ? 'On' : 'Off'}</label>
                  {canEdit && <button type="button" className="ab-btn ab-btn--small ab-btn--ghost" onClick={() => remove(a)} aria-label={`Delete ${a.name}`}>Delete</button>}
                </div>
              </article>
            );
          })}
          {shown.length === 0 && <p className="muted">Nothing matches this filter.</p>}
        </div>
      )}
      {writable && (
        <section className="ab-tpl" aria-label="Start from a template">
          <h2>Start from a template</h2>
          <div className="ab-tiles">{TEMPLATES.map((t) => <button key={t.name} type="button" className="ab-tile" onClick={() => startNew(JSON.parse(JSON.stringify(t.flow)))}><b>{t.name}</b><span>{t.desc}</span></button>)}</div>
        </section>
      )}
      <EmailTemplates templates={templates} meta={meta} writable={writable} reload={() => api.emailTemplates().then(setTemplates).catch(() => {})} />
    </div>
  );
}
