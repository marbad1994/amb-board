import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { fmt, toMinor, lastCurrency, rememberCurrency } from '../lib/money.js';
import { canManage } from '../context/AuthContext.jsx';
import { Sparkles } from 'lucide-react';
import { BudgetBars } from './Charts.jsx';
import AiBudgetWizard from './AiBudgetWizard.jsx';

const today = () => new Date().toISOString().slice(0, 10);

function useLoader(fn) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => fn().then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)), [fn]);
  useEffect(() => { load(); }, [load]);
  return { data, error, setError, load };
}

export function BudgetTab({ role, writable }) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [currency, setCurrency] = useState(lastCurrency());
  const fetcher = useCallback(() => api.monthBudget(month), [month]);
  const { data, error, setError, load } = useLoader(fetcher);
  const [cats, setCats] = useState([]);
  const [vals, setVals] = useState({});
  const [saved, setSaved] = useState('');
  const [newCat, setNewCat] = useState({ name: '', parentId: '' });
  const [wizard, setWizard] = useState(false);
  const manage = canManage(role);

  const loadCats = useCallback(() => api.listCategories().then(setCats).catch(() => {}), []);
  useEffect(() => { loadCats(); }, [loadCats]);

  // fill the builder from the saved budget for this month and currency
  useEffect(() => {
    if (!data) return;
    const v = {};
    for (const r of data.rows) if (r.currency === currency) v[r.category_id] = (r.budget_minor / 100).toFixed(2);
    setVals(v);
  }, [data, currency]);

  const ordered = [...cats.filter((c) => !c.parent_id)].flatMap((p) => [p, ...cats.filter((c) => c.parent_id === p.id).map((c) => ({ ...c, child: true }))]);
  const lines = ordered.map((c) => ({ categoryId: c.id, amount_minor: vals[c.id] ? toMinor(vals[c.id]) || 0 : 0 }));
  const badInput = ordered.some((c) => vals[c.id] && toMinor(vals[c.id]) === null);
  const total = lines.reduce((a, l) => a + l.amount_minor, 0);

  const save = async () => {
    setError(''); setSaved('');
    try { rememberCurrency(currency); await api.bulkBudget({ month, currency, lines }); await load(); setSaved('Budget saved.'); } catch (err) { setError(err.message); }
  };

  const copyPrevious = async () => {
    const [y, m] = month.split('-').map(Number);
    const t = y * 12 + (m - 1) - 1;
    const prev = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
    try {
      const p = await api.monthBudget(prev);
      const v = {};
      for (const r of p.rows) if (r.currency === currency) v[r.category_id] = (r.budget_minor / 100).toFixed(2);
      if (Object.keys(v).length === 0) return setError(`No ${currency} budget found for ${prev}.`);
      setVals(v); setSaved(`Copied from ${prev}. Press Save budget to keep it.`); setError('');
    } catch (err) { setError(err.message); }
  };

  const addCategory = async (e) => {
    e.preventDefault();
    try { await api.createCategory(newCat.name.trim(), newCat.parentId); setNewCat({ name: '', parentId: '' }); await loadCats(); } catch (err) { setError(err.message); }
  };

  const rows = data?.rows.filter((r) => r.currency === currency) || [];

  return (
    <>
      <div className="filter-row">
        <label>Month <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        <label>Currency <input type="text" aria-label="Budget currency" maxLength={3} style={{ maxWidth: 80 }} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></label>
        {writable && <button type="button" className="btn btn-primary" onClick={() => setWizard(true)}><Sparkles size={16} aria-hidden="true" /> Create with AI</button>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {saved && <p className="form-ok" role="status">{saved}</p>}

      {rows.length > 0 && (
        <section className="panel" style={{ marginBottom: 16 }} aria-label="Budget versus actual">
          <div className="panel__title"><h2>Budget vs spent, {month}</h2></div>
          <BudgetBars rows={data.rows} currency={currency} />
          {data.unbudgeted.filter((u) => u.currency === currency).map((u) => (
            <p key={u.currency} className="hint">Spent without a budget: {fmt(u.total_minor, u.currency)} ({u.categories.map((c) => `${c.name} ${fmt(c.total_minor, u.currency)}`).join(', ')}).</p>
          ))}
          {data.unbudgeted.filter((u) => u.currency !== currency).length > 0 && <p className="hint">Spending in other currencies is not shown here and never converted.</p>}
        </section>
      )}

      <section className="panel" aria-label="Budget builder">
        <div className="panel__title"><h2>Budget builder</h2><span className="muted">Total {fmt(total, currency)}</span></div>
        {!manage && <p className="hint">Only owners and admins can change budgets.</p>}
        <div className="table-wrap">
          <table className="table" aria-label="Monthly limits by category">
            <thead><tr><th>Category</th><th>Monthly limit ({currency})</th><th>Spent</th></tr></thead>
            <tbody>
              {ordered.map((c) => {
                const r = rows.find((x) => x.category_id === c.id);
                return (
                  <tr key={c.id}>
                    <td style={{ paddingLeft: c.child ? 28 : 8 }}>{c.child ? '- ' : ''}{c.name}</td>
                    <td><input type="text" inputMode="decimal" aria-label={`Limit for ${c.name}`} placeholder="none" disabled={!manage} value={vals[c.id] ?? ''} onChange={(e) => { setVals({ ...vals, [c.id]: e.target.value }); setSaved(''); }} /></td>
                    <td>{r ? `${fmt(r.actual_minor, currency)} (${r.used_pct}%)` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {manage && (
          <div className="inline-form inline-form--wide" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" disabled={badInput} onClick={save}>Save budget</button>
            <button type="button" className="btn" onClick={copyPrevious}>Copy from previous month</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setVals({}); setSaved('Cleared. Press Save budget to keep it.'); }}>Clear all</button>
          </div>
        )}
        {manage && (
          <form className="inline-form inline-form--wide" style={{ marginTop: 16 }} onSubmit={addCategory} aria-label="Add category">
            <input type="text" aria-label="New category name" placeholder="New category" maxLength={60} value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} />
            <select aria-label="Parent category" value={newCat.parentId} onChange={(e) => setNewCat({ ...newCat, parentId: e.target.value })}>
              <option value="">Top level</option>{cats.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>Inside {c.name}</option>)}
            </select>
            <button type="submit" className="btn" disabled={!newCat.name.trim()}>Add category</button>
          </form>
        )}
      </section>
      {!writable && <p className="hint">Read only.</p>}
      {wizard && <AiBudgetWizard month={month} role={role} onClose={() => setWizard(false)} onDone={() => { setWizard(false); loadCats(); load(); }} />}
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
