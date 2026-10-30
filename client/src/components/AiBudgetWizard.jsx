import { useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { api } from '../api/client.js';
import { canManage } from '../context/AuthContext.jsx';
import { fmt, toMinor, lastCurrency, rememberCurrency } from '../lib/money.js';

const BASIS = { sheet: 'Amount from your budget sheet', csv_average: 'From your statement (average, rounded up)', user_prompt: 'A figure you stated', ai_estimate: 'AI estimate: please check' };
const toMajor = (minor) => (minor / 100).toFixed(2);

export default function AiBudgetWizard({ month: initialMonth, role, onClose, onDone }) {
  const [step, setStep] = useState('input');
  const [form, setForm] = useState({ prompt: '', month: initialMonth, currency: lastCurrency(), signMode: 'auto' });
  const [file, setFile] = useState(null);
  const [draft, setDraft] = useState(null);
  const [lines, setLines] = useState([]);
  const [importTx, setImportTx] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const mayApply = canManage(role);

  const generate = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    const fd = new FormData();
    if (file) fd.append('csv', file);
    if (form.prompt.trim()) fd.append('prompt', form.prompt.trim());
    fd.append('month', form.month); fd.append('currency', form.currency.toUpperCase()); fd.append('signMode', form.signMode);
    try {
      rememberCurrency(form.currency.toUpperCase());
      const d = await api.aiBudgetDraft(fd);
      setDraft(d);
      setLines(d.lines.map((l, i) => ({ ...l, key: i, include: true, limit: toMajor(l.limit_minor) })));
      setImportTx(false);
      setStep('review');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const update = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const active = lines.filter((l) => l.include);
  const invalid = active.some((l) => !l.category.trim() || (l.limit !== '' && toMinor(l.limit) === null && Number(l.limit) !== 0));
  const total = active.reduce((a, l) => a + (toMinor(l.limit) || 0), 0);

  const apply = async () => {
    setBusy(true); setError('');
    try {
      const payload = active.map((l) => ({ category: l.category.trim(), parent: (l.parent || '').trim() || null, limit_minor: toMinor(l.limit) || 0 }));
      setResult(await api.applyAiBudget(draft.id, { lines: payload, importTransactions: importTx }));
      setStep('done');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="Create budget with AI" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2><Sparkles size={18} aria-hidden="true" /> Create budget with AI</h2>
          <button type="button" className="btn btn-icon btn-ghost" onClick={step === 'done' ? onDone : onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal__body">
          {error && <p className="form-error" role="alert">{error}</p>}

          {step === 'input' && (
            <form onSubmit={generate}>
              <div className="field">
                <label htmlFor="ab-prompt">Describe what you need</label>
                <textarea id="ab-prompt" rows={4} maxLength={2000} placeholder="e.g. Monthly budget for a couple in Bucharest. Rent is 2500 RON, we earn about 9000 RON and want to save 1000 a month." value={form.prompt} onChange={set('prompt')} />
              </div>
              <div className="field">
                <label htmlFor="ab-file">Or add a bank statement (CSV)</label>
                <input id="ab-file" ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                <small className="hint">Export your bank statement or your budget sheet as CSV (up to 2 MB). Your file is read by the app: amounts and dates are calculated by code, not by the AI.</small>
              </div>
              <div className="two-col">
                <div className="field"><label htmlFor="ab-month">Month to budget</label><input id="ab-month" type="month" required value={form.month} onChange={set('month')} /></div>
                <div className="field"><label htmlFor="ab-cur">Currency</label><input id="ab-cur" type="text" maxLength={3} required value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></div>
              </div>
              {file && (
                <div className="field"><label htmlFor="ab-sign">How are expenses shown in the file?</label>
                  <select id="ab-sign" value={form.signMode} onChange={set('signMode')}>
                    <option value="auto">Work it out automatically</option><option value="negative_is_expense">Expenses are negative numbers</option><option value="positive_is_expense">Expenses are positive numbers</option></select></div>
              )}
              <p className="notice">Privacy: only your description and the merchant names from the file (with card numbers, dates and amounts removed) are sent to the AI provider. A budget spreadsheet (labels and amounts, no dates, any language) also works: only the row labels are sent, never the amounts. Nothing is saved until you review and approve the draft.</p>
              <button type="submit" className="btn btn-primary btn-block" disabled={busy || (!form.prompt.trim() && !file)}>
                {busy ? <><Loader2 size={16} className="spin" aria-hidden="true" /> Working...</> : 'Generate draft'}
              </button>
            </form>
          )}

          {step === 'review' && draft && (
            <>
              <p className="muted">Draft for <b>{draft.month}</b> in <b>{draft.currency}</b>. Nothing has been saved yet. Edit anything, untick what you do not want, then create the budget.</p>
              {draft.notes.map((n, i) => <p key={i} className="hint">{n}</p>)}
              {draft.sheet && (
                <p className="notice">Read as a budget sheet: {draft.sheet.lines_read} labelled amounts found. Total of the expense lines: {fmt(draft.sheet.expenses_total_minor, draft.currency)}.
                  {draft.income && ` Income found: ${fmt(draft.income.avg_monthly_minor, draft.currency)}.`}</p>
              )}
              {draft.csv && (
                <p className="notice">{draft.csv.rows_used} of {draft.csv.rows_total} rows read ({draft.csv.rows_skipped} skipped), {draft.csv.from} to {draft.csv.to}. Expenses were taken from: {draft.csv.sign_assumption}.
                  {draft.income && ` Average income in the file: ${fmt(draft.income.avg_monthly_minor, draft.currency)} per month.`}
                  {draft.csv.other_currency_rows > 0 && ` ${draft.csv.other_currency_rows} rows in other currencies are not part of these limits.`}</p>
              )}
              <div className="table-wrap">
                <table className="table" aria-label="Proposed budget lines">
                  <thead><tr><th>Use</th><th>Category</th><th>Under</th><th>Monthly limit ({draft.currency})</th><th>Where it comes from</th></tr></thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.key} className={l.include ? '' : 'is-off'}>
                        <td><input type="checkbox" aria-label={`Use ${l.category}`} checked={l.include} onChange={(e) => update(l.key, { include: e.target.checked })} /></td>
                        <td><input type="text" aria-label={`Name of ${l.category}`} maxLength={40} value={l.category} onChange={(e) => update(l.key, { category: e.target.value })} /></td>
                        <td><input type="text" aria-label={`Parent of ${l.category}`} maxLength={40} placeholder="optional" value={l.parent || ''} onChange={(e) => update(l.key, { parent: e.target.value })} /></td>
                        <td><input type="text" inputMode="decimal" aria-label={`Limit for ${l.category}`} value={l.limit} onChange={(e) => update(l.key, { limit: e.target.value })} /></td>
                        <td><small>{BASIS[l.basis]}{l.history ? ` · ${fmt(l.history.avg_minor, draft.currency)}/month over ${l.history.months} mo` : ''}</small></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p><b>Total monthly limits: {fmt(total, draft.currency)}</b></p>
              {draft.importable_transactions > 0 && (
                <label className="check"><input type="checkbox" checked={importTx} onChange={(e) => setImportTx(e.target.checked)} /> Also import the {draft.importable_transactions} transactions from the file (re-importing the same file never creates duplicates)</label>
              )}
              {!mayApply && <p className="notice">Only owners and admins can create budgets. You can edit this draft, but ask an admin to apply it.</p>}
              <div className="inline-form">
                <button type="button" className="btn" onClick={() => setStep('input')}>Back</button>
                <button type="button" className="btn btn-primary" disabled={busy || invalid || active.length === 0 || !mayApply} onClick={apply}>
                  {busy ? 'Creating...' : `Create budget (${active.length} categories)`}
                </button>
              </div>
            </>
          )}

          {step === 'done' && result && (
            <>
              <p><b>Budget created for {result.month}.</b></p>
              <ul className="plain-list">
                <li><span>Category limits set</span><b>{result.budgets_set}</b></li>
                <li><span>New categories created</span><b>{result.categories_created}</b></li>
                <li><span>Transactions imported</span><b>{result.transactions_imported}</b></li>
                {result.duplicates_skipped > 0 && <li><span>Already imported before (skipped)</span><b>{result.duplicates_skipped}</b></li>}
              </ul>
              <button type="button" className="btn btn-primary btn-block" onClick={onDone}>Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
