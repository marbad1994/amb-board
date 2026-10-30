import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2, Plus } from 'lucide-react';
import { api } from '../api/client.js';
import CopyToWorkspace from '../components/CopyToWorkspace.jsx';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import { formatDate } from '../lib/labels.js';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

function GoalCard({ g, projects, writable, reload, onError }) {
  const [ms, setMs] = useState({ title: '', due: '' });
  const [local, setLocal] = useState({}); // optimistic checkbox state until the server answers
  const act = async (fn) => { try { await fn(); await reload(); } catch (err) { onError(err.message); } finally { setLocal({}); } };
  const unlinked = projects.filter((p) => !g.projects.some((x) => x.id === p.id));
  return (
    <article className="panel goal">
      <div className="panel__title"><h2>{g.title}</h2><span className={`role-tag`}>{g.status}</span></div>
      <div className="progress" role="progressbar" aria-valuenow={g.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${g.title} progress`}><div style={{ width: `${g.progress}%` }} /></div>
      <p className="hint">{g.progress}% {g.progress_source === 'milestones' ? 'from milestones' : g.progress_source === 'projects' ? 'from linked projects' : '(add milestones or link a project to track progress)'}{g.target_date ? ` · target ${formatDate(g.target_date)}` : ''}</p>
      {g.description && <p className="muted">{g.description}</p>}
      <ul className="subtasks">
        {g.milestones.map((m) => (
          <li key={m.id}>
            <label className="check"><input type="checkbox" checked={local[m.id] ?? m.done} disabled={!writable} onChange={(e) => { const done = e.target.checked; setLocal({ ...local, [m.id]: done }); act(() => api.updateMilestone(g.id, m.id, { done })); }} />
              <span className={m.done ? 'is-done' : ''}>{m.title}{m.due_date ? ` (${formatDate(m.due_date)})` : ''}</span></label>
            {writable && <button type="button" className="btn btn-icon btn-ghost" aria-label={`Delete milestone ${m.title}`} onClick={() => act(() => api.deleteMilestone(g.id, m.id))}><Trash2 size={14} /></button>}
          </li>
        ))}
      </ul>
      {writable && (
        <form className="inline-form ms-form" onSubmit={(e) => { e.preventDefault(); act(async () => { await api.addMilestone(g.id, ms.title, ms.due); setMs({ title: '', due: '' }); }); }}>
          <input type="text" aria-label={`New milestone for ${g.title}`} placeholder="Add milestone" maxLength={200} value={ms.title} onChange={(e) => setMs({ ...ms, title: e.target.value })} />
          <input type="date" aria-label="Milestone due date" value={ms.due} onChange={(e) => setMs({ ...ms, due: e.target.value })} />
          <button type="submit" className="btn btn-icon" aria-label="Add milestone" disabled={!ms.title.trim()}><Plus size={16} /></button>
        </form>
      )}
      <div className="chips-row">
        {g.projects.map((p) => <span key={p.id} className="chip-link"><Link to={`/projects/${p.id}`}>{p.name} ({p.progress}%)</Link>{writable && <button type="button" aria-label={`Unlink ${p.name}`} onClick={() => act(() => api.unlinkGoalProject(g.id, p.id))}>×</button>}</span>)}
        {writable && unlinked.length > 0 && (
          <select aria-label={`Link a project to ${g.title}`} value="" onChange={(e) => e.target.value && act(() => api.linkGoalProject(g.id, e.target.value))}>
            <option value="">Link a project…</option>{unlinked.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
      {writable && (
        <div className="inline-form">
          {g.status === 'active' && <button type="button" className="btn" onClick={() => act(() => api.updateGoal(g.id, { status: 'achieved' }))}>Mark achieved</button>}
          <CopyToWorkspace entity="goal" id={g.id} label={g.title} />
          {g.status !== 'active' && <button type="button" className="btn" onClick={() => act(() => api.updateGoal(g.id, { status: 'active' }))}>Reopen</button>}
          <button type="button" className="btn" onClick={() => act(() => api.updateGoal(g.id, { status: 'archived' }))}>Archive</button>
        </div>
      )}
    </article>
  );
}

export default function GoalsPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [tab, setTab] = useState('goals');
  const [goals, setGoals] = useState(null);
  const [habits, setHabits] = useState(null);
  const [challenges, setChallenges] = useState([]);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState('');
  const [habitLocal, setHabitLocal] = useState({});
  const [gForm, setGForm] = useState({ title: '', target_date: '' });
  const [hForm, setHForm] = useState({ title: '', frequency: 'daily', target_per_week: 3, goalId: '' });
  const [cForm, setCForm] = useState({ title: '', habitId: '', start_date: today(), end_date: addDays(today(), 29) });

  const load = useCallback(async () => {
    try {
      const [g, h, c, p] = await Promise.all([api.listGoals(), api.listHabits(), api.listChallenges(), api.listProjects()]);
      setGoals(g); setHabits(h); setChallenges(c); setProjects(p);
    } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn) => { setError(''); try { await fn(); await load(); } catch (err) { setError(err.message); } finally { setHabitLocal({}); } };
  const days = Array.from({ length: 14 }, (_, i) => addDays(today(), i - 13));

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">LONG-TERM OUTCOMES</div>
          <h1>Goals &amp; Habits</h1>
          <p className="page-sub">Goals are shared with your workspace. Habits and challenges are private to you.</p>
        </div>
      </div>
      <div className="seg seg--tabs" role="group" aria-label="Section">
        {[['goals', 'Goals'], ['habits', 'Habits'], ['challenges', 'Challenges']].map(([v, l]) => <button key={v} type="button" aria-pressed={tab === v} onClick={() => setTab(v)}>{l}</button>)}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      {tab === 'goals' && (
        <>
          {writable && (
            <form className="inline-form inline-form--wide" onSubmit={(e) => { e.preventDefault(); act(async () => { await api.createGoal({ title: gForm.title, target_date: gForm.target_date || null }); setGForm({ title: '', target_date: '' }); }); }}>
              <input type="text" aria-label="New goal" placeholder="New goal, e.g. Run a marathon" maxLength={200} value={gForm.title} onChange={(e) => setGForm({ ...gForm, title: e.target.value })} />
              <input type="date" aria-label="Goal target date" value={gForm.target_date} onChange={(e) => setGForm({ ...gForm, target_date: e.target.value })} />
              <button type="submit" className="btn btn-primary" disabled={!gForm.title.trim()}>Add goal</button>
            </form>
          )}
          {goals && goals.length === 0 && <div className="empty-state">No goals yet.</div>}
          <div className="area-grid">{goals?.map((g) => <GoalCard key={g.id} g={g} projects={projects} writable={writable} reload={load} onError={setError} />)}</div>
        </>
      )}

      {tab === 'habits' && (
        <>
          {writable && (
            <form className="inline-form inline-form--wide" onSubmit={(e) => { e.preventDefault(); act(async () => { await api.createHabit({ title: hForm.title, frequency: hForm.frequency, target_per_week: Number(hForm.target_per_week), goalId: hForm.goalId || null }); setHForm({ ...hForm, title: '' }); }); }}>
              <input type="text" aria-label="New habit" placeholder="New habit, e.g. Meditate" maxLength={120} value={hForm.title} onChange={(e) => setHForm({ ...hForm, title: e.target.value })} />
              <select aria-label="Frequency" value={hForm.frequency} onChange={(e) => setHForm({ ...hForm, frequency: e.target.value })}><option value="daily">Every day</option><option value="weekly">Times per week</option></select>
              {hForm.frequency === 'weekly' && <input type="number" aria-label="Times per week" min={1} max={7} style={{ maxWidth: 90 }} value={hForm.target_per_week} onChange={(e) => setHForm({ ...hForm, target_per_week: e.target.value })} />}
              <select aria-label="Linked goal" value={hForm.goalId} onChange={(e) => setHForm({ ...hForm, goalId: e.target.value })}><option value="">No goal</option>{goals?.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select>
              <button type="submit" className="btn btn-primary" disabled={!hForm.title.trim()}>Add habit</button>
            </form>
          )}
          {habits && habits.length === 0 && <div className="empty-state">No habits yet.</div>}
          <section className="panel">
            <ul className="task-list">
              {habits?.map((h) => (
                <li key={h.id}>
                  <label className="hit"><input type="checkbox" aria-label={`${h.title}, done today`} checked={habitLocal[h.id] ?? h.done_today} disabled={!writable} onChange={() => { const next = !(habitLocal[h.id] ?? h.done_today); setHabitLocal({ ...habitLocal, [h.id]: next }); act(() => api.checkHabit(h.id, today(), next)); }} /></label>
                  <div className="task-list__main">
                    <span>{h.title}</span>
                    <small>{h.frequency === 'weekly' ? `${h.done_this_week}/${h.target_per_week} this week · ` : ''}Streak {h.streak.current} {h.frequency === 'weekly' ? 'weeks' : 'days'} · best {h.streak.longest}</small>
                    <span className="dots" aria-label="Last 14 days">{days.map((d) => <i key={d} className={h.recent.includes(d) ? 'on' : ''} title={d} />)}</span>
                  </div>
                  {writable && <button type="button" className="btn btn-ghost" onClick={() => act(() => api.updateHabit(h.id, { archived: true }))}>Archive</button>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {tab === 'challenges' && (
        <>
          {writable && (
            <form className="inline-form inline-form--wide" onSubmit={(e) => { e.preventDefault(); act(async () => { await api.createChallenge({ ...cForm }); setCForm({ ...cForm, title: '' }); }); }}>
              <input type="text" aria-label="Challenge name" placeholder="e.g. 30 days of reading" maxLength={120} value={cForm.title} onChange={(e) => setCForm({ ...cForm, title: e.target.value })} />
              <select aria-label="Habit for challenge" value={cForm.habitId} onChange={(e) => setCForm({ ...cForm, habitId: e.target.value })}><option value="">Choose a habit</option>{habits?.map((h) => <option key={h.id} value={h.id}>{h.title}</option>)}</select>
              <input type="date" aria-label="Challenge start" value={cForm.start_date} onChange={(e) => setCForm({ ...cForm, start_date: e.target.value })} />
              <input type="date" aria-label="Challenge end" value={cForm.end_date} onChange={(e) => setCForm({ ...cForm, end_date: e.target.value })} />
              <button type="submit" className="btn btn-primary" disabled={!cForm.title.trim() || !cForm.habitId}>Start challenge</button>
            </form>
          )}
          {challenges.length === 0 && <div className="empty-state">No challenges yet. A challenge tracks one of your habits over a date range.</div>}
          <div className="area-grid">
            {challenges.map((c) => (
              <article key={c.id} className="panel">
                <div className="panel__title"><h2>{c.title}</h2><span className="role-tag">{c.state}</span></div>
                <div className="progress" role="progressbar" aria-valuenow={c.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${c.title} progress`}><div style={{ width: `${c.progress}%` }} /></div>
                <p className="hint">{c.completed_days} of {c.total_days} days · {formatDate(c.start_date)} to {formatDate(c.end_date)}</p>
                {writable && <button type="button" className="btn btn-ghost" onClick={() => act(() => api.deleteChallenge(c.id))}>Delete</button>}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
