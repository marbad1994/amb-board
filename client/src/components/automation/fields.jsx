import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { api } from '../../api/client.js';


export const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const FREQ = [['daily', 'Every day'], ['weekdays', 'Every weekday (Mon to Fri)'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['once', 'Once']];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const LABEL = { create_task: 'Create a task', update_task: 'Change the triggering task', add_comment: 'Comment on the triggering task', create_transaction: 'Record a transaction',
  create_note: 'Write a note', create_event: 'Add a calendar event', notify: 'Send me a notification', generate_report: 'Generate a report',
  use_tool: 'Use a tool (web search, built-in skill, connected tool)', ai_text: 'Write text with AI', send_email: 'Send an email',
  scrape: 'Scrape a web page', parse: 'Parse data (JSON, HTML, CSV or your own prompt)', loop: 'Repeat for every item in a list' };
export const REPORTS = [['overview', 'Overview'], ['monthly_finance', 'Monthly finance'], ['workload', 'Workload'], ['project_status', 'Project status']];

export const DEFAULT_ARGS = {
  create_task: { project_id: '', title: '', due_in_days: '', priority: 'medium' }, update_task: { status: '', priority: '', due_in_days: '' }, add_comment: { text: '' },
  create_transaction: { type: 'expense', amount: '', currency: 'EUR', description: '', category: '', status: 'planned' }, create_note: { title: '', body: '' },
  send_email: { to: ['me'], toText: 'me', template: '', subject: '', body: '' },
  use_tool: { tool: 'web_search', args: { query: '' }, save_as: '' }, ai_text: { instruction: '', input: '', save_as: '' },
  scrape: { url: '', format: 'text', contains: '', max: 50, save_as: '' },
  parse: { input: '', parser: 'json', prompt: '', fieldsText: '', output_format: 'json', save_as: '' },
  loop: { over: '', max_items: 20, on_error: 'stop', steps: [{ type: 'use_tool', args: { tool: 'web_search', args: { query: '{{item}}' }, save_as: '' } }], collect: '', save_as: '' },
  create_event: { title: '', in_days: 1, time: '09:00', timezone: TZ, reminder_minutes: 30 }, notify: { title: '', body: '', link: '/tasks' }, generate_report: { kind: 'overview', project_id: '' },
};

export const blank = () => ({ name: '', trigger: { type: 'schedule', frequency: 'weekly', weekday: 1, day: 1, date: '', time: '08:00', timezone: TZ }, steps: [{ type: 'notify', args: { ...DEFAULT_ARGS.notify } }] });

export function Field({ label, children, wide }) {
  return <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}><span className="field__label">{label}</span>{children}</label>;
}

