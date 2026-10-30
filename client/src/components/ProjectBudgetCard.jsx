import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { canManage } from '../context/AuthContext.jsx';
import { fmt, toMinor, lastCurrency, rememberCurrency } from '../lib/money.js';

const STATUS_TEXT = {
  ok: 'Within budget', warning: 'Approaching the limit', forecast_over: 'Forecast to exceed budget', over: 'Over budget',
};

export default function ProjectBudgetCard({ projectId, role, writable }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [bud, setBud] = useState({ amount: '', currency: lastCurrency(), alert: '80' });
  const [exp, setExp] = useState({ amount: '', description: '', status: 'posted' });

  const load = useCallback(() => api.projectFinance(projectId).then(setData).catch((err) => setError(err.message)), [projectId]);
  useEffect(() => { load(); }, [load]);

  const b = data?.budget;
  const act = async (fn) => { setError(''); try { await fn(); await load(); } catch (err) { setError(err.message); } };

  const saveBudget = (e) => {
    e.preventDefault();
    const minor = toMinor(bud.amount);
    if (minor === null) return setError('Enter a budget amount such as 12000 or 12000.50');
    rememberCurrency(bud.currency.toUpperCase());
    act(() => api.setProjectBudget(projectId, { currency: bud.currency.toUpperCase(), approved_minor: minor, alert_pct: Number(bud.alert) }));
  };

  const addExpense = (e) => {
    e.preventDefault();
    const minor = toMinor(exp.amount);
    if (minor === null) return setError('Enter an amount such as 25 or 25.50');
    const currency = b?.has_budget ? b.currency : lastCurrency();
    act(async () => {
      await api.createTransaction({ type: 'expense', status: exp.status, amount_minor: minor, currency, date: new Date().toISOString().slice(0, 10), description: exp.description, projectId });
      setExp({ amount: '', description: '', status: 'posted' });
    });
  };

  return (
    <section className="budget-card" aria-label="Project budget">
      <h3>Budget</h3>
      {error && <p className="form-error" role="alert">{error}</p>}
      {b?.has_budget ? (
        <>
          <dl className="budget-grid">
            <div><dt>Approved</dt><dd>{fmt(b.approved_minor, b.currency)}</dd></div>
            <div><dt>Spent</dt><dd>{fmt(b.actual_minor, b.currency)}</dd></div>
            <div><dt>Remaining</dt><dd>{fmt(b.remaining_minor, b.currency)}</dd></div>
            <div><dt>Planned</dt><dd>{fmt(b.planned_minor, b.currency)}</dd></div>
            <div><dt>Forecast total</dt><dd>{fmt(b.forecast_minor, b.currency)}</dd></div>
            <div><dt>Forecast overrun</dt><dd>{fmt(b.forecast_overrun_minor, b.currency)}</dd></div>
          </dl>
          <p className={`budget-status budget-status--${b.status}`}>{STATUS_TEXT[b.status]} ({b.used_pct}% spent)</p>
          {b.other_currencies.length > 0 && (
            <p className="hint">Also recorded in other currencies, not converted or included above: {b.other_currencies.map((o) => fmt(o.actual_minor, o.currency)).join(', ')}.</p>
          )}
        </>
      ) : (
        <p className="muted">No budget set.{data?.budget.by_currency?.length > 0 && ` Spending recorded: ${data.budget.by_currency.map((o) => fmt(o.actual_minor, o.currency)).join(', ')}.`}</p>
      )}

      {canManage(role) ? (
        <form className="inline-form inline-form--wide" onSubmit={saveBudget}>
          <input type="text" inputMode="decimal" aria-label="Approved budget amount" placeholder={b?.has_budget ? 'Change approved budget' : 'Approved budget'}
            value={bud.amount} onChange={(e) => setBud({ ...bud, amount: e.target.value })} />
          <input type="text" aria-label="Budget currency" maxLength={3} style={{ maxWidth: 80 }} value={bud.currency} onChange={(e) => setBud({ ...bud, currency: e.target.value.toUpperCase() })} />
          <input type="number" aria-label="Alert at percent spent" min={1} max={100} style={{ maxWidth: 90 }} value={bud.alert} onChange={(e) => setBud({ ...bud, alert: e.target.value })} />
          <button type="submit" className="btn" disabled={!bud.amount}>{b?.has_budget ? 'Update budget' : 'Set budget'}</button>
        </form>
      ) : (
        <p className="hint">Only owners and admins can approve or change budgets.</p>
      )}

      {writable && (
        <form className="inline-form inline-form--wide" onSubmit={addExpense}>
          <input type="text" inputMode="decimal" aria-label="Expense amount" placeholder="Expense amount" value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} />
          <input type="text" aria-label="Expense description" placeholder="What for" maxLength={200} value={exp.description} onChange={(e) => setExp({ ...exp, description: e.target.value })} />
          <select aria-label="Expense status" value={exp.status} onChange={(e) => setExp({ ...exp, status: e.target.value })}>
            <option value="posted">Paid</option><option value="planned">Planned</option>
          </select>
          <button type="submit" className="btn btn-primary" disabled={!exp.amount}>Add expense</button>
        </form>
      )}

      {data?.transactions.length > 0 && (
        <ul className="plain-list">
          {data.transactions.slice(0, 8).map((t) => (
            <li key={t.id}><span>{t.date} · {t.description || t.category_name || t.type}{t.status === 'planned' ? ' (planned)' : ''}</span>
              <b>{t.type === 'refund' ? '+' : '-'}{fmt(t.amount_minor, t.currency)}</b></li>
          ))}
        </ul>
      )}
    </section>
  );
}
