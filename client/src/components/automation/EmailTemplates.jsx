import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import Placeholders from './Placeholders.jsx';

export default function EmailTemplates({ templates, reload, writable, meta }) {
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault(); setError('');
    try { if (form.id) await api.updateEmailTemplate(form.id, form); else await api.createEmailTemplate(form); setForm(null); setPreview(null); reload(); } catch (err) { setError(err.message); }
  };
  const show = async () => { setError(''); try { setPreview(await api.emailPreview({ subject: form.subject, body: form.body })); } catch (err) { setError(err.message); } };
  return (
    <section className="panel" aria-labelledby="et-h" style={{ marginTop: 18 }}>
      <div className="panel__title"><h2 id="et-h">Email templates</h2>{writable && !form && <button type="button" className="btn" onClick={() => setForm({ name: '', subject: '', body: '' })}><Plus size={16} aria-hidden="true" /> New template</button>}</div>
      <p className="hint ab-help">A template is a subject and message you can reuse in "Send an email" steps. Use placeholders such as <Placeholders text="{{result.news | pretty | truncate:600}}" />, <Placeholders text="{{date}}" /> or <Placeholders text="{{owner.name}}" />; results come from earlier tool or AI steps of the flow.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {form ? (
        <form className="flow-row" onSubmit={save} aria-label="Email template">
          <label className="field"><span className="field__label">Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required /></label>
          <label className="field"><span className="field__label">Subject</span><input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} maxLength={200} required /></label>
          <label className="field" style={{ gridColumn: '1 / -1' }}><span className="field__label">Message</span><textarea rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required /></label>
          <p className="hint" style={{ gridColumn: '1 / -1' }}>Filters: {Object.entries(meta?.filters || {}).map(([k, v]) => `${k} (${v})`).join('; ')}</p>
          <div className="inline-form" style={{ gridColumn: '1 / -1' }}><button type="submit" className="btn btn-primary">Save template</button><button type="button" className="btn" onClick={show}>Preview</button><button type="button" className="btn" onClick={() => { setForm(null); setPreview(null); }}>Cancel</button></div>
          {preview && <div style={{ gridColumn: '1 / -1' }}><p><b>Subject:</b> {preview.subject}</p><iframe title="Template preview" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 300, border: '1px solid var(--color-border)', borderRadius: 10, background: '#fff' }} /></div>}
        </form>
      ) : (
        <ul className="ab-rows" aria-label="Email templates list">
          {(templates?.builtin || []).map((t) => (
            <li key={t.key}><span className="ab-rows__t"><b>{t.name}</b> <small className="muted">ready-made &middot; <Placeholders text={t.subject} /></small></span>
              <span className="ab-rows__a">{writable && <button type="button" className="ab-btn ab-btn--small" onClick={() => setForm({ name: `${t.name} (copy)`, subject: t.subject, body: t.body })}>Copy and edit</button>}</span></li>
          ))}
          {(templates?.custom || []).map((t) => (
            <li key={t.id}><span className="ab-rows__t"><b>{t.name}</b> <small className="muted"><Placeholders text={t.subject} /></small></span>
              <span className="ab-rows__a">{writable && <>
                <button type="button" className="ab-btn ab-btn--small" onClick={() => setForm({ id: t.id, name: t.name, subject: t.subject, body: t.body })}>Edit</button>
                <button type="button" className="ab-btn ab-btn--small ab-btn--danger" aria-label={`Delete template ${t.name}`} onClick={async () => { if (!window.confirm(`Delete the template "${t.name}"?`)) return; try { await api.deleteEmailTemplate(t.id); reload(); } catch (err) { setError(err.message); } }}>Delete</button></>}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

