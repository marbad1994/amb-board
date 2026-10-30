import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { fmt, toMinor, lastCurrency, rememberCurrency } from '../lib/money.js';
import { canManage } from '../context/AuthContext.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const STATUS = { ok: 'On track', warning: 'Near limit', over: 'Over budget' };

function useLoader(fn) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => fn().then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)), [fn]);
  useEffect(() => { load(); }, [load]);
  return { data, error, setError, load };
}

export function BudgetTab({ role, writable }) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const fetcher = useCallback(() => api.monthBudget(month), [month]);
  const { data, error, setError, load } = useLoader(fetcher);
  const [cats, setCats] = useState([]);
  const [f, setF] = useState({ categoryId: '', amount: '', currency: lastCurrency() });
  const manage = canManage(role);
  useEffect(() => { api.listCategories().then(setCats).catch(() => {}); }, []);

  const save = async (e) => {
    e.preventDefault();
    const minor = toMinor(f.amount);
    if (minor === null) return setError('Enter an amount such as 400 or 400.50');
    try { rememberCurrency(f.currency); await api.setMonthBudget({ month, categoryId: f.categoryId, currency: f.currency, amount_minor: minor }); setF({ ...f, amount: '' }); await load(); } catch (err) { setError(err.message); }
  };

  return (
    <>
      <div className="filter-row"><label>Month <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {manage ? (
        <form className="panel inline-form inline-form--wide" style={{ marginBottom: 16 }} onSubmit={save} aria-label="Set category budget">
          <select aria-label="Budget category" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} required><option value="">Category</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input type="text" inputMode="decimal" aria-label="Budget amount" placeholder="Monthly limit" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <input type="text" aria-label="Budget currency" maxLength={3} style={{ maxWidth: 80 }} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
          <button type="submit" className="btn btn-primary" disabled={!f.categoryId || !f.amount}>Set budget</button>
        </form>
      ) : <p className="hint">Only owners and admins can set category budgets.</p>}
      {data && data.rows.length === 0 && <div className="empty-state">No category budgets for {month}.</div>}
      {data && data.rows.length > 0 && (
        <section className="panel" aria-label="Budget versus actual">
          <ul className="task-list">
            {data.rows.map((r) => (
              <li key={`${r.category_id}-${r.currency}`}>
                <div className="task-list__main">
                  <span>{r.category} ({r.currency})</span>
                  <div className="progress" role="progressbar" aria-valuenow={Math.min(100, r.used_pct ?? 0)} aria-valuemin={0} aria-valuemax={100} aria-label={`${r.category} spent`}><div style={{ width: `${Math.min(100, r.used_pct ?? 0)}%`, background: r.status === 'over' ? '#d92d20' : r.status === 'warning' ? '#e0a526' : undefined }} /></div>
                  <small>{fmt(r.actual_minor, r.currency)} of {fmt(r.budget_minor, r.currency)} · {fmt(r.remaining_minor, r.currency)} left</small>
                </div>
                <span className={`budget-status budget-status--${r.status === 'over' ? 'over' : r.status}`}>{STATUS[r.status]} ({r.used_pct}%)</span>
                {manage && <button type="button" className="btn btn-ghost" onClick={() => api.removeMonthBudget(month, r.category_id, r.currency).then(load).catch((e) => setError(e.message))}>Remove</button>}
              </li>
            ))}
          </ul>
          {data.unbudgeted.map((u) => (
            <p key={u.currency} className="hint">Spent without a budget ({u.currency}): {fmt(u.total_minor, u.currency)} ({u.categories.map((c) => `${c.name} ${fmt(c.total_minor, u.currency)}`).join(', ')}).</p>
          ))}
        </section>
      )}
      {!writable && <p className="hint">Read only.</p>}
    </>
  );
}

