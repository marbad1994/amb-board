import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, FlaskConical, Play, Plus, Sparkles, Trash2, Workflow, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';

const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FREQ = [['daily', 'Every day'], ['weekdays', 'Every weekday (Mon to Fri)'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['once', 'Once']];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const LABEL = { create_task: 'Create a task', update_task: 'Change the triggering task', add_comment: 'Comment on the triggering task', create_transaction: 'Record a transaction',
  create_note: 'Write a note', create_event: 'Add a calendar event', notify: 'Send me a notification', generate_report: 'Generate a report',
  use_tool: 'Use a tool (web search, built-in skill, connected tool)', ai_text: 'Write text with AI', send_email: 'Send an email',
  scrape: 'Scrape a web page', parse: 'Parse data (JSON, HTML, CSV or your own prompt)', loop: 'Repeat for every item in a list' };
const REPORTS = [['overview', 'Overview'], ['monthly_finance', 'Monthly finance'], ['workload', 'Workload'], ['project_status', 'Project status']];

const DEFAULT_ARGS = {
  create_task: { project_id: '', title: '', due_in_days: '', priority: 'medium' }, update_task: { status: '', priority: '', due_in_days: '' }, add_comment: { text: '' },
  create_transaction: { type: 'expense', amount: '', currency: 'EUR', description: '', category: '', status: 'planned' }, create_note: { title: '', body: '' },
  send_email: { to: ['me'], toText: 'me', template: '', subject: '', body: '' },
  use_tool: { tool: 'web_search', args: { query: '' }, save_as: '' }, ai_text: { instruction: '', input: '', save_as: '' },
  scrape: { url: '', format: 'text', contains: '', max: 50, save_as: '' },
  parse: { input: '', parser: 'json', prompt: '', fieldsText: '', output_format: 'json', save_as: '' },
  loop: { over: '', max_items: 20, on_error: 'stop', steps: [{ type: 'use_tool', args: { tool: 'web_search', args: { query: '{{item}}' }, save_as: '' } }], collect: '', save_as: '' },
  create_event: { title: '', in_days: 1, time: '09:00', timezone: TZ, reminder_minutes: 30 }, notify: { title: '', body: '', link: '/tasks' }, generate_report: { kind: 'overview', project_id: '' },
};

const blank = () => ({ name: '', trigger: { type: 'schedule', frequency: 'weekly', weekday: 1, day: 1, date: '', time: '08:00', timezone: TZ }, steps: [{ type: 'notify', args: { ...DEFAULT_ARGS.notify } }] });

function Field({ label, children, wide }) {
  return <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}><span className="field__label">{label}</span>{children}</label>;
}

