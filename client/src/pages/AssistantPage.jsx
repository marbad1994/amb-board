import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import AiSummaryCard from '../components/AiSummaryCard.jsx';
import AssistantChat from '../components/AssistantChat.jsx';
import { useAssistantContext } from '../lib/assistantContext.js';

const SUGGESTIONS = [
  'What should I focus on today?', 'Which projects are at risk and why?', 'Analyse my spending this month.',
  'Find gaps in my data that I should fix.', 'Create an overview report.', 'What appointments do I have next week?',
];

export default function AssistantPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const ctx = useAssistantContext();
  const [params] = useSearchParams();
  const [conversations, setConversations] = useState([]);
  const [convId, setConvId] = useState(null);
  const [status, setStatus] = useState(null);
  const [tab, setTab] = useState(['weekly', 'monthly'].includes(params.get('tab')) ? params.get('tab') : 'chat');
  const [auto, setAuto] = useState(null);
  const [skills, setSkills] = useState(null);

  const refresh = useCallback(() => api.listConversations().then(setConversations).catch(() => {}), []);
  useEffect(() => { refresh(); api.aiStatus().then(setStatus).catch(() => {}); }, [refresh]);
  useEffect(() => { if (tab === 'skills' && !skills) fetch('/api/ai/assistant/skills', { headers: { 'x-workspace-id': active?.id } }).then((r) => r.json()).then(setSkills).catch(() => {}); }, [tab, skills, active?.id]);

  return (
    <div className="page page--wide assistant">
      <div className="page-header">
        <div>
          <div className="eyebrow">INTELLIGENCE</div>
          <h1>AI Assistant</h1>
          <p className="page-sub">It reads your workspace, analyses it, writes reports and fills in forms for you. Anything that changes data is a suggestion you approve first. It is also available from the button in the corner of every page.</p>
        </div>
        {tab === 'chat' && (
          <select aria-label="Conversation" value={convId || ''} onChange={(e) => setConvId(e.target.value || null)}>
            <option value="">New conversation</option>{conversations.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        )}
      </div>
      {status && !status.available && <p className="notice">AI is not configured on this server.</p>}
      {!writable && <p className="notice">Viewers cannot use the assistant. Ask an owner or admin for member access.</p>}
      <div className="seg seg--tabs" role="group" aria-label="Assistant sections">
        {[['chat', 'Chat'], ['weekly', 'Weekly review'], ['monthly', 'Monthly review'], ['skills', 'What it can do']].map(([v, l]) => <button key={v} type="button" aria-pressed={tab === v} onClick={() => setTab(v)}>{l}</button>)}
      </div>
      {['weekly', 'monthly'].includes(tab) && <AiSummaryCard key={tab} kind={tab} writable={writable} title={tab === 'weekly' ? 'Weekly review' : 'Monthly review'} />}

      {tab === 'chat' && (
        <section className="panel chat" aria-label="Conversation">
          <AssistantChat conversationId={convId} onConversation={(id) => { setConvId(id); refresh(); }} context={ctx.context} writable={writable} autoSend={auto} onAutoSent={() => setAuto(null)}
            emptyHint={(
              <div className="chat__empty">
                <Sparkles size={28} aria-hidden="true" />
                <p>Try one of these:</p>
                <div className="chat__suggestions">{SUGGESTIONS.map((s) => <button key={s} type="button" className="btn" disabled={!writable} onClick={() => setAuto(s)}>{s}</button>)}</div>
              </div>
            )} />
        </section>
      )}

      {tab === 'skills' && (
        <section className="panel" aria-label="Skills">
          <p className="muted">Everything the assistant does is a named skill. It can also be used from other AI tools through the MCP connection in Settings.</p>
          {!skills ? <p>Loading…</p> : (
            <>
              <h3 className="sub-h">Reads, analyses and reports (run immediately)</h3>
              <ul className="skill-list">{skills.read.map((s) => <li key={s.name}><b>{s.name}</b> <span className="role-tag">{s.kind}</span><small>{s.description.replace(/^\S+ /, '')}</small></li>)}</ul>
              <h3 className="sub-h">Changes (always need your approval)</h3>
              <ul className="skill-list">{skills.write.map((s) => <li key={s.name}><b>{s.name}</b><small>{s.arguments}</small></li>)}</ul>
              <p className="hint">Not possible for the assistant: changing budgets, deleting anything, changing members or permissions, writing journal entries, sending messages.</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
