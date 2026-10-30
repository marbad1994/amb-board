import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Send, Sparkles, X } from 'lucide-react';
import { api } from '../api/client.js';
import AiSummaryCard from '../components/AiSummaryCard.jsx';
import { useAuth, canWrite } from '../context/AuthContext.jsx';

const SUGGESTIONS = [
  'What should I focus on today?', 'Summarize my active projects.', 'Which projects are behind schedule?',
  'What appointments do I have next week?', 'Summarize my finances this month.',
];

function Proposal({ p, onDecide, disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (fn) => {
    setBusy(true); setError('');
    try { onDecide(await fn(p.id)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className={`proposal proposal--${p.status}`}>
      <div className="proposal__body">
        <span className="proposal__label">Suggested change</span>
        <p>{p.description}</p>
        {p.status !== 'pending' && <p className="hint">{{ approved: 'Applied.', rejected: 'Rejected, nothing changed.', failed: `Not applied: ${p.result?.error || 'it no longer matches your data'}`, expired: 'Expired, nothing changed.' }[p.status]}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      {p.status === 'pending' && (
        <div className="proposal__actions">
          <button type="button" className="btn btn-primary" disabled={busy || disabled} onClick={() => decide(api.approveProposal)}><Check size={14} aria-hidden="true" /> Approve</button>
          <button type="button" className="btn" disabled={busy || disabled} onClick={() => decide(api.rejectProposal)}><X size={14} aria-hidden="true" /> Reject</button>
        </div>
      )}
    </div>
  );
}

export default function AssistantPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [conversations, setConversations] = useState([]);
  const [convId, setConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);
  const [tab, setTab] = useState('chat');
  const endRef = useRef(null);

  const refreshList = useCallback(() => api.listConversations().then(setConversations).catch(() => {}), []);
  useEffect(() => { refreshList(); api.aiStatus().then(setStatus).catch(() => {}); }, [refreshList]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [messages, busy]);

  const open = async (id) => {
    setError('');
    if (!id) { setConvId(null); setMessages([]); return; }
    try { const c = await api.getConversation(id); setConvId(c.id); setMessages(c.messages); } catch (err) { setError(err.message); }
  };

  const send = async (e, preset) => {
    e?.preventDefault();
    const message = (preset ?? text).trim();
    if (!message || busy) return;
    setBusy(true); setError(''); setText('');
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: message, proposals: [], tool_trace: [] }]);
    try {
      const res = await api.chat(message, convId);
      setConvId(res.conversationId);
      setMessages((m) => [...m, { ...res.message, dropped: res.dropped?.length || 0 }]);
      refreshList();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const updateProposal = (updated) => setMessages((ms) => ms.map((m) => ({ ...m, proposals: m.proposals.map((p) => (p.id === updated.id ? updated : p)) })));

  return (
    <div className="page page--wide assistant">
      <div className="page-header">
        <div>
          <div className="eyebrow">INTELLIGENCE</div>
          <h1>AI Assistant</h1>
          <p className="page-sub">Ask about your projects, tasks, calendar and finances. It reads your workspace data and can suggest changes, but nothing changes until you approve it.</p>
        </div>
        <div className="inline-form">
          <select aria-label="Conversation" value={convId || ''} onChange={(e) => open(e.target.value)}>
            <option value="">New conversation</option>
            {conversations.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </div>
      </div>

      {status && !status.available && <p className="notice">AI is not configured on this server.</p>}
      {!writable && <p className="notice">Viewers cannot use the assistant. Ask an owner or admin for member access.</p>}

      <div className="seg seg--tabs" role="group" aria-label="Assistant sections">
        <button type="button" aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" aria-pressed={tab === 'weekly'} onClick={() => setTab('weekly')}>Weekly review</button>
        <button type="button" aria-pressed={tab === 'monthly'} onClick={() => setTab('monthly')}>Monthly review</button>
      </div>
      {tab !== 'chat' && <AiSummaryCard key={tab} kind={tab} writable={writable} title={tab === 'weekly' ? 'Weekly review' : 'Monthly review'} />}

      {tab === 'chat' && <section className="panel chat" aria-label="Conversation">
        {messages.length === 0 && (
          <div className="chat__empty">
            <Sparkles size={28} aria-hidden="true" />
            <p>Try one of these:</p>
            <div className="chat__suggestions">
              {SUGGESTIONS.map((s) => <button key={s} type="button" className="btn" disabled={!writable || busy} onClick={() => send(null, s)}>{s}</button>)}
            </div>
          </div>
        )}
        <ul className="chat__list" aria-live="polite">
          {messages.map((m) => (
            <li key={m.id} className={`bubble bubble--${m.role}`}>
              <span className="sr-only">{m.role === 'user' ? 'You' : 'Assistant'}:</span>
              <p>{m.content}</p>
              {m.role === 'assistant' && m.tool_trace?.length > 0 && (
                <small className="hint">Looked at: {[...new Set(m.tool_trace.map((t) => t.tool.replace(/_/g, ' ')))].join(', ')}</small>
              )}
              {m.proposals?.map((p) => <Proposal key={p.id} p={p} onDecide={updateProposal} disabled={!writable} />)}
              {m.dropped > 0 && <small className="hint">{m.dropped} suggested change{m.dropped > 1 ? 's were' : ' was'} not allowed or did not match your data and {m.dropped > 1 ? 'were' : 'was'} discarded.</small>}
              {m.role === 'assistant' && <small className="hint">AI-generated. It can be wrong; check figures in the app.</small>}
            </li>
          ))}
          {busy && <li className="bubble bubble--assistant"><Loader2 size={16} className="spin" aria-label="Thinking" /></li>}
        </ul>
        <div ref={endRef} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <form className="chat__form" onSubmit={send}>
          <input type="text" aria-label="Message" placeholder="Ask about your projects, tasks, calendar or finances" maxLength={2000}
            value={text} onChange={(e) => setText(e.target.value)} disabled={!writable || busy} />
          <button type="submit" className="btn btn-primary" disabled={!writable || busy || !text.trim()}><Send size={16} aria-hidden="true" /> Send</button>
        </form>
      </section>}
    </div>
  );
}
