import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MessageSquare, Paperclip, User } from 'lucide-react';
import { labelColor } from '../utils/labelColor.js';

const STATUS_LABEL = {
  todo: 'To do',
  doing: 'Doing',
  blocked: 'Blocked',
  done: 'Done',
};

export default function CardItem({ card, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card', columnId: card.column_id },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`card ${isDragging ? 'is-dragging' : ''}`}
      onClick={() => !isDragging && onOpen(card)}
    >
      <p className="card__title">{card.title}</p>
      {card.labels?.length > 0 && (
        <div className="card__labels">
          {card.labels.map((label) => (
            <span key={label} className="label-chip label-chip--sm" style={{ background: labelColor(label) }}>
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="card__meta">
        <span className={`badge status-${card.status}`}>{STATUS_LABEL[card.status] || card.status}</span>
        {card.owner && (
          <span className="card__owner">
            <User size={12} />
            {card.owner}
          </span>
        )}
        <span className="card__icons">
          {card.commentCount > 0 && (
            <span>
              <MessageSquare size={12} />
              {card.commentCount}
            </span>
          )}
          {card.attachmentCount > 0 && (
            <span>
              <Paperclip size={12} />
              {card.attachmentCount}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
