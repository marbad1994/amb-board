import { useEffect, useRef, useState } from 'react';
import { X, Trash2, Paperclip, Send, FileText, Plus } from 'lucide-react';
import { api } from '../api/client.js';
import { useIdentity } from '../context/IdentityContext.jsx';
import DictationButton from './DictationButton.jsx';
import { labelColor } from '../utils/labelColor.js';

const STATUSES = [
  { value: 'todo', label: 'To do' },
  { value: 'doing', label: 'Doing' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

export default function CardModal({ cardId, onClose, onChanged, onDeleted }) {
  const { name } = useIdentity();
  const [card, setCard] = useState(null);
  const [error, setError] = useState('');
  const [commentText, setCommentText] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const fileInputRef = useRef(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    api.getCard(cardId).then(setCard).catch((err) => setError(err.message));
  }, [cardId]);

  const patch = async (fields) => {
    setCard((prev) => ({ ...prev, ...fields }));
    try {
      const updated = await api.updateCard(cardId, fields);
      setCard(updated);
      onChanged?.(updated);
    } catch (err) {
      setError(err.message);
    }
  };

  const debouncedDescriptionSave = (value) => {
    setCard((prev) => ({ ...prev, description: value }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => patch({ description: value }), 500);
  };

  const deleteCard = async () => {
    if (!window.confirm('Delete this card?')) return;
    await api.deleteCard(cardId);
    onDeleted?.(cardId);
    onClose();
  };

  const submitComment = async (e) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    try {
      const updated = await api.addComment(cardId, { author: name, text: commentText.trim() });
      setCard(updated);
      onChanged?.(updated);
      setCommentText('');
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteComment = async (commentId) => {
    const updated = await api.deleteComment(cardId, commentId);
    setCard(updated);
    onChanged?.(updated);
  };

  const uploadFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await api.uploadAttachment(cardId, file);
      const updated = await api.getCard(cardId);
      setCard(updated);
      onChanged?.(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      e.target.value = '';
    }
  };

  const deleteAttachment = async (attachmentId) => {
    await api.deleteAttachment(cardId, attachmentId);
    const updated = await api.getCard(cardId);
    setCard(updated);
    onChanged?.(updated);
  };

  const addLabel = () => {
    const text = labelInput.trim();
    if (!text) return;
    const current = card.labels || [];
    if (!current.some((l) => l.toLowerCase() === text.toLowerCase())) {
      patch({ labels: [...current, text] });
    }
    setLabelInput('');
  };

  const removeLabel = (label) => {
    patch({ labels: (card.labels || []).filter((l) => l !== label) });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>{card?.title || 'Loading…'}</h2>
          <button type="button" className="btn btn-icon btn-ghost" onClick={deleteCard} title="Delete card">
            <Trash2 size={18} color="var(--color-danger)" />
          </button>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        {error && <p style={{ color: 'var(--color-danger)', padding: '0 16px' }}>{error}</p>}

        {card && (
          <div className="modal__body">
            <div className="field">
              <label htmlFor="card-title">Title</label>
              <input
                id="card-title"
                type="text"
                value={card.title}
                onChange={(e) => setCard((prev) => ({ ...prev, title: e.target.value }))}
                onBlur={(e) => patch({ title: e.target.value })}
              />
            </div>

            <div className="two-col">
              <div className="field">
                <label htmlFor="card-owner">Owner</label>
                <input
                  id="card-owner"
                  type="text"
                  value={card.owner || ''}
                  placeholder="Unassigned"
                  onChange={(e) => setCard((prev) => ({ ...prev, owner: e.target.value }))}
                  onBlur={(e) => patch({ owner: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Creator</label>
                <input type="text" value={card.creator || ''} disabled />
              </div>
            </div>

            <div className="field">
              <label htmlFor="card-status">Status</label>
              <select id="card-status" value={card.status} onChange={(e) => patch({ status: e.target.value })}>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Labels</label>
              <div className="label-chip-row">
                {(card.labels || []).map((label) => (
                  <span key={label} className="label-chip" style={{ background: labelColor(label) }}>
                    {label}
                    <button type="button" onClick={() => removeLabel(label)} title="Remove label">
                      <X size={11} />
                    </button>
                  </span>
                ))}
                {!card.labels?.length && (
                  <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>No labels yet.</span>
                )}
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
                  <Plus size={16} />
                  Add
                </button>
              </div>
            </div>

            <div className="field-with-mic">
              <label htmlFor="card-description">Description / info</label>
              <div className="field-with-mic__row">
                <textarea
                  id="card-description"
                  value={card.description || ''}
                  placeholder="Details, context, links…"
                  onChange={(e) => debouncedDescriptionSave(e.target.value)}
                />
                <DictationButton
                  onText={(text) =>
                    debouncedDescriptionSave(`${card.description ? card.description + ' ' : ''}${text}`)
                  }
                />
              </div>
              <p style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: 0 }}>
                Speak in English, Romanian or Swedish — dictation is always saved in English.
              </p>
            </div>

            <div className="modal__section">
              <h4>Attachments</h4>
              <div className="attachment-list">
                {card.attachments?.map((att) => (
                  <div key={att.id} className="attachment-item">
                    <FileText size={16} />
                    <a href={`/api/attachments/${att.id}/download`} target="_blank" rel="noreferrer">
                      {att.original_name}
                    </a>
                    <button
                      type="button"
                      className="btn btn-icon btn-ghost"
                      onClick={() => deleteAttachment(att.id)}
                      title="Remove attachment"
                    >
                      <Trash2 size={14} color="var(--color-danger)" />
                    </button>
                  </div>
                ))}
                {!card.attachments?.length && (
                  <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>No attachments yet.</p>
                )}
              </div>
              <div className="attach-upload" style={{ marginTop: 10 }}>
                <input ref={fileInputRef} type="file" onChange={uploadFile} />
                <button type="button" className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip size={16} />
                  Add attachment
                </button>
              </div>
            </div>

            <div className="modal__section">
              <h4>Comments</h4>
              <div className="comment-list">
                {card.comments?.map((c) => (
                  <div key={c.id} className="comment-item">
                    <div className="comment-item__meta">
                      <span>{c.author || 'Anonymous'} · {new Date(c.created_at).toLocaleString()}</span>
                      <button
                        type="button"
                        className="btn btn-icon btn-ghost"
                        onClick={() => deleteComment(c.id)}
                        title="Delete comment"
                        style={{ width: 24, height: 24 }}
                      >
                        <Trash2 size={12} color="var(--color-danger)" />
                      </button>
                    </div>
                    <p>{c.text}</p>
                  </div>
                ))}
              </div>
              <form className="comment-form" onSubmit={submitComment}>
                <textarea
                  placeholder={`Comment as ${name}…`}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                />
                <DictationButton onText={(text) => setCommentText((prev) => `${prev ? prev + ' ' : ''}${text}`)} />
                <button type="submit" className="btn btn-icon btn-primary" disabled={!commentText.trim()}>
                  <Send size={16} />
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