function ToolFields({ a, set, tools }) {
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

function EmailFields({ a, set, templates, before, meta, trigger }) {
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
const slug = (v) => v.toLowerCase().replace(/[^a-z0-9_]/g, '');

function ScrapeFields({ a, set }) {
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

function ParseFields({ a, set, before }) {
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
function TestOutput({ r }) {
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

function LoopFields({ a, set, projects, categories, trigger, tools, templates, meta, before, tester }) {
  const body = a.steps || [];
  const setInner = (j, args) => set({ ...a, steps: body.map((s, k) => (k === j ? { ...s, args } : s)) });
  const types = (meta?.steps || Object.keys(LABEL)).filter((s) => s !== 'loop' && (trigger.type === 'event' && trigger.event !== 'transaction_added' ? true : !['update_task', 'add_comment'].includes(s)));
  const names = body.map((s) => s.args?.save_as).filter(Boolean);
  return (
    <div className="flow-row">
      <Field label="Go through this list" wide><input value={a.over} onChange={(e) => set({ ...a, over: e.target.value })} placeholder={before.length ? `e.g. {{result.${before[before.length - 1]}}}  (a JSON list from a Parse or Scrape step)` : '{{result.items}}'} /></Field>
      <Field label="At most (items, max 50)"><input type="number" min="1" max="50" value={a.max_items} onChange={(e) => set({ ...a, max_items: e.target.value })} /></Field>
      <Field label="If an item fails"><select value={a.on_error} onChange={(e) => set({ ...a, on_error: e.target.value })}><option value="stop">Stop the flow</option><option value="continue">Skip it and continue</option></select></Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <p className="hint">For every item run these steps. Use <code>{'{{item}}'}</code>, <code>{'{{item.field}}'}</code>, <code>{'{{index}}'}</code> and <code>{'{{total}}'}</code>. Put a placeholder as the whole value of a tool argument to pass the item as JSON.</p>
        {body.map((s, j) => (
          <div className="flow-step flow-step--inner" key={j}>
            <div className="flow-step__head">
              <span className="num">{j + 1}</span>
              <select aria-label={`Loop step ${j + 1} action`} value={s.type} onChange={(e) => set({ ...a, steps: body.map((y, k) => (k === j ? { type: e.target.value, args: { ...DEFAULT_ARGS[e.target.value] } } : y)) })}>{types.map((st) => <option key={st} value={st}>{LABEL[st]}</option>)}</select>
              <button type="button" className="btn btn-icon btn-ghost" disabled={body.length === 1} onClick={() => set({ ...a, steps: body.filter((_, k) => k !== j) })} aria-label={`Remove loop step ${j + 1}`}><X size={16} /></button>
            </div>
            <StepFields step={s} set={(args) => setInner(j, args)} projects={projects} categories={categories} trigger={trigger} tools={tools} templates={templates} meta={meta} tester={tester} before={[...before, ...body.slice(0, j).map((x) => x.args?.save_as).filter(Boolean)]} />
            {tester && <StepTester step={s} fn={(st) => tester(st, a.over)} label={`Test loop step ${j + 1}`} />}
          </div>
        ))}
        {body.length < 5 && <button type="button" className="btn" onClick={() => set({ ...a, steps: [...body, { type: 'use_tool', args: { ...DEFAULT_ARGS.use_tool } }] })}><Plus size={16} aria-hidden="true" /> Add a step to the loop</button>}
      </div>
      {names.length > 0 && (<>
        <Field label="Collect the result of"><select value={a.collect || ''} onChange={(e) => set({ ...a, collect: e.target.value })}><option value="">Nothing (just run the steps)</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
        {a.collect && <Field label="Save the collected list as"><input value={a.save_as || ''} maxLength={20} onChange={(e) => set({ ...a, save_as: slug(e.target.value) })} placeholder="e.g. details" /></Field>}
      </>)}
    </div>
  );
}

// "Test this step": runs it (reading steps for real, changes only described) and prints the output
function StepTester({ step, fn, label = 'Test this step' }) {
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

function StepFields({ step, set, projects, categories, trigger, tools, templates, before, meta, tester }) {
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
    case 'loop': return <LoopFields a={a} set={set} projects={projects} categories={categories} trigger={trigger} tools={tools} templates={templates} meta={meta} before={before || []} tester={tester} />;
    case 'generate_report': return (<div className="flow-row"><Field label="Report"><select value={a.kind} onChange={up('kind')}>{REPORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      {a.kind === 'project_status' && <Field label="Project">{projectSelect('project_id')}</Field>}</div>);
    default: return trigger && null;
  }
}

const clean = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === '' ? (k.endsWith('_days') || k === 'reminder_minutes' ? null : v) : v]));
// what the server expects for one step (also used for tests); throws a readable error for bad JSON arguments
function cleanStep(s, label) {
  const args = clean(s.args);
  if (s.type === 'use_tool' && args.argsText !== undefined) { try { args.args = args.argsText.trim() ? JSON.parse(args.argsText) : {}; } catch { throw new Error(`Step ${label}: the arguments are not valid JSON`); } }
  delete args.argsText;
  if (s.type === 'send_email') { args.to = String(args.toText ?? (args.to || []).join(',')).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean); delete args.toText; }
  if (s.type === 'parse') { args.fields = String(args.fieldsText ?? (args.fields || []).join(',')).split(/[,\n]/).map((x) => x.trim()).filter(Boolean); delete args.fieldsText; }
  if (s.type === 'loop') args.steps = (args.steps || []).map((x, j) => cleanStep(x, `${label}.${j + 1}`));
  return { type: s.type, args };
}

function Builder({ initial, projects, categories, meta, tools, templates, onSave, onCancel }) {
  const [f, setF] = useState(initial || blank());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const t = f.trigger;
  const setTrigger = (patch) => setF((x) => ({ ...x, trigger: { ...x.trigger, ...patch } }));
  const setStep = (i, args) => setF((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, args } : s)) }));
  const move = (i, d) => setF((x) => { const s = [...x.steps]; const [it] = s.splice(i, 1); s.splice(i + d, 0, it); return { ...x, steps: s }; });
  // results of earlier tests are passed on, so a step is tested with real output of the steps before it
  const [vars, setVars] = useState({});
  const tester = async (step, itemFrom) => {
    const r = await api.testAutomationStep({ step: cleanStep(step, '?'), trigger: t.type === 'event' ? { type: 'event', event: t.event || 'task_done', conditions: t.conditions || {} } : t, vars, item_from: itemFrom || undefined });
    setVars((v) => ({ ...v, ...(r.vars || {}) }));
    return r;
  };
  const [allRes, setAllRes] = useState(null);
  const testAll = async () => {
    setAllRes({ busy: true, lines: [] });
    const lines = []; let local = {};
    for (const [i, s] of f.steps.entries()) {
      try {
        const r = await api.testAutomationStep({ step: cleanStep(s, i + 1), trigger: t.type === 'event' ? { type: 'event', event: t.event || 'task_done', conditions: t.conditions || {} } : t, vars: local });
        local = { ...local, ...(r.vars || {}) }; lines.push({ i, ok: true, r });
      } catch (err) { lines.push({ i, ok: false, r: { ok: false, error: err.message } }); break; }
      setAllRes({ busy: true, lines: [...lines] });
    }
    setVars(local); setAllRes({ busy: false, lines });
  };
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
    const trigger = t.type === 'event' ? { type: 'event', event: t.event || 'task_done', conditions: t.conditions || {} } : t;
    try {
      const steps = f.steps.map((s, i) => cleanStep(s, i + 1));
      await onSave({ name: f.name, trigger, steps });
    } catch (err) { setError(err.message); setBusy(false); }
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
            <StepFields step={s} set={(args) => setStep(i, args)} projects={projects} categories={categories} trigger={t} tools={tools} templates={templates} meta={meta} tester={tester} before={f.steps.slice(0, i).map((x) => x.args?.save_as).filter(Boolean)} />
            {s.type !== 'loop' && <StepTester step={s} fn={tester} />}
            {s.type === 'loop' && <StepTester step={s} fn={tester} label="Test the whole loop (first 3 items)" />}
          </div>
        ))}
        {f.steps.length < 10 && <button type="button" className="btn" onClick={() => setF((x) => ({ ...x, steps: [...x.steps, { type: 'notify', args: { ...DEFAULT_ARGS.notify } }] }))}><Plus size={16} aria-hidden="true" /> Add a step</button>}
        <div style={{ margin: '10px 0' }}>
          <button type="button" className="btn" onClick={testAll} disabled={allRes?.busy}><FlaskConical size={14} aria-hidden="true" /> {allRes?.busy ? 'Testing...' : 'Test all steps in order'}</button>
          <small className="muted"> Reading steps really run; steps that create, notify or email only show what they would do. Nothing is saved.</small>
          {allRes?.lines.map((l) => <div key={l.i}><b>Step {l.i + 1}</b><TestOutput r={l.r} /></div>)}
        </div>
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

