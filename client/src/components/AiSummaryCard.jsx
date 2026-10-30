import { useEffect, useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { api } from '../api/client.js';

const SECTIONS = {
  project: [['completed', 'Completed'], ['remaining', 'Remaining'], ['risks', 'Risks'], ['suggestions', 'Suggestions (advice)']],
  daily: [['priorities', 'Priorities today'], ['upcoming', 'Next 7 days'], ['attention', 'Needs attention']],
  weekly: [['accomplishments', 'Accomplished'], ['incomplete', 'Incomplete'], ['project_progress', 'Project progress'], ['finances', 'Finances'], ['habits', 'Habits'], ['upcoming', 'Coming up'], ['suggestions', 'Suggestions (advice)']],
  monthly: [['completed', 'Completed'], ['goals', 'Goals'], ['budget', 'Budget'], ['spending', 'Spending'], ['savings_and_debts', 'Savings and debts'], ['pending_decisions', 'Pending decisions'], ['next_steps', 'Next steps (advice)']],
};

// kind: 'project' | 'daily'. Text is rendered as plain text only.
export default function AiSummaryCard({ kind, projectId, writable, title, brief = false }) {
  const [summary, setSummary] = useState(undefined); // undefined = loading, null = none yet
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isReview = kind === 'weekly' || kind === 'monthly';
  const fetchStored = kind === 'project' ? () => api.getProjectSummary(projectId) : isReview ? () => api.getReview(kind) : () => api.getBriefing();
  const generate = (refresh) => (kind === 'project' ? api.generateProjectSummary(projectId, refresh) : isReview ? api.generateReview(kind, refresh) : api.generateBriefing(refresh));

  useEffect(() => {
    let stale = false;
    api.aiStatus().then((s) => !stale && setAvailable(s.available)).catch(() => {});
    fetchStored().then((r) => !stale && setSummary(r.summary)).catch((err) => { if (!stale) { setSummary(null); setError(err.message); } });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, projectId]);

  const run = async (refresh) => {
    setBusy(true);
    setError('');
    try {
      setSummary((await generate(refresh)).summary);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const c = summary?.content;
  const facts = summary?.facts;

  // no AI key on this server: one quiet line instead of a large empty block
  if (!available && !summary) return <p className="ai-off" role="note"><Sparkles size={14} aria-hidden="true" /> {title} is off: no AI key is set on this server.</p>;

  return (
    <section className="ai-card" aria-label={title}>
      <div className="ai-card__head">
        <h3><Sparkles size={16} aria-hidden="true" /> {title}</h3>
        {writable && available && (
          <button type="button" className="btn" onClick={() => run(!!summary)} disabled={busy}>
            {busy && <Loader2 size={14} className="spin" aria-hidden="true" />}
            {summary ? 'Regenerate' : 'Generate'}
          </button>
        )}
      </div>

      {!available && <p className="muted">AI is not configured on this server.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {summary === undefined && <p className="muted">Loading…</p>}
      {summary === null && available && <p className="muted">{writable ? 'Nothing generated yet.' : 'No summary has been generated yet.'}</p>}

      {c && (
        <div className="ai-card__body">
          <p className="ai-card__lead">{kind === 'project' ? c.overview : c.headline}</p>
          {isReview && facts?.period && <p className="hint">Covers {facts.period.start} to {facts.period.end}{facts.period.in_progress ? ' (not over yet)' : ''}.</p>}
          {(() => { const sections = SECTIONS[kind].map(([key, label]) => c[key]?.length > 0 && (
            <div key={key}><h4>{label}</h4><ul>{c[key].map((t, i) => <li key={i}>{t}</li>)}</ul></div>
          )); return brief && sections.some(Boolean) ? <details className="ai-more"><summary>Show the full briefing</summary>{sections}</details> : sections; })()}
          {kind === 'daily' && c.suggested_focus && <div><h4>Suggested focus (advice)</h4><p>{c.suggested_focus}</p></div>}
          {summary.stale && <p className="notice">Your data changed since this was written. {writable ? 'Regenerate to update it.' : ''}</p>}
          <p className="hint">
            AI-generated on {new Date(summary.generated_at).toLocaleString()} ({summary.provider}). May contain mistakes; the figures below come from your records.
          </p>
          <details>
            <summary>Facts used</summary>
            {kind === 'project' ? (
              <ul className="facts">
                <li>{facts.progress.tasks_done} of {facts.progress.tasks_total} tasks done ({facts.progress.percent}%)</li>
                <li>{facts.progress.overdue} overdue, {facts.progress.blocked} blocked</li>
                <li>Schedule: {facts.schedule.assessment.replace('_', ' ')}{facts.schedule.days_to_target !== undefined ? `, ${facts.schedule.days_to_target} days to target` : ''}</li>
                <li>Not tracked yet: {facts.not_available.join('; ')}</li>
              </ul>
            ) : isReview ? (
              <ul className="facts">
                <li>{facts.completed_tasks.length} tasks completed, {facts.incomplete_tasks_due_in_period.length} due in the period and not done, {facts.overdue_now} overdue now</li>
                <li>{facts.finance_posted.map((f) => `${f.currency}: spent ${(f.expenses_minor / 100).toFixed(2)}, income ${(f.income_minor / 100).toFixed(2)}`).join(' | ') || 'No posted transactions'}</li>
                <li>{facts.appointments_in_period} appointments</li>
                <li>Not included: {facts.not_available.join('; ')}</li>
              </ul>
            ) : (
              <ul className="facts">
                <li>{facts.due_today.length} due today, {facts.overdue.length} overdue, {facts.due_next_7_days.length} due in 7 days, {facts.blocked.length} blocked</li>
                <li>{facts.completed_last_7_days.length} completed in the last 7 days</li>
                <li>Not tracked yet: {facts.not_available.join('; ')}</li>
              </ul>
            )}
          </details>
        </div>
      )}
    </section>
  );
}