export function SavingsTab({ writable }) {
  const { data, error, setError, load } = useLoader(api.listSavings);
  const [f, setF] = useState({ name: '', target: '', currency: lastCurrency(), emergency: false });
  const [entry, setEntry] = useState({});
  const act = async (fn) => { try { await fn(); await load(); } catch (e) { setError(e.message); } };

  return (
    <>
      {error && <p className="form-error" role="alert">{error}</p>}
      {writable && (
        <form className="panel inline-form inline-form--wide" style={{ marginBottom: 16 }} aria-label="New savings goal"
          onSubmit={(e) => { e.preventDefault(); const t = toMinor(f.target); if (t === null) return setError('Enter a target such as 5000'); act(async () => { await api.createSavings({ name: f.name, target_minor: t, currency: f.currency, is_emergency_fund: f.emergency }); setF({ ...f, name: '', target: '' }); }); }}>
          <input type="text" aria-label="Savings goal name" placeholder="e.g. Holiday or Emergency fund" maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input type="text" inputMode="decimal" aria-label="Savings target" placeholder="Target" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
          <input type="text" aria-label="Savings currency" maxLength={3} style={{ maxWidth: 80 }} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
          <label className="check"><input type="checkbox" checked={f.emergency} onChange={(e) => setF({ ...f, emergency: e.target.checked })} /> Emergency fund</label>
          <button type="submit" className="btn btn-primary" disabled={!f.name.trim() || !f.target}>Add goal</button>
        </form>
      )}
      {data && data.length === 0 && <div className="empty-state">No savings goals yet.</div>}
      <div className="area-grid">
        {data?.map((g) => (
          <article key={g.id} className="panel">
            <div className="panel__title"><h2>{g.name}</h2>{g.is_emergency_fund && <span className="role-tag">Emergency fund</span>}</div>
            <div className="progress" role="progressbar" aria-valuenow={g.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${g.name} progress`}><div style={{ width: `${g.progress}%` }} /></div>
            <p><b>{fmt(g.balance_minor, g.currency)}</b> of {fmt(g.target_minor, g.currency)} ({g.progress}%){g.target_date ? ` · by ${g.target_date}` : ''}</p>
            {g.is_emergency_fund && <p className="hint">{g.months_covered === null ? 'Not enough spending history to estimate months covered.' : `Covers about ${g.months_covered} months of spending (average of the last 3 full months: ${fmt(g.avg_monthly_expenses_minor, g.currency)}).`}</p>}
            {writable && (
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); const kind = e.nativeEvent.submitter?.value || 'deposit'; const m = toMinor(entry[g.id] || ''); if (m === null) return setError('Enter an amount such as 100'); act(async () => { await api.addSavingsEntry(g.id, { kind, amount_minor: m }); setEntry({ ...entry, [g.id]: '' }); }); }}>
                <input type="text" inputMode="decimal" aria-label={`Amount for ${g.name}`} placeholder="Amount" value={entry[g.id] || ''} onChange={(e) => setEntry({ ...entry, [g.id]: e.target.value })} />
                <button type="submit" value="deposit" className="btn btn-primary">Deposit</button>
                <button type="submit" value="withdrawal" className="btn">Withdraw</button>
              </form>
            )}
            {g.entries.length > 0 && <ul className="plain-list">{g.entries.slice(0, 4).map((e) => <li key={e.id}><span>{e.date} · {e.kind}</span><b>{e.kind === 'deposit' ? '+' : '-'}{fmt(e.amount_minor, g.currency)}</b></li>)}</ul>}
            {writable && <button type="button" className="btn btn-ghost" onClick={() => act(() => api.archiveSavings(g.id))}>Archive</button>}
          </article>
        ))}
      </div>
    </>
  );
}

export function DebtsTab({ writable }) {
  const { data, error, setError, load } = useLoader(api.listDebts);
  const [f, setF] = useState({ name: '', amount: '', currency: lastCurrency(), rate: '' });
  const [pay, setPay] = useState({});
  const act = async (fn) => { try { await fn(); await load(); } catch (e) { setError(e.message); } };
  return (
    <>
      <p className="hint">Debts are tracked, not calculated: no interest is added to the balance.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {writable && (
        <form className="panel inline-form inline-form--wide" style={{ marginBottom: 16 }} aria-label="New debt"
          onSubmit={(e) => { e.preventDefault(); const a = toMinor(f.amount); if (a === null) return setError('Enter the original amount such as 10000'); act(async () => { await api.createDebt({ name: f.name, original_minor: a, currency: f.currency, interest_rate_pct: f.rate === '' ? null : Number(f.rate) }); setF({ ...f, name: '', amount: '', rate: '' }); }); }}>
          <input type="text" aria-label="Debt name" placeholder="e.g. Car loan" maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input type="text" inputMode="decimal" aria-label="Original amount" placeholder="Original amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <input type="text" aria-label="Debt currency" maxLength={3} style={{ maxWidth: 80 }} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
          <input type="number" aria-label="Interest rate percent" placeholder="Rate %" step="0.01" min={0} style={{ maxWidth: 110 }} value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          <button type="submit" className="btn btn-primary" disabled={!f.name.trim() || !f.amount}>Add debt</button>
        </form>
      )}
      {data && data.length === 0 && <div className="empty-state">No debts tracked.</div>}
      <div className="area-grid">
        {data?.map((d) => (
          <article key={d.id} className="panel">
            <div className="panel__title"><h2>{d.name}</h2>{d.interest_rate_pct !== null && <span className="role-tag">{d.interest_rate_pct}%</span>}</div>
            <div className="progress" role="progressbar" aria-valuenow={d.paid_pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${d.name} paid`}><div style={{ width: `${d.paid_pct}%` }} /></div>
            <p><b>{fmt(d.remaining_minor, d.currency)}</b> remaining of {fmt(d.original_minor, d.currency)} ({d.paid_pct}% paid)</p>
            {writable && d.remaining_minor > 0 && (
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); const m = toMinor(pay[d.id] || ''); if (m === null) return setError('Enter a payment such as 250'); act(async () => { await api.addDebtPayment(d.id, { amount_minor: m, date: today() }); setPay({ ...pay, [d.id]: '' }); }); }}>
                <input type="text" inputMode="decimal" aria-label={`Payment for ${d.name}`} placeholder="Payment" value={pay[d.id] || ''} onChange={(e) => setPay({ ...pay, [d.id]: e.target.value })} />
                <button type="submit" className="btn btn-primary">Record payment</button>
              </form>
            )}
            {d.payments.length > 0 && <ul className="plain-list">{d.payments.slice(0, 4).map((p) => <li key={p.id}><span>{p.date}</span><b>{fmt(p.amount_minor, d.currency)}</b></li>)}</ul>}
            {writable && <button type="button" className="btn btn-ghost" onClick={() => act(() => api.archiveDebt(d.id))}>Archive</button>}
          </article>
        ))}
      </div>
    </>
  );
}
