import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Settings2, Trash2 } from 'lucide-react';
import CardItem from './CardItem.jsx';

const STATUS_OPTIONS = [['', 'No status (cards keep their own)'], ['todo', 'To do'], ['doing', 'Doing'], ['blocked', 'Blocked'], ['done', 'Done']];

export default function Column({ column, onOpenCard, onAddCard, onRename, onDelete, onSettings, writable = true }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState({ status: column.status || '', limit: column.card_limit ?? '' });
  const full = column.card_limit != null && column.cards.length >= column.card_limit;
  const over = column.card_limit != null && column.cards.length > column.card_limit;
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [name, setName] = useState(column.name);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    data: { type: 'column' },
  });
  const { setNodeRef: setDroppableRef } = useDroppable({
    id: `column-drop-${column.id}`,
    data: { type: 'column', columnId: column.id },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const submitCard = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAddCard(column.id, title.trim());
    setTitle('');
    setAdding(false);
  };

  const commitName = () => {
    if (name.trim() && name.trim() !== column.name) onRename(column.id, name.trim());
    else setName(column.name);
  };

  return (
    <div ref={setNodeRef} style={style} className={`column ${isDragging ? 'is-dragging' : ''}`}>
      <div className="column__header" {...attributes} {...listeners}>
        <GripVertical size={16} color="var(--color-text-muted)" />
        <input
          className="column__title"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <span className={`column__count ${over ? 'is-over' : full ? 'is-full' : ''}`} title={column.card_limit != null ? `Limit ${column.card_limit} cards` : 'No card limit'}
          aria-label={`${column.cards.length} cards${column.card_limit != null ? `, limit ${column.card_limit}` : ''}`}>
          {column.cards.length}{column.card_limit != null ? ` / ${column.card_limit}` : ''}
        </span>
        {writable && (
          <button type="button" className="btn btn-icon btn-ghost" onPointerDown={(e) => e.stopPropagation()} onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen} aria-label={`Settings for column ${column.name}`} title="Column settings"><Settings2 size={16} /></button>
        )}
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            if (window.confirm(`Delete column "${column.name}" and all its cards?`)) onDelete(column.id);
          }}
          title="Delete column"
        >
          <Trash2 size={16} color="var(--color-danger)" />
        </button>
      </div>

      {(column.status || column.card_limit != null) && !settingsOpen && (
        <p className="column__rules">{column.status && <span className={`badge status-${column.status}`}>Holds: {STATUS_OPTIONS.find(([v]) => v === column.status)[1]}</span>}{full && <span className="badge status-blocked">{over ? 'Over limit' : 'Full'}</span>}</p>
      )}
      {settingsOpen && (
        <form className="column__settings" onSubmit={async (e) => { e.preventDefault(); await onSettings(column.id, { status: draft.status || null, card_limit: draft.limit === '' ? null : Number(draft.limit) }); setSettingsOpen(false); }}>
          <label className="field"><span className="field__label">Status of cards in this column</span>
            <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span className="field__label">Most cards it can hold</span>
            <input type="number" min="1" max="999" placeholder="No limit" value={draft.limit} onChange={(e) => setDraft({ ...draft, limit: e.target.value })} /></label>
          <p className="hint">Dropping a card here sets its status. Several columns can hold the same status.</p>
          <div style={{ display: 'flex', gap: 6 }}><button type="submit" className="btn btn-primary">Save</button><button type="button" className="btn btn-ghost" onClick={() => setSettingsOpen(false)}>Cancel</button></div>
        </form>
      )}

      <SortableContext items={column.cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="column__cards" ref={setDroppableRef}>
          {column.cards.map((card) => (
            <CardItem key={card.id} card={card} onOpen={onOpenCard} />
          ))}
        </div>
      </SortableContext>

      <div className="column__add-card">
        {adding ? (
          <form onSubmit={submitCard}>
            <input
              type="text"
              autoFocus
              placeholder="Card title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => !title.trim() && setAdding(false)}
              style={{ marginBottom: 6 }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="submit" className="btn btn-primary" disabled={!title.trim()}>
                Add card
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setAdding(true)} disabled={full}
            title={full ? `Column is full (limit ${column.card_limit})` : undefined}>
            <Plus size={16} />
            {full ? 'Column full' : 'Add card'}
          </button>
        )}
      </div>
    </div>
  );
}
