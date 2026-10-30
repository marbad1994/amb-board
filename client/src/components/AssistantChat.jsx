import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, FileBarChart, Loader2, Pencil, Send, X } from 'lucide-react';
import { api } from '../api/client.js';

// Proposals that can also be opened in the normal form to edit before saving.
const EDITABLE = new Set(['create_task', 'create_event', 'create_transaction']);

function Proposal({ p, onDecide, onEdit, disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const run = async (fn) => { setBusy(true); setError(''); try { onDecide(await fn(p.id)); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const edit = async () => {
    setBusy(true); setError('');
    try { onDecide(await api.rejectProposal(p.id)); onEdit(p); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <div className={`proposal proposal--${p.status}`}>
      <div className="proposal__body">
        <span className={`proposal__label ${/^DELETE/.test(p.description) ? 'proposal__label--danger' : ''}`}>{/^DELETE/.test(p.description) ? 'Destructive change: cannot be undone' : p.type === 'connect_mcp_server' ? 'Connect a tool' : p.type === 'setup_plan' ? `Setup plan: ${p.payload?.steps?.length || 0} steps, approved together` : p.type === 'create_automation' ? 'Suggested automation' : 'Suggested change'}</span>
        <p className="proposal__text">{p.description}</p>
        {p.status === 'pending' && p.type === 'connect_mcp_server' && (
          <label className="field"><span className="field__label">Access token for this server (optional, stored encrypted, never shown to the assistant)</span>
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
        )}
        {p.status !== 'pending' && <p className="hint">{{ approved: p.result?.auto ? 'Applied automatically (you allowed this type in Workspace & account).' : 'Applied.', rejected: 'Not applied.', failed: `Not applied: ${p.result?.error || 'it no longer matches your data'}`, expired: 'Expired, nothing changed.' }[p.status]}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      {p.status === 'pending' && (
        <div className="proposal__actions">
          <button type="button" className="btn btn-primary" disabled={busy || disabled} onClick={() => run((id) => api.approveProposal(id, p.type === 'connect_mcp_server' ? { token } : {}))}><Check size={14} aria-hidden="true" /> Approve</button>
          {EDITABLE.has(p.type) && <button type="button" className="btn" disabled={busy || disabled} onClick={edit}><Pencil size={14} aria-hidden="true" /> Edit first</button>}
          <button type="button" className="btn" disabled={busy || disabled} onClick={() => run(api.rejectProposal)}><X size={14} aria-hidden="true" /> Reject</button>
        </div>
      )}
    </div>
  );
}

// The conversation itself, used by the full Assistant page and by the always-available dock.
// `autoSend` is a prompt to send immediately (from a suggestion); `onAutoSent` clears it.
export default function AssistantChat({ conversationId, onConversation, context, writable, compact, autoSend, onAutoSent, onNavigate, emptyHint }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);
  const convRef = useRef(conversationId);

  useEffect(() => { convRef.current = conversationId; }, [conversationId]);
  useEffect(() => {
    let stale = false;
    if (!conversationId) { setMessages([]); return undefined; }
    if (messages.length && messages.some((m) => m.id?.startsWith?.('tmp-'))) return undefined;
    api.getConversation(conversationId).then((c) => { if (!stale) setMessages(c.messages); }).catch((err) => { if (!stale) { setError(err.message); onConversation?.(null); } });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [messages, busy]);

  const send = useCallback(async (preset) => {
    const message = (preset ?? text).trim();
    if (!message || busy) return;
    setBusy(true); setError(''); setText('');
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: message, proposals: [], tool_trace: [], artifacts: [] }]);
    try {
      const res = await api.chat(message, convRef.current, context);
      convRef.current = res.conversationId;
      onConversation?.(res.conversationId);
      setMessages((m) => [...m, { ...res.message, dropped: res.dropped?.length || 0 }]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }, [text, busy, context, onConversation]);

  useEffect(() => { if (autoSend && writable) { onAutoSent?.(); send(autoSend); } }, [autoSend]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (u) => setMessages((ms) => ms.map((m) => ({ ...m, proposals: (m.proposals || []).map((p) => (p.id === u.id ? { ...p, ...u } : p)) })));

  // "Edit first": open the real form with the proposed values filled in
  const edit = (p) => {
    onNavigate?.();
    const v = p.payload;
    if (p.type === 'create_task') window.dispatchEvent(new CustomEvent('amb:quick-add', { detail: { title: v.title, projectId: v.project_id, due_date: v.due_date || '', priority: v.priority } }));
    if (p.type === 'create_event') navigate('/calendar', { state: { prefillEvent: v } });
    if (p.type === 'create_transaction') navigate('/finance', { state: { prefillTx: v } });
  };

  return (
    <div className={`chat-wrap ${compact ? 'chat-wrap--compact' : ''}`}>
      {messages.length === 0 && !busy && emptyHint}
      <ul className="chat__list" aria-live="polite">
        {messages.map((m) => (
          <li key={m.id} className={`bubble bubble--${m.role}`}>
            <span className="sr-only">{m.role === 'user' ? 'You' : 'Assistant'}:</span>
            <p>{m.content}</p>
            {m.role === 'assistant' && m.tool_trace?.length > 0 && <small className="hint">Looked at: {[...new Set(m.tool_trace.map((t) => t.tool.replace(/_/g, ' ')))].join(', ')}</small>}
            {m.artifacts?.map((a) => (
              <Link key={a.id} to={`/reports/${a.id}`} className="artifact" onClick={() => onNavigate?.()}><FileBarChart size={16} aria-hidden="true" /> <span>Report ready: <b>{a.title}</b></span></Link>
            ))}
            {m.proposals?.map((p) => <Proposal key={p.id} p={p} onDecide={update} onEdit={edit} disabled={!writable} />)}
            {m.dropped > 0 && <small className="hint">{m.dropped} suggested change{m.dropped > 1 ? 's were' : ' was'} not allowed or did not match your data and {m.dropped > 1 ? 'were' : 'was'} discarded.</small>}
            {m.role === 'assistant' && <small className="hint">AI-generated. It can be wrong; check figures in the app.</small>}
          </li>
        ))}
        {busy && <li className="bubble bubble--assistant"><Loader2 size={16} className="spin" aria-label="Thinking" /></li>}
      </ul>
      <div ref={endRef} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <form className="chat__form" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input type="text" aria-label="Message" placeholder={writable ? 'Ask, or tell me what to do' : 'Viewers cannot use the assistant'} maxLength={2000}
          value={text} onChange={(e) => setText(e.target.value)} disabled={!writable || busy} />
        <button type="submit" className="btn btn-primary" disabled={!writable || busy || !text.trim()}><Send size={16} aria-hidden="true" /> Send</button>
      </form>
    </div>
  );
}