export function ToolFields({ a, set, tools }) {
  const group = a.tool === 'web_search' || a.tool === 'read_web_page' ? a.tool : a.tool === 'external' ? 'external' : 'internal';
  const server = tools?.servers?.find((s) => s.name === a.server);
  const ext = server?.tools?.find((t) => t.name === a.external_tool);
  const setGroup = (g) => set(g === 'web_search' ? { tool: 'web_search', args: { query: '' }, save_as: a.save_as } : g === 'read_web_page' ? { tool: 'read_web_page', args: { url: '' }, save_as: a.save_as }
    : g === 'external' ? { tool: 'external', server: tools?.servers?.[0]?.name || '', external_tool: '', args: {}, argsText: '{}', save_as: a.save_as } : { tool: tools?.internal?.[0]?.name || 'list_tasks', args: {}, argsText: '{}', save_as: a.save_as });
  return (
    <div className="flow-row">
      <label className="field"><span className="field__label">Tool</span>
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="web_search">Search the web</option><option value="read_web_page">Read a web page</option>
          <option value="internal">Built-in skill (tasks, spending, projects...)</option><option value="external" disabled={!tools?.servers?.length}>Connected tool (MCP){tools?.servers?.length ? '' : ' - none connected'}</option>
        </select></label>
      {group === 'web_search' && <label className="field" style={{ gridColumn: '1 / -1' }}><span className="field__label">Search for</span><input value={a.args?.query || ''} onChange={(e) => set({ args: { query: e.target.value } })} placeholder="e.g. interest rates Romania today" /></label>}
      {group === 'read_web_page' && <label className="field" style={{ gridColumn: '1 / -1' }}><span className="field__label">Page address (https)</span><input value={a.args?.url || ''} onChange={(e) => set({ args: { url: e.target.value } })} placeholder="https://..." /></label>}
      {group === 'internal' && (<>
        <label className="field"><span className="field__label">Skill</span><select value={a.tool} onChange={(e) => set({ tool: e.target.value })}>{(tools?.internal || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</select></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span className="field__label">Arguments (JSON, optional)</span><input value={a.argsText ?? JSON.stringify(a.args || {})} onChange={(e) => set({ argsText: e.target.value })} /></label>
        <p className="hint" style={{ gridColumn: '1 / -1' }}>{(tools?.internal || []).find((t) => t.name === a.tool)?.doc}</p>
      </>)}
      {group === 'external' && (<>
        <label className="field"><span className="field__label">Server</span><select value={a.server || ''} onChange={(e) => set({ server: e.target.value, external_tool: '' })}>{(tools?.servers || []).map((s) => <option key={s.name}>{s.name}</option>)}</select></label>
        <label className="field"><span className="field__label">Tool</span><select value={a.external_tool || ''} onChange={(e) => set({ external_tool: e.target.value, allow_write: false })}><option value="">Choose a tool</option>{(server?.tools || []).map((t) => <option key={t.name} value={t.name}>{t.name}{t.read_only ? ' (read-only)' : ' (can change data)'}</option>)}</select></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span className="field__label">Arguments (JSON)</span><input value={a.argsText ?? JSON.stringify(a.args || {})} onChange={(e) => set({ argsText: e.target.value })} /></label>
        {ext && !ext.read_only && <label className="check" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={!!a.allow_write} onChange={(e) => set({ allow_write: e.target.checked })} /> I allow this automation to change data in "{a.server}" every time it runs</label>}
        {server?.error && <p className="form-error" style={{ gridColumn: '1 / -1' }}>{server.error}</p>}
      </>)}
      <label className="field"><span className="field__label">Save the result as</span><input value={a.save_as || ''} maxLength={20} onChange={(e) => set({ save_as: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} placeholder="e.g. news" /></label>
      {a.save_as && <p className="hint" style={{ alignSelf: 'end' }}>Later steps can use it as {'{{result.' + a.save_as + '}}'}</p>}
    </div>
  );
}

export function EmailFields({ a, set, templates, before, meta, trigger }) {
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const chips = ['date', 'weekday', 'owner.name', ...before.map((n) => `result.${n} | pretty`), ...(trigger?.type === 'event' ? ['trigger.title', 'trigger.project'] : [])];
  const add = (p) => set({ ...a, body: `${a.body || ''}${a.body && !a.body.endsWith('\n') ? ' ' : ''}{{${p}}}` });
  const show = async () => {
    setErr('');
    try { setPreview(await api.emailPreview({ template: a.template || undefined, subject: a.subject || undefined, body: a.body || undefined })); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="flow-row">
      {meta && !meta.email_configured && <p className="form-error" style={{ gridColumn: '1 / -1' }}>Email is not set up on this server yet, so this step cannot be saved. The administrator adds the SMTP settings.</p>}
      <label className="field" style={{ gridColumn: '1 / -1' }}><span className="field__label">To (comma separated; "me" is you; up to 5)</span>
        <input value={a.toText ?? (a.to || []).join(', ')} onChange={(e) => set({ ...a, toText: e.target.value })} placeholder="me, name@example.com" /></label>
      <label className="field"><span className="field__label">Template</span>
        <select value={a.template || ''} onChange={(e) => set({ ...a, template: e.target.value })}>
          <option value="">No template (write it here)</option>
          {(templates?.builtin || []).length > 0 && <optgroup label="Ready-made">{templates.builtin.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</optgroup>}
          {(templates?.custom || []).length > 0 && <optgroup label="Your templates">{templates.custom.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}
        </select></label>
      <label className="field"><span className="field__label">Subject{a.template ? ' (empty = from the template)' : ''}</span><input value={a.subject || ''} onChange={(e) => set({ ...a, subject: e.target.value })} maxLength={200} placeholder="e.g. News summary {{date}}" /></label>
      <label className="field" style={{ gridColumn: '1 / -1' }}><span className="field__label">Message{a.template ? ' (empty = from the template)' : ''}</span>
        <textarea rows={6} value={a.body || ''} onChange={(e) => set({ ...a, body: e.target.value })} placeholder={'# Heading\n\nText with {{result.news | pretty}}\n\n- list item\n\n[link](https://...)'} /></label>
      <div style={{ gridColumn: '1 / -1' }} aria-label="Insert a placeholder">
        <small className="muted">Insert: </small>{chips.map((c) => <button key={c} type="button" className="btn btn-ghost" style={{ padding: '2px 8px', minHeight: 0 }} onClick={() => add(c)}>{`{{${c}}}`}</button>)}
        <p className="hint">Filters change a value: {Object.entries(meta?.filters || {}).slice(0, 5).map(([k, v]) => `${k} (${v})`).join('; ')}. Formatting: # heading, - list, **bold**, [text](https://link).</p>
      </div>
      <div style={{ gridColumn: '1 / -1' }}><button type="button" className="btn" onClick={show}>Preview with sample data</button></div>
      {err && <p className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</p>}
      {preview && <div style={{ gridColumn: '1 / -1' }}><p><b>Subject:</b> {preview.subject}</p><iframe title="Email preview" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 280, border: '1px solid var(--color-border)', borderRadius: 10, background: '#fff' }} /></div>}
    </div>
  );
}

const SCRAPE_FORMATS = [['text', 'Readable text'], ['links', 'Links (text and address)'], ['feed', 'RSS or Atom feed items'], ['json', 'JSON from an address'], ['meta', 'Title, description, headings'], ['html', 'Cleaned HTML']];
const PARSERS = [['json', 'JSON (default)'], ['html', 'HTML page'], ['xml', 'XML or RSS'], ['csv', 'CSV or table text'], ['markdown', 'Markdown'], ['text', 'Plain text'], ['custom', 'Custom: write my own parsing prompt']];
const OUTPUTS = [['json', 'JSON (default)'], ['csv', 'CSV'], ['markdown_table', 'Markdown table'], ['bullets', 'Bullet list'], ['text', 'Plain text']];
export const slug = (v) => v.toLowerCase().replace(/[^a-z0-9_]/g, '');

export function ScrapeFields({ a, set }) {
  return (
    <div className="flow-row">
      <Field label="Page address (https)" wide><input value={a.url} onChange={(e) => set({ ...a, url: e.target.value })} placeholder="https://example.com/news  (inside a loop: {{item.url}})" /></Field>
      <Field label="Get"><select value={a.format} onChange={(e) => set({ ...a, format: e.target.value })}>{SCRAPE_FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      {a.format === 'links' && <Field label="Only links containing"><input value={a.contains || ''} onChange={(e) => set({ ...a, contains: e.target.value })} placeholder="e.g. /article/" /></Field>}
      {(a.format === 'links' || a.format === 'feed') && <Field label="At most (items)"><input type="number" min="1" max="300" value={a.max} onChange={(e) => set({ ...a, max: e.target.value })} /></Field>}
      <Field label="Save the result as"><input value={a.save_as} maxLength={20} onChange={(e) => set({ ...a, save_as: slug(e.target.value) })} placeholder="e.g. page" /></Field>
      <p className="hint" style={{ gridColumn: '1 / -1' }}>Fetches one public page. Use it next as {'{{result.' + (a.save_as || 'name') + '}}'}: give it to a Parse step, or to a loop when you chose links or feed items.</p>
    </div>
  );
}

export function ParseFields({ a, set, before }) {
  const custom = a.parser === 'custom';
  return (
    <div className="flow-row">
      <Field label="Data to parse" wide><textarea rows={2} value={a.input} onChange={(e) => set({ ...a, input: e.target.value })} placeholder={before.length ? `e.g. {{result.${before[before.length - 1]}}}` : 'e.g. {{result.page}}'} /></Field>
      <Field label="The data is"><select value={a.parser} onChange={(e) => set({ ...a, parser: e.target.value })}>{PARSERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Give me (output format, optional)"><select value={a.output_format} onChange={(e) => set({ ...a, output_format: e.target.value })}>{OUTPUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Which data do you want? (comma separated, optional)" wide><input value={a.fieldsText ?? (a.fields || []).join(', ')} onChange={(e) => set({ ...a, fieldsText: e.target.value })} placeholder="e.g. title, price, url  (empty = everything useful)" /></Field>
      {custom && <Field label="Your parsing prompt" wide><textarea rows={4} maxLength={2000} value={a.prompt || ''} onChange={(e) => set({ ...a, prompt: e.target.value })} placeholder="Describe exactly what to extract and how to shape it. Example: List every product with its price in EUR as a number; skip sold-out items." /></Field>}
      {!custom && <Field label="Extra guidance (optional)" wide><input value={a.prompt || ''} maxLength={2000} onChange={(e) => set({ ...a, prompt: e.target.value })} placeholder="e.g. only items released this year" /></Field>}
      <Field label="Save the result as"><input value={a.save_as} maxLength={20} onChange={(e) => set({ ...a, save_as: slug(e.target.value) })} placeholder="e.g. items" /></Field>
      <p className="hint" style={{ alignSelf: 'end' }}>A fixed, hardened AI prompt does the parsing: text in the data is never obeyed, values are never invented, JSON is checked. JSON that needs no change costs no AI call.</p>
    </div>
  );
}

// formatted output of a test run
export function TestOutput({ r }) {
  if (!r) return null;
  let shown = r.output || '';
  try { shown = JSON.stringify(JSON.parse(shown), null, 2); } catch { /* not JSON */ }
  return (
    <div className="flow-test" aria-label="Test result" role="status">
      {r.error ? <p className="form-error">Test failed: {r.error}</p> : <p><b>Test result:</b> {r.message}</p>}
      {shown && <pre className="flow-test__out" tabIndex={0}>{shown.length > 6000 ? `${shown.slice(0, 6000)}\n... (${shown.length - 6000} more characters)` : shown}</pre>}
      {r.log?.length > 0 && <ul className="flow-log" aria-label="Items">{r.log.map((l, i) => <li key={i} className={l.ok ? '' : 'flow-run--failed'}>Step {l.step}: {l.message}{l.output && <pre className="flow-test__out">{l.output.slice(0, 600)}</pre>}</li>)}</ul>}
    </div>
  );
}

export function LoopSettings({ a, set, before }) {
  const names = (a.steps || []).map((s) => s.args?.save_as).filter(Boolean);
  return (
    <div className="flow-row">
      <Field label="Go through this list" wide><input value={a.over} onChange={(e) => set({ ...a, over: e.target.value })} placeholder={before.length ? `e.g. {{result.${before[before.length - 1]}}}  (a JSON list from a Parse or Scrape step)` : '{{result.items}}'} /></Field>
      <Field label="At most (items, max 50)"><input type="number" min="1" max="50" value={a.max_items} onChange={(e) => set({ ...a, max_items: e.target.value })} /></Field>
      <Field label="If an item fails"><select value={a.on_error} onChange={(e) => set({ ...a, on_error: e.target.value })}><option value="stop">Stop the flow</option><option value="continue">Skip it and continue</option></select></Field>
      {names.length > 0 ? (<>
        <Field label="Collect the result of"><select value={a.collect || ''} onChange={(e) => set({ ...a, collect: e.target.value })}><option value="">Nothing (just run the steps)</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
        {a.collect && <Field label="Save the collected list as"><input value={a.save_as || ''} maxLength={20} onChange={(e) => set({ ...a, save_as: slug(e.target.value) })} placeholder="e.g. details" /></Field>}
      </>) : <p className="hint" style={{ gridColumn: '1 / -1' }}>Add a step to the loop that saves a result (a scrape, parse, tool or AI step) to collect one result per item.</p>}
    </div>
  );
}

// "Test this step": runs it (reading steps for real, changes only described) and prints the output
export function StepTester({ step, fn, label = 'Test this step' }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setRes(await fn(step)); } catch (err) { setRes({ ok: false, error: err.message }); } finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" className="btn" onClick={run} disabled={busy}><FlaskConical size={14} aria-hidden="true" /> {busy ? 'Testing...' : label}</button>
      <TestOutput r={res} />
    </div>
  );
}

export function StepFields({ step, set, projects, categories, trigger, tools, templates, before, meta, tester }) {
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
    case 'send_email': return <EmailFields a={a} set={set} templates={templates} before={before || []} meta={meta} trigger={trigger} />;
    case 'use_tool': return <ToolFields a={a} set={(patch) => set({ ...a, ...patch })} tools={tools} />;
    case 'ai_text': return (<div className="flow-row">
      <Field label="What should the AI write?" wide><input value={a.instruction} onChange={up('instruction')} maxLength={1000} placeholder="e.g. Summarise the news below in 3 bullet points" /></Field>
      <Field label="Material to use" wide><textarea rows={2} value={a.input} onChange={up('input')} placeholder="e.g. {{result.news}}" /></Field>
      <Field label="Save the text as"><input value={a.save_as} maxLength={20} onChange={(e) => set({ ...a, save_as: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} placeholder="e.g. summary" /></Field>
      <p className="hint" style={{ alignSelf: 'end' }}>Counts against the daily AI limit. Use it later as {'{{result.' + (a.save_as || 'name') + '}}'}</p></div>);
    case 'scrape': return <ScrapeFields a={a} set={set} />;
    case 'parse': return <ParseFields a={a} set={set} before={before || []} />;
    case 'loop': return <LoopSettings a={a} set={set} before={before || []} />;
    case 'generate_report': return (<div className="flow-row"><Field label="Report"><select value={a.kind} onChange={up('kind')}>{REPORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      {a.kind === 'project_status' && <Field label="Project">{projectSelect('project_id')}</Field>}</div>);
    default: return trigger && null;
  }
}

export const clean = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === '' ? (k.endsWith('_days') || k === 'reminder_minutes' ? null : v) : v]));
// what the server expects for one step (also used for tests); throws a readable error for bad JSON arguments
export function cleanStep(s, label) {
  const args = clean(s.args);
  if (s.type === 'use_tool' && args.argsText !== undefined) { try { args.args = args.argsText.trim() ? JSON.parse(args.argsText) : {}; } catch { throw new Error(`Step ${label}: the arguments are not valid JSON`); } }
  delete args.argsText;
  if (s.type === 'send_email') { args.to = String(args.toText ?? (args.to || []).join(',')).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean); delete args.toText; }
  if (s.type === 'parse') { args.fields = String(args.fieldsText ?? (args.fields || []).join(',')).split(/[,\n]/).map((x) => x.trim()).filter(Boolean); delete args.fieldsText; }
  if (s.type === 'loop') args.steps = (args.steps || []).map((x, j) => cleanStep(x, `${label}.${j + 1}`));
  return { type: s.type, args };
}