function EmailTemplates({ templates, reload, writable, meta }) {
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault(); setError('');
    try { if (form.id) await api.updateEmailTemplate(form.id, form); else await api.createEmailTemplate(form); setForm(null); setPreview(null); reload(); } catch (err) { setError(err.message); }
  };
  const show = async () => { setError(''); try { setPreview(await api.emailPreview({ subject: form.subject, body: form.body })); } catch (err) { setError(err.message); } };
  return (
    <section className="panel" aria-labelledby="et-h" style={{ marginTop: 18 }}>
      <div className="panel__title"><h2 id="et-h">Email templates</h2>{writable && !form && <button type="button" className="btn" onClick={() => setForm({ name: '', subject: '', body: '' })}><Plus size={16} aria-hidden="true" /> New template</button>}</div>
      <p className="hint">A template is a subject and message you can reuse in "Send an email" steps. Use placeholders such as {'{{result.news | pretty | truncate:600}}'}, {'{{date}}'} or {'{{owner.name}}'}; results come from earlier tool or AI steps of the flow.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {form ? (
        <form className="flow-row" onSubmit={save} aria-label="Email template">
          <label className="field"><span className="field__label">Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required /></label>
          <label className="field"><span className="field__label">Subject</span><input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} maxLength={200} required /></label>
          <label className="field" style={{ gridColumn: '1 / -1' }}><span className="field__label">Message</span><textarea rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required /></label>
          <p className="hint" style={{ gridColumn: '1 / -1' }}>Filters: {Object.entries(meta?.filters || {}).map(([k, v]) => `${k} (${v})`).join('; ')}</p>
          <div className="inline-form" style={{ gridColumn: '1 / -1' }}><button type="submit" className="btn btn-primary">Save template</button><button type="button" className="btn" onClick={show}>Preview</button><button type="button" className="btn" onClick={() => { setForm(null); setPreview(null); }}>Cancel</button></div>
          {preview && <div style={{ gridColumn: '1 / -1' }}><p><b>Subject:</b> {preview.subject}</p><iframe title="Template preview" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 300, border: '1px solid var(--color-border)', borderRadius: 10, background: '#fff' }} /></div>}
        </form>
      ) : (
        <ul className="plain-list" aria-label="Email templates list">
          {(templates?.builtin || []).map((t) => (
            <li key={t.key}><span><b>{t.name}</b> <small className="muted">ready-made · {t.subject}</small></span>{writable && <button type="button" className="btn" onClick={() => setForm({ name: `${t.name} (copy)`, subject: t.subject, body: t.body })}>Copy and edit</button>}</li>
          ))}
          {(templates?.custom || []).map((t) => (
            <li key={t.id}><span><b>{t.name}</b> <small className="muted">{t.subject}</small></span>
              {writable && <><button type="button" className="btn" onClick={() => setForm({ id: t.id, name: t.name, subject: t.subject, body: t.body })}>Edit</button>
                <button type="button" className="btn btn-icon btn-ghost" aria-label={`Delete template ${t.name}`} onClick={async () => { if (!window.confirm(`Delete the template "${t.name}"?`)) return; try { await api.deleteEmailTemplate(t.id); reload(); } catch (err) { setError(err.message); } }}><Trash2 size={16} color="var(--color-danger)" /></button></>}</li>
          ))}
        </ul>
      )}
    </section>
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
  const [editing, setEditing] = useState(null);   // null | 'new' | automation
  const [error, setError] = useState('');
  const [result, setResult] = useState({});

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

      {editing && <Builder initial={editing === 'new' ? null : { name: editing.name, trigger: editing.trigger, steps: editing.steps }} projects={projects} categories={categories} meta={meta} tools={tools} templates={templates} onSave={save} onCancel={() => setEditing(null)} />}

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
      {!editing && <EmailTemplates templates={templates} meta={meta} writable={writable} reload={() => api.emailTemplates().then(setTemplates).catch(() => {})} />}
    </div>
  );
}
