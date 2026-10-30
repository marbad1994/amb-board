import { useCallback, useEffect, useState } from 'react';
import { Download, Trash2, FileBarChart } from 'lucide-react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import { BudgetTab, SavingsTab, DebtsTab } from '../components/FinanceDepth.jsx';
import { DonutChart, TrendBars } from '../components/Charts.jsx';
import { fmt, toMinor, lastCurrency, rememberCurrency } from '../lib/money.js';

const today = () => new Date().toISOString().slice(0, 10);
const TYPE_LABEL = { expense: 'Expense', income: 'Income', refund: 'Refund' };

export default function FinancePage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [summary, setSummary] = useState(null);
  const [tx, setTx] = useState(null);
  const [cats, setCats] = useState([]);
  const [projects, setProjects] = useState([]);
  const [recurring, setRecurring] = useState([]);
  const [trend, setTrend] = useState(null);
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState(['budget', 'savings', 'debts'].includes(params.get('tab')) ? params.get('tab') : 'overview');
  const [form, setForm] = useState({ type: 'expense', status: 'posted', amount: '', currency: lastCurrency(), date: today(), description: '', categoryId: '', projectId: '' });
  const [rec, setRec] = useState({ description: '', amount: '', currency: lastCurrency(), frequency: 'monthly', start_date: today() });

  const load = useCallback(async () => {
    try {
      const [s, t, r] = await Promise.all([api.financeSummary(month), api.listTransactions({ month, limit: 200 }), api.listRecurring()]);
      setSummary(s); setTx(t); setRecurring(r);
    } catch (err) { setError(err.message); }
  }, [month]);

  useEffect(() => { load(); }, [load]);
  // refresh whenever the Overview tab is (re)opened, e.g. after the AI wizard imported a statement
  useEffect(() => { if (tab === 'overview') { api.financeTrend(6).then(setTrend).catch(() => {}); load(); } }, [tab, load]);
  useEffect(() => {
    api.listCategories().then(setCats).catch(() => {});
    api.listProjects().then(setProjects).catch(() => {});
  }, []);

  const act = async (fn) => { setError(''); try { await fn(); await load(); } catch (err) { setError(err.message); } };
  // "Edit first" from the assistant: fill the add-transaction form with the proposed values
  useEffect(() => {
    const t = location.state?.prefillTx;
    if (!t) return;
    setTab('overview');
    setForm((f) => ({ ...f, type: t.type, status: t.status || 'posted', amount: (t.amount_minor / 100).toFixed(2), currency: t.currency, date: t.date, description: t.description || '', categoryId: t.category_id || '', projectId: t.project_id || '' }));
    navigate('/finance', { replace: true, state: null });
  }, [location.state, navigate]);
  const makeReport = async () => {
    try { const r = await api.createReport({ kind: 'monthly_finance', month }); navigate(`/reports/${r.id}`); } catch (err) { setError(err.message); }
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = (e) => {
    e.preventDefault();
    const minor = toMinor(form.amount);
    if (minor === null) return setError('Enter an amount such as 25 or 25.50');
    rememberCurrency(form.currency);
    act(async () => {
      await api.createTransaction({ type: form.type, status: form.status, amount_minor: minor, currency: form.currency.toUpperCase(), date: form.date,
        description: form.description, categoryId: form.categoryId || null, projectId: form.projectId || null });
      setForm((f) => ({ ...f, amount: '', description: '' }));
    });
  };

  const addRecurring = (e) => {
    e.preventDefault();
    const minor = toMinor(rec.amount);
    if (minor === null) return setError('Enter a subscription amount such as 12.99');
    act(async () => {
      await api.createRecurring({ description: rec.description, amount_minor: minor, currency: rec.currency.toUpperCase(), frequency: rec.frequency, start_date: rec.start_date, is_subscription: true });
      setRec((r) => ({ ...r, description: '', amount: '' }));
    });
  };

  const exportCsv = async () => {
    try {
      const url = URL.createObjectURL(await api.downloadTransactionsCsv());
      const a = document.createElement('a');
      a.href = url; a.download = 'transactions.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">FINANCIAL OVERVIEW</div>
          <h1>Finance &amp; Budget</h1>
          <p className="page-sub">Totals are shown per currency and never converted or added across currencies. Project budgets are set on each project.</p>
        </div>
        {tab === 'overview' && <div className="inline-form">
          <input type="month" aria-label="Month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          {writable && <button type="button" className="btn" onClick={makeReport}><FileBarChart size={16} aria-hidden="true" /> Create report</button>}
          <button type="button" className="btn" onClick={exportCsv}><Download size={16} aria-hidden="true" /> Export CSV</button>
        </div>}
      </div>
      <div className="seg seg--tabs" role="group" aria-label="Finance sections">
        {[['overview', 'Overview'], ['budget', 'Monthly budget'], ['savings', 'Savings'], ['debts', 'Debts']].map(([v, l]) => <button key={v} type="button" aria-pressed={tab === v} onClick={() => setTab(v)}>{l}</button>)}
      </div>
      {tab === 'budget' && <BudgetTab role={active?.role} writable={writable} />}
      {tab === 'savings' && <SavingsTab writable={writable} />}
      {tab === 'debts' && <DebtsTab writable={writable} />}
      {error && <p className="form-error" role="alert">{error}</p>}

      {tab === 'overview' && <>
      {summary && summary.currencies.length === 0 && <div className="empty-state">No transactions in {month}.</div>}
      {summary?.currencies.map((c) => (
        <section key={c.currency} className="panel" style={{ marginBottom: 16 }} aria-label={`${c.currency} summary`}>
          <div className="panel__title"><h2>{c.currency}</h2></div>
          <div className="stat-grid">
            <div className="stat-card"><div className="stat-card__head"><span>Income</span></div><div className="stat-card__num">{fmt(c.income_minor, c.currency)}</div></div>
            <div className="stat-card"><div className="stat-card__head"><span>Expenses</span></div><div className="stat-card__num">{fmt(c.expenses_minor, c.currency)}</div><div className="stat-card__sub">Paid, net of refunds</div></div>
            <div className="stat-card"><div className="stat-card__head"><span>Net cash flow</span></div><div className="stat-card__num">{fmt(c.net_cashflow_minor, c.currency)}</div><div className="stat-card__sub">Income minus expenses, not a balance</div></div>
            <div className="stat-card"><div className="stat-card__head"><span>Planned</span></div><div className="stat-card__num">{fmt(c.planned_expenses_minor, c.currency)}</div><div className="stat-card__sub">Not yet paid</div></div>
          </div>
          <div className="chart-row">
            {c.categories.length > 0 && <div><h3 className="sub-h">Spending by category</h3><DonutChart data={c.categories.map((k) => ({ label: k.name, value: k.total_minor }))} currency={c.currency} title={`Spending by category in ${c.currency}`} /></div>}
            {trend?.series.find((x) => x.currency === c.currency) && <div><h3 className="sub-h">Last 6 months</h3><TrendBars points={trend.series.find((x) => x.currency === c.currency).points} currency={c.currency} /></div>}
          </div>
        </section>
      ))}

      {writable && (
        <form className="panel" onSubmit={add} aria-label="Add transaction" style={{ marginBottom: 16 }}>
          <div className="panel__title"><h2>Add transaction</h2></div>
          <div className="inline-form inline-form--wide">
            <select aria-label="Type" value={form.type} onChange={set('type')}>{Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <input type="text" inputMode="decimal" aria-label="Amount" placeholder="Amount" value={form.amount} onChange={set('amount')} />
            <input type="text" aria-label="Currency" maxLength={3} style={{ maxWidth: 80 }} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
            <input type="date" aria-label="Date" value={form.date} onChange={set('date')} />
          </div>
          <div className="inline-form inline-form--wide">
            <input type="text" aria-label="Description" placeholder="Description" maxLength={200} value={form.description} onChange={set('description')} />
            <select aria-label="Category" value={form.categoryId} onChange={set('categoryId')}><option value="">No category</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select aria-label="Project" value={form.projectId} onChange={set('projectId')}><option value="">No project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select aria-label="Payment status" value={form.status} onChange={set('status')}><option value="posted">Paid</option><option value="planned">Planned</option></select>
            <button type="submit" className="btn btn-primary" disabled={!form.amount}>Add</button>
          </div>
        </form>
      )}

      <div className="dash-grid">
        <section className="panel" aria-labelledby="tx-h">
          <div className="panel__title"><h2 id="tx-h">Transactions</h2><span className="muted">{tx?.total ?? 0} in {month}</span></div>
          {tx && tx.items.length === 0 && <p className="muted">Nothing recorded for this month.</p>}
          <ul className="task-list">
            {tx?.items.map((t) => (
              <li key={t.id}>
                <div className="task-list__main">
                  <span>{t.description || t.category_name || TYPE_LABEL[t.type] || t.type}</span>
                  <small>{t.date} · {t.category_name || 'Uncategorised'}{t.project_name ? ` · ${t.project_name}` : ''}{t.status === 'planned' ? ' · planned' : ''}</small>
                </div>
                <b>{t.type === 'expense' ? '-' : '+'}{fmt(t.amount_minor, t.currency)}</b>
                {writable && (
                  <button type="button" className="btn btn-icon btn-ghost" aria-label={`Void ${t.description || 'transaction'}`}
                    onClick={() => window.confirm('Void this transaction? It stays in the audit log but no longer counts.') && act(() => api.voidTransaction(t.id))}>
                    <Trash2 size={14} color="var(--color-danger)" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="panel" aria-labelledby="rec-h">
          <div className="panel__title"><h2 id="rec-h">Subscriptions &amp; recurring</h2></div>
          <ul className="plain-list">
            {recurring.map((r) => (
              <li key={r.id}><span>{r.description} · {r.frequency} · next {r.next_date}</span><b>{fmt(r.amount_minor, r.currency)}</b>
                {writable && <button type="button" className="btn btn-ghost" onClick={() => act(() => api.deleteRecurring(r.id))}>Stop</button>}</li>
            ))}
          </ul>
          {recurring.length === 0 && <p className="muted">None yet. Due charges become planned transactions; you confirm them as paid.</p>}
          {writable && (
            <form className="inline-form inline-form--wide" onSubmit={addRecurring} aria-label="Add subscription">
              <input type="text" aria-label="Subscription name" placeholder="e.g. Netflix" value={rec.description} onChange={(e) => setRec({ ...rec, description: e.target.value })} />
              <input type="text" inputMode="decimal" aria-label="Subscription amount" placeholder="Amount" value={rec.amount} onChange={(e) => setRec({ ...rec, amount: e.target.value })} />
              <input type="text" aria-label="Subscription currency" maxLength={3} style={{ maxWidth: 80 }} value={rec.currency} onChange={(e) => setRec({ ...rec, currency: e.target.value.toUpperCase() })} />
              <select aria-label="Frequency" value={rec.frequency} onChange={(e) => setRec({ ...rec, frequency: e.target.value })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
              <input type="date" aria-label="First charge date" value={rec.start_date} onChange={(e) => setRec({ ...rec, start_date: e.target.value })} />
              <button type="submit" className="btn" disabled={!rec.description || !rec.amount}>Add</button>
            </form>
          )}
        </section>
      </div>
      </>}
    </div>
  );
}
