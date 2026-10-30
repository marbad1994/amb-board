import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightbulb, Plus, Sparkles, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import { useAssistantContext } from '../lib/assistantContext.js';
import AssistantChat from './AssistantChat.jsx';

const key = (wsId) => `amb-board.dock-conv.${wsId}`;
const readConv = (wsId) => { try { return localStorage.getItem(key(wsId)) || null; } catch { return null; } };
const saveConv = (wsId, id) => { try { id ? localStorage.setItem(key(wsId), id) : localStorage.removeItem(key(wsId)); } catch { /* storage unavailable */ } };

// Always-available assistant: a button on every page opens a panel that knows what you are looking at,
// shows proactive next steps, and chats. Changes still need your approval.
export default function AssistantDock() {
  const { active } = useAuth();
  const nav = useNavigate();
  const ctx = useAssistantContext();
  const writable = canWrite(active?.role);
  const [open, setOpen] = useState(false);
  const [convId, setConvId] = useState(() => readConv(active?.id));
  const [suggestions, setSuggestions] = useState([]);
  const [auto, setAuto] = useState(null);

  const loadSuggestions = useCallback(() => {
    api.suggestions(ctx.suggestionKey).then((r) => setSuggestions(r.suggestions)).catch(() => {});
  }, [ctx.suggestionKey]);
  useEffect(() => { loadSuggestions(); }, [loadSuggestions]);
  useEffect(() => { if (open) loadSuggestions(); }, [open, loadSuggestions]);
  useEffect(() => {
    const t = setInterval(loadSuggestions, 120_000);
    const h = () => { setOpen(true); };
    window.addEventListener('amb:open-assistant', h);
    return () => { clearInterval(t); window.removeEventListener('amb:open-assistant', h); };
  }, [loadSuggestions]);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);

  const setConversation = useCallback((id) => { setConvId(id); saveConv(active?.id, id); }, [active?.id]);

  const act = (s) => {
    if (s.action.type === 'link') { nav(s.action.to); setOpen(false); return; }
    setOpen(true);
    setAuto(s.action.prompt);
  };
  const dismiss = (s) => { setSuggestions((x) => x.filter((y) => y.key !== s.key)); api.dismissSuggestion(s.key, 1).catch(() => {}); };

  const top = suggestions.slice(0, 3);
  return (
    <>
      <button type="button" className={`dock-fab ${suggestions.length ? 'has-news' : ''}`} onClick={() => setOpen((v) => !v)} aria-label={open ? 'Close assistant' : `Open assistant${suggestions.length ? `, ${suggestions.length} suggestions` : ''}`} aria-expanded={open}>
        {open ? <X size={22} aria-hidden="true" /> : <Sparkles size={22} aria-hidden="true" />}
        {!open && suggestions.length > 0 && <span className="dock-fab__badge" aria-hidden="true">{suggestions.length}</span>}
      </button>
      {open && (
        <aside className="dock" role="complementary" aria-label="AI assistant">
          <header className="dock__head">
            <div><strong><Sparkles size={14} aria-hidden="true" /> Assistant</strong><small>Looking at: {ctx.label}</small></div>
            <button type="button" className="btn btn-ghost" onClick={() => { setConversation(null); setAuto(null); }}><Plus size={14} aria-hidden="true" /> New chat</button>
          </header>
          {top.length > 0 && (
            <section className="dock__suggest" aria-label="Suggested next steps">
              <h3><Lightbulb size={14} aria-hidden="true" /> Suggested next steps</h3>
              <ul>
                {top.map((s) => (
                  <li key={s.key}>
                    <div><b>{s.title}</b><small>{s.why}</small></div>
                    <div className="dock__suggest-actions">
                      <button type="button" className="btn btn-primary" disabled={s.action.type === 'ask' && !writable} onClick={() => act(s)}>{s.action.type === 'ask' ? 'Ask AI' : 'Open'}</button>
                      <button type="button" className="btn btn-ghost" onClick={() => dismiss(s)} aria-label={`Hide suggestion: ${s.title}`}>Not now</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="dock__chat">
            <AssistantChat compact conversationId={convId} onConversation={setConversation} context={ctx.context} writable={writable}
              autoSend={auto} onAutoSent={() => setAuto(null)} onNavigate={() => setOpen(false)}
              emptyHint={<p className="muted">Ask about this page, or tell me what to set up. I can read your data, analyse it, write reports and propose changes for you to approve.</p>} />
          </div>
        </aside>
      )}
    </>
  );
}
