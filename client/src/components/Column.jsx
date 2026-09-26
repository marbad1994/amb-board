import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import CardItem from './CardItem.jsx';

export default function Column({ column, onOpenCard, onAddCard, onRename, onDelete }) {
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
        <span className="column__count">{column.cards.length}</span>
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
              style={{
                width: '100%',
                minHeight: 'var(--touch-target)',
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border)',
                marginBottom: 6,
              }}
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
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setAdding(true)}>
            <Plus size={16} />
            Add card
          </button>
        )}
      </div>
    </div>
  );
}
