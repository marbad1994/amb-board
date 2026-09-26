import { useState } from 'react';
import { Mic, Square, Loader2, Sparkles, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useDictation } from '../hooks/useDictation.js';
import { labelColor } from '../utils/labelColor.js';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ro', label: 'Română' },
  { code: 'sv', label: 'Svenska' },
];

export default function AITaskModal({ projectId, columns, defaultName, onClose, onCreate }) {
  const [lang, setLang] = useState('en');
  const [rawText, setRawText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [result, setResult] = useState(null);
  const [labelInput, setLabelInput] = useState('');

  const { start, stop, listening, error: dictationError, supported } = useDictation({
    translate: false,
    onResult: (text) => setRawText((prev) => (prev ? `${prev} ${text}` : text)),
  });

  const generate = async () => {
    if (!rawText.trim()) return;
    setLoading(true);
    setError('');
    setWarning('');
    try {
      const parsed = await api.aiParseTask(projectId, rawText.trim(), lang);
      if (!parsed.available) {
        setWarning(parsed.warning || 'AI task helper is unavailable.');
        setResult({
          title: rawText.trim().slice(0, 80),
          description: rawText.trim(),
          owner: '',
          column: columns[0]?.name || '',
          columnId: columns[0]?.id,
          labels: [],
        });
      } else {
        setResult(parsed);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateResult = (fields) => setResult((prev) => ({ ...prev, ...fields }));

  const addLabel = () => {
    const text = labelInput.trim();
    if (!text) return;
    if (!result.labels.some((l) => l.toLowerCase() === text.toLowerCase())) {
      updateResult({ labels: [...result.labels, text] });
    }
    setLabelInput('');
  };

  const removeLabel = (label) => updateResult({ labels: result.labels.filter((l) => l !== label) });

  const create = () => {
    if (!result?.title.trim()) return;
    const targetColumnId = columns.find((c) => c.name === result.column)?.id || result.columnId || columns[0].id;
    onCreate({
      columnId: targetColumnId,
      title: result.title.trim(),
      description: result.description,
      owner: result.owner,
      creator: defaultName,
      labels: result.labels,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>
            <Sparkles size={18} style={{ verticalAlign: -3, marginRight: 6 }} />
            AI task helper
          </h2>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal__body">
          {!result && (
            <>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 13, marginTop: 0 }}>
                Say or type what you want done, in English, Romanian or Swedish — mention who should do it,
                what it involves, and how urgent it is. The AI will fill in the title, description, owner,
                column and labels for you.
              </p>

              <div className="field">
                <label htmlFor="ai-task-lang">Spoken language</label>
                <select id="ai-task-lang" value={lang} onChange={(e) => setLang(e.target.value)}>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-with-mic">
                <label htmlFor="ai-task-text">What do you need?</label>
                <div className="field-with-mic__row">
                  <textarea
                    id="ai-task-text"
                    value={rawText}
                    placeholder="e.g. Ion trebuie să repare ușa de la intrare până vineri, e urgent"
                    onChange={(e) => setRawText(e.target.value)}
                  />
                  {supported && (
                    <button
                      type="button"
                      className={`dictation__mic ${listening ? 'is-listening' : ''}`}
                      onClick={() => (listening ? stop() : start(lang))}
                      title={listening ? 'Stop dictation' : 'Start dictation'}
                    >
                      {listening ? <Square size={16} /> : <Mic size={18} />}
                    </button>
                  )}
                </div>
                {dictationError && <p className="dictation__error">{dictationError}</p>}
              </div>

              {error && <p style={{ color: 'var(--color-danger)' }}>{error}</p>}

              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={generate}
                disabled={!rawText.trim() || loading}
              >
                {loading ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                {loading ? 'Thinking…' : 'Generate task'}
              </button>
            </>
          )}

          {result && (
            <>
              {warning && <div className="warning-banner">{warning}</div>}

              <div className="field">
                <label htmlFor="ai-result-title">Title</label>
                <input
                  id="ai-result-title"
                  type="text"
                  value={result.title}
                  onChange={(e) => updateResult({ title: e.target.value })}
                />
              </div>

              <div className="two-col">
                <div className="field">
                  <label htmlFor="ai-result-owner">Owner</label>
                  <input
                    id="ai-result-owner"
                    type="text"
                    value={result.owner}
                    placeholder="Unassigned"
                    onChange={(e) => updateResult({ owner: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ai-result-column">Column</label>
                  <select
                    id="ai-result-column"
                    value={result.column}
                    onChange={(e) => updateResult({ column: e.target.value })}
                  >
                    {columns.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="ai-result-description">Description</label>
                <textarea
                  id="ai-result-description"
                  value={result.description}
                  onChange={(e) => updateResult({ description: e.target.value })}
                />
              </div>

              <div className="field">
                <label>Labels</label>
                <div className="label-chip-row">
                  {result.labels.map((label) => (
                    <span key={label} className="label-chip" style={{ background: labelColor(label) }}>
                      {label}
                      <button type="button" onClick={() => removeLabel(label)} title="Remove label">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="field-with-mic__row" style={{ marginTop: 6 }}>
                  <input
                    type="text"
                    placeholder="Add a label"
                    value={labelInput}
                    onChange={(e) => setLabelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addLabel();
                      }
                    }}
                  />
                  <button type="button" className="btn btn-ghost" onClick={addLabel}>
                    Add
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setResult(null)}>
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  onClick={create}
                  disabled={!result.title.trim()}
                >
                  Create task
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
