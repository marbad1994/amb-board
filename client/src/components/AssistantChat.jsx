import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Calendar, Check, FileBarChart, FlaskConical, GitBranch, Info, Pencil, RefreshCw, Search, Send, ShieldCheck, Square, ThumbsDown, ThumbsUp, Wallet } from 'lucide-react';
import { api } from '../api/client.js';

// Proposals that can also be opened in the normal form to edit before saving.
const EDITABLE = new Set(['create_task', 'create_event', 'create_transaction']);
const START = [
  ['What is overdue?', Search, 'What is overdue?'], ['Plan my week', Calendar, 'Plan my week'],
  ['Review my budget', Wallet, 'How am I doing on my budget this month?'], ['Build an automation', GitBranch, '/create-automation'],
];

const hhmm = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const dayLabel = (iso) => {
  const d = new Date(iso); const now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const day = same(d, now) ? 'Today' : same(d, y) ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${hhmm(iso)}`;
};
// A long answer reads better as short sequential bubbles, one idea each.
const bubbles = (text) => String(text || '').split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
const seconds = (ms) => (ms < 950 ? `${(Math.max(ms, 100) / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(1)} s`);

function Proposal({ p, onDecide, onEdit, disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const danger = /^DELETE/.test(p.description);
  const run = async (fn) => { setBusy(true); setError(''); try { onDecide(await fn(p.id)); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const edit = async () => {
    setBusy(true); setError('');
    try { onDecide(await api.rejectProposal(p.id)); onEdit(p); } catch (err) { setError(err.message); setBusy(false); }
  };
  const label = p.status === 'approved' ? 'Applied' : p.status === 'failed' ? 'Not applied' : p.status === 'expired' ? 'Expired' : p.status === 'rejected' ? 'Not applied'
    : danger ? 'Cannot be undone' : p.type === 'connect_mcp_server' ? 'Connect a tool' : p.type === 'setup_plan' ? `Setup plan: ${p.payload?.steps?.length ?? 0} steps, approved together` : 'Suggested change';
  return (
    <div className={`ac-card ac-card--${p.status}${danger && p.status === 'pending' ? ' ac-card--danger' : ''}`}>
      <span className="ac-card__label">{label}</span>
      <p className="ac-card__text">{p.description}</p>
      {p.status === 'pending' && p.type === 'connect_mcp_server' && (
        <label className="field"><span className="field__label">Access token for this server (optional, stored encrypted, never shown to the assistant)</span>
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      )}
      {p.status === 'approved' && <p className="ac-card__note">{p.result?.auto ? 'Applied automatically (you allowed this type in Workspace and account).' : 'Done.'}</p>}
      {p.status === 'rejected' && <p className="ac-card__note">You chose not to apply this.</p>}
      {p.status === 'failed' && <p className="ac-card__note">{p.result?.error || 'It no longer matches your data, so nothing was changed.'}</p>}
      {p.status === 'expired' && <p className="ac-card__note">This suggestion is more than a day old. Ask me again if you still want it.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {p.status === 'pending' && (
        <div className="ac-acts">
          <button type="button" className={`ac-btn ${danger ? 'ac-btn--danger' : 'ac-btn--primary'}`} disabled={busy || disabled} onClick={() => run((id) => api.approveProposal(id, p.type === 'connect_mcp_server' ? { token } : {}))}>
            <Check size={16} aria-hidden="true" /> {danger ? 'Delete it' : 'Approve'}</button>
          {EDITABLE.has(p.type) && <button type="button" className="ac-btn" disabled={busy || disabled} onClick={edit}><Pencil size={16} aria-hidden="true" /> Edit first</button>}
          <button type="button" className="ac-btn" disabled={busy || disabled} onClick={() => run(api.rejectProposal)}>{danger ? 'Keep it' : 'Not now'}</button>
        </div>
      )}
    </div>
  );
}

function Steps({ steps, writing }) {
  return (
    <div className="ac-steps" role="status" aria-live="polite" aria-label="What I am doing">
      {steps.map((s) => (
        <div key={s.id} className={`ac-step ac-step--${s.state}`}>
          <span className="ac-dot" aria-hidden="true">{s.state === 'done' ? <Check size={11} strokeWidth={3.4} /> : s.state === 'failed' ? '!' : null}</span>
          <span>{s.label}</span>{s.state === 'running' ? <small>working</small> : s.ms != null && <small>{seconds(s.ms)}</small>}
        </div>
      ))}
      <div className={`ac-step ${writing ? 'ac-step--running' : 'ac-step--wait'}`}><span className="ac-dot" aria-hidden="true" /><span>Writing the answer</span></div>
    </div>
  );
}

function TestBlock({ summary }) {
  return (
    <div className="ac-test">
      <span className="ac-card__label"><FlaskConical size={13} aria-hidden="true" /> Test result</span>
      <p>{summary.message}</p>
      {summary.output && <pre className="ac-test__out" tabIndex={0}>{summary.output}</pre>}
      <small>Test only. Nothing was saved and nothing was sent.</small>
    </div>
  );
}

// The conversation itself, used by the full Assistant page and by the always-available dock.
// `autoSend` is a prompt to send immediately (from a suggestion); `onAutoSent` clears it.
export default function AssistantChat({ conversationId, onConversation, context, writable, compact, autoSend, onAutoSent, onNavigate }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null);           // { steps, text } while an answer is being produced
  const [error, setError] = useState(null);         // { kind, message, retry }
  const [skill, setSkill] = useState(null);
  const [progress, setProgress] = useState(null);
  const [library, setLibrary] = useState([]);
  const [pick, setPick] = useState(0);
  const endRef = useRef(null);
  const convRef = useRef(conversationId);
  const abortRef = useRef(null);
  const areaRef = useRef(null);
  const lastSent = useRef('');

  useEffect(() => { convRef.current = conversationId; }, [conversationId]);
  const sync = useCallback((id) => api.getConversation(id).then((c) => { setMessages(c.messages); setSkill(c.skill ?? null); setProgress([...c.messages].reverse().find((m) => m.role === 'assistant')?.progress ?? null); }), []);
  useEffect(() => {
    let stale = false;
    if (!conversationId) { setMessages([]); setSkill(null); setProgress(null); return undefined; }
    if (messages.length && messages.some((m) => m.id?.startsWith?.('tmp-'))) return undefined;
    sync(conversationId).catch((err) => { if (!stale) { setError({ kind: 'missing', message: err.message }); onConversation?.(null); } });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  useEffect(() => { if (writable) api.skillLibrary().then(setLibrary).catch(() => {}); }, [writable]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [messages, live, error]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async (preset, opts = {}) => {
    const message = (preset ?? text).trim();
    if (!message || busy) return;
    setBusy(true); setError(null); setText(''); lastSent.current = message;
    if (areaRef.current) areaRef.current.style.height = 'auto';
    if (!opts.retry) setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: message, created_at: new Date().toISOString(), proposals: [], tool_trace: [], artifacts: [] }]);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    let acc = '';
    setLive({ steps: [], text: '' });
    try {
      await api.chatStream({ message, conversationId: convRef.current, context }, {
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === 'step') setLive((l) => ({ ...l, steps: l.steps.some((s) => s.id === e.id) ? l.steps.map((s) => (s.id === e.id ? { ...s, ...e } : s)) : [...l.steps, e] }));
          else if (e.type === 'delta') { acc += e.text; setLive((l) => ({ ...l, text: acc })); } else if (e.type === 'reset') { acc = ''; setLive((l) => ({ ...l, text: '' })); } else if (e.type === 'done') {
            convRef.current = e.conversationId; onConversation?.(e.conversationId);
            setSkill(e.skill ?? null); setProgress(e.message.progress ?? null);
            setMessages((m) => [...m, { ...e.message, dropped: e.dropped?.length || 0, droppedList: (e.dropped || []).slice(0, 6) }]);
          } else if (e.type === 'error') { const err = new Error(e.message); err.status = e.status; throw err; }
        },
      });
    } catch (err) {
      if (err.name === 'AbortError' || ctrl.signal.aborted) {
        // Stop: the server keeps what was written; show it now and sync the stored version
        if (acc) setMessages((m) => [...m, { id: `tmp-partial-${Date.now()}`, role: 'assistant', content: acc, incomplete: true, created_at: new Date().toISOString(), proposals: [], tool_trace: [], artifacts: [] }]);
        setTimeout(() => { if (convRef.current) sync(convRef.current).catch(() => {}); }, 600);
      } else {
        const status = err.status ?? 0;
        if (acc) setMessages((m) => [...m, { id: `tmp-partial-${Date.now()}`, role: 'assistant', content: acc, incomplete: true, created_at: new Date().toISOString(), proposals: [], tool_trace: [], artifacts: [] }]);
        setError({ kind: status === 429 ? 'limit' : status === 503 ? 'unavailable' : status === 404 ? 'missing' : 'technical', message: err.message, retry: !acc && status !== 429 && status !== 503 });
        if (acc && convRef.current) setTimeout(() => sync(convRef.current).catch(() => {}), 600);
      }
    } finally { setBusy(false); setLive(null); abortRef.current = null; }
  }, [text, busy, context, onConversation, sync]);

  useEffect(() => { if (autoSend && writable) { onAutoSent?.(); send(autoSend); } }, [autoSend]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopGenerating = () => abortRef.current?.abort();
  const stopSkill = async () => { setError(null); try { if (convRef.current) await api.stopSkill(convRef.current); setSkill(null); setProgress(null); } catch (err) { setError({ kind: 'technical', message: err.message }); } };
  const rate = async (m, value) => {
    const next = m.feedback === value ? '' : value;
    setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, feedback: next || null } : x)));
    try { await api.rateMessage(m.id, next); } catch (err) { setError({ kind: 'technical', message: err.message }); setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, feedback: m.feedback ?? null } : x))); }
  };
  const update = (u) => setMessages((ms) => ms.map((m) => ({ ...m, proposals: (m.proposals || []).map((p) => (p.id === u.id ? { ...p, ...u } : p)) })));

  // "Edit first": open the real form with the proposed values filled in
  const edit = (p) => {
    onNavigate?.();
    const v = p.payload;
    if (p.type === 'create_task') window.dispatchEvent(new CustomEvent('amb:quick-add', { detail: { title: v.title, projectId: v.project_id, due_date: v.due_date || '', priority: v.priority } }));
    if (p.type === 'create_event') navigate('/calendar', { state: { prefillEvent: v } });
    if (p.type === 'create_transaction') navigate('/finance', { state: { prefillTx: v } });
  };

  const slash = /^\/[\w-]*$/.test(text) ? library.filter((s) => `/${s.name}`.startsWith(text.toLowerCase())).slice(0, 6) : [];
  useEffect(() => { setPick(0); }, [text]);
  const onKey = (e) => {
    if (slash.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick((i) => (i + 1) % slash.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick((i) => (i + slash.length - 1) % slash.length); return; }
      if (e.key === 'Tab') { e.preventDefault(); setText(`/${slash[pick].name} `); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setText(''); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(`/${slash[pick].name}`); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  const grow = (e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`; };

  const last = messages.length - 1;
  const intro = messages.length === 0 && !busy;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || lastSent.current;

  let prevDay = '';
  return (
    <div className={`ac ${compact ? 'ac--compact' : ''}`}>
      <div className="ac-trust"><ShieldCheck size={14} aria-hidden="true" /><span>I read your workspace and suggest changes. Nothing changes until you approve it.</span></div>
      {skill && (
        <div className="ac-skill" role="status">
          <div className="ac-skill__name"><b>/{skill}</b>{progress && <small>Step {progress.step} of {progress.of}</small>}</div>
          {progress && <div className="ac-bar" aria-hidden="true"><i style={{ width: `${Math.round((progress.step / progress.of) * 100)}%` }} /></div>}
          <button type="button" className="ac-btn ac-btn--small" onClick={stopSkill}><Square size={12} aria-hidden="true" /> Stop</button>
        </div>
      )}
      <div className="ac-thread">
        {intro && (
          <div className="ac-intro">
            <h3>Ask about your workspace, or have me set things up</h3>
            <p>I know your projects, tasks, money, calendar and automations in AMB Board. Pick something to start, or type your own request.</p>
            <div className="ac-can">
              <div><b>I can</b>Read and analyse your data. Propose tasks, events, budgets and flows. Search the web.</div>
              <div><b>I cannot</b>Change anything without your approval. Manage members, passwords or access.</div>
            </div>
            <div className="ac-start">
              {START.map(([label, Icon, msg]) => <button key={label} type="button" className="ac-task" disabled={!writable} onClick={() => send(msg)}><span className="ac-task__i"><Icon size={16} aria-hidden="true" /></span>{label}</button>)}
            </div>
            <p className="ac-hint">Type / to see skills such as /add-task or /add-transaction.</p>
          </div>
        )}
        {messages.map((m, i) => {
          const day = m.created_at ? new Date(m.created_at).toDateString() : '';
          const divider = day && day !== prevDay ? dayLabel(m.created_at) : null; if (day) prevDay = day;
          const trace = m.tool_trace || [];
          const past = [...new Set(trace.filter((t) => t.label).map((t) => t.label))];
          const ms = trace.reduce((a, t) => a + (t.ms || 0), 0);
          const sources = [...new Set(trace.map((t) => t.source).filter(Boolean))];
          const parts = m.role === 'assistant' ? bubbles(m.content) : [];
          return (
            <div className="ac-turn" key={m.id}>
              {divider && <div className="ac-day">{divider}</div>}
              {m.role === 'user' ? (
                <>
                  <div className="ac-u"><span className="sr-only">You: </span>{m.content}</div>
                  {m.created_at && <div className="ac-time ac-time--r">{hhmm(m.created_at)}</div>}
                </>
              ) : (
                <>
                  <span className="sr-only">Assistant: </span>
                  {past.length > 0 && <div className="ac-work"><Check size={13} strokeWidth={3} aria-hidden="true" /> {past.join(', ')}{ms >= 100 ? ` · ${seconds(ms)}` : ''}</div>}
                  {parts.map((t, k) => <div className="ac-b" key={k}>{t}</div>)}
                  {sources.length > 0 && <div className="ac-src" aria-label="Based on">{sources.map((s) => <span key={s}>{s}</span>)}</div>}
                  {trace.filter((t) => t.summary).map((t, k) => <TestBlock key={k} summary={t.summary} />)}
                  {m.artifacts?.map((a) => (
                    <Link key={a.id} to={`/reports/${a.id}`} className="artifact" onClick={() => onNavigate?.()}><FileBarChart size={16} aria-hidden="true" /> <span>Report ready: <b>{a.title}</b></span></Link>
                  ))}
                  {m.proposals?.map((p) => <Proposal key={p.id} p={p} onDecide={update} onEdit={edit} disabled={!writable} />)}
                  {m.dropped > 0 && (
                    <div className="ac-sys"><Info size={13} aria-hidden="true" /> {m.dropped} suggested change{m.dropped > 1 ? 's were' : ' was'} discarded because {m.dropped > 1 ? 'they' : 'it'} did not match your data
                      {m.droppedList?.length > 0 && <> ({m.droppedList.map((d) => `${String(d.type).replace(/_/g, ' ')}: ${d.reason}`).join('; ')})</>}. Tell me what to correct and I will try again.</div>
                  )}
                  {m.incomplete && (
                    <div className="ac-sys ac-sys--warn"><AlertTriangle size={13} aria-hidden="true" /> Incomplete: it was stopped or the connection dropped.</div>
                  )}
                  {m.incomplete && i === last && !busy && writable && (
                    <div className="ac-acts">
                      <button type="button" className="ac-btn ac-btn--primary" onClick={() => send('Continue from where you stopped.')}>Continue</button>
                      <button type="button" className="ac-btn" onClick={() => send(lastUser)}>Start again</button>
                    </div>
                  )}
                  {m.suggestions?.length > 0 && i === last && !busy && writable && (
                    <div className="ac-chips" role="group" aria-label="Suggested replies">
                      {m.suggestions.map((sg) => <button key={sg} type="button" className="ac-chip" onClick={() => send(sg)}>{sg}</button>)}
                    </div>
                  )}
                  {!String(m.id).startsWith('tmp-') && (
                    <div className="ac-rate" role="group" aria-label="Rate this answer">
                      <button type="button" className="ac-ib" aria-label="Good answer" aria-pressed={m.feedback === 'up'} onClick={() => rate(m, 'up')}><ThumbsUp size={15} aria-hidden="true" /></button>
                      <button type="button" className="ac-ib" aria-label="Poor answer" aria-pressed={m.feedback === 'down'} onClick={() => rate(m, 'down')}><ThumbsDown size={15} aria-hidden="true" /></button>
                      <small>AI-generated. Check figures in the app.</small>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
        {busy && live && (
          <div className="ac-turn">
            {(live.steps.length > 0 || live.text) && <Steps steps={live.steps} writing={!!live.text} />}
            {live.text ? bubbles(live.text).map((t, k, a) => <div className="ac-b" key={k}>{t}{k === a.length - 1 && <span className="ac-caret" aria-hidden="true" />}</div>)
              : live.steps.length === 0 && <div className="ac-b ac-b--dots"><span className="ac-dots" role="img" aria-label="The assistant is thinking"><i /><i /><i /></span></div>}
          </div>
        )}
        {error && (
          <div className={`ac-err ac-err--${error.kind}`} role="alert">
            <b><AlertTriangle size={16} aria-hidden="true" /> {error.kind === 'limit' ? 'The AI limit for today is used up' : error.kind === 'unavailable' ? 'The assistant is not available right now' : error.kind === 'missing' ? 'That conversation is gone' : 'I could not reach the AI service'}</b>
            <p>{error.kind === 'limit' ? `${error.message} It resets at midnight UTC. You can still use the app and your automations.` : error.kind === 'unavailable' ? `${error.message} Ask the person who runs this server to set up an AI key.` : error.kind === 'missing' ? 'Start a new chat to continue.' : 'Your message is saved and nothing was changed. This is usually brief.'}</p>
            {error.retry && <div className="ac-acts"><button type="button" className="ac-btn ac-btn--primary" onClick={() => send(lastSent.current, { retry: true })}><RefreshCw size={16} aria-hidden="true" /> Try again</button></div>}
          </div>
        )}
        <div ref={endRef} />
      </div>
      {slash.length > 0 && (
        <ul className="ac-menu" role="listbox" aria-label="Skills">
          {slash.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === pick}>
              <button type="button" className={i === pick ? 'is-sel' : ''} onMouseEnter={() => setPick(i)} onClick={() => send(`/${s.name}`)}><b>/{s.name}</b><small>{s.description}</small></button>
            </li>
          ))}
        </ul>
      )}
      <form className="ac-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="ac-field">
          <textarea ref={areaRef} rows={1} aria-label="Message" maxLength={12000} value={text} disabled={!writable}
            placeholder={!writable ? 'Viewers cannot use the assistant' : busy ? 'You can type your next message while I work' : skill ? 'Click an option, or type your own answer' : 'Ask, or tell me what to do. Type / for skills'}
            onChange={(e) => { setText(e.target.value); grow(e); }} onKeyDown={onKey} />
          {busy
            ? <button type="button" className="ac-stop" onClick={stopGenerating}><Square size={14} aria-hidden="true" /> Stop</button>
            : <button type="submit" className="ac-send" aria-label="Send" disabled={!writable || !text.trim()}><Send size={18} aria-hidden="true" /></button>}
        </div>
        <div className="ac-hint">{slash.length ? 'Up and Down to choose · Enter to run · Tab to add details · Esc to close' : busy ? 'Stopping keeps what is already written' : 'Enter to send · Shift+Enter for a new line'}</div>
      </form>
    </div>
  );
}
