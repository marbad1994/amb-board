import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import ProjectDetailsModal from '../components/ProjectDetailsModal.jsx';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowLeft, Plus, Sparkles } from 'lucide-react';
import { api } from '../api/client.js';
import { useIdentity } from '../context/IdentityContext.jsx';
import Column from '../components/Column.jsx';
import CardItem from '../components/CardItem.jsx';
import CardModal from '../components/CardModal.jsx';
import AITaskModal from '../components/AITaskModal.jsx';
import CopyToWorkspace from '../components/CopyToWorkspace.jsx';

function findColumnOfCard(columns, cardId) {
  return columns.find((col) => col.cards.some((c) => c.id === cardId));
}

export default function BoardPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { name } = useIdentity();

  const [project, setProject] = useState(null);
  const [columns, setColumns] = useState(null);
  const [error, setError] = useState('');
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [activeCardId, setActiveCardId] = useState(null);
  const [activeColumnId, setActiveColumnId] = useState(null);
  const [searchParams] = useSearchParams();
  const { active } = useAuth();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [openCardId, setOpenCardId] = useState(searchParams.get('card'));
  const [aiHelperOpen, setAiHelperOpen] = useState(false);

  useEffect(() => {
    api.getProject(projectId).then(setProject).catch((err) => setError(err.message));
    api.listColumns(projectId).then(setColumns).catch((err) => setError(err.message));
    // Quick Add Task (in the shell) announces new data so an already-open board refreshes
    const reload = () => api.listColumns(projectId).then(setColumns).catch(() => {});
    window.addEventListener('amb:tasks-changed', reload);
    return () => window.removeEventListener('amb:tasks-changed', reload);
  }, [projectId]);

  // search results / task links deep-link to a card on the board that is already open
  const cardParam = searchParams.get('card');
  useEffect(() => {
    if (cardParam) setOpenCardId(cardParam);
  }, [cardParam]);

  // project progress is derived from task status, so refresh it when the card dialog closes
  const closeCard = () => {
    setOpenCardId(null);
    api.getProject(projectId).then(setProject).catch(() => {});
  };

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const activeCard = useMemo(() => {
    if (!activeCardId || !columns) return null;
    const col = findColumnOfCard(columns, activeCardId);
    return col?.cards.find((c) => c.id === activeCardId) || null;
  }, [activeCardId, columns]);

  const activeColumn = useMemo(
    () => columns?.find((c) => c.id === activeColumnId) || null,
    [activeColumnId, columns]
  );

  const handleDragStart = ({ active }) => {
    if (active.data.current?.type === 'column') {
      setActiveColumnId(active.id);
    } else {
      setActiveCardId(active.id);
    }
  };

  const saveColumnSettings = async (columnId, data) => {
    try {
      await api.updateColumn(columnId, data);
      setColumns(await api.listColumns(projectId));   // cards in the column may have taken its status
      api.getProject(projectId).then(setProject).catch(() => {});
      setError('');
    } catch (err) { setError(err.message); }
  };

  const handleDragOver = ({ active, over }) => {
    if (!over || active.data.current?.type !== 'card') return;
    const activeId = active.id;
    const overId = over.id;
    if (activeId === overId) return;

    setColumns((prev) => {
      const sourceCol = findColumnOfCard(prev, activeId);
      if (!sourceCol) return prev;

      let targetColId =
        over.data.current?.type === 'column' ? over.data.current.columnId ?? overId : null;
      if (!targetColId) {
        const targetCol = findColumnOfCard(prev, overId);
        targetColId = targetCol?.id;
      }
      if (!targetColId || sourceCol.id === targetColId) return prev;
      const target = prev.find((c) => c.id === targetColId);
      if (target?.card_limit != null && target.cards.length >= target.card_limit) return prev;   // full: the card cannot enter

      const card = sourceCol.cards.find((c) => c.id === activeId);
      const next = prev.map((col) => {
        if (col.id === sourceCol.id) {
          return { ...col, cards: col.cards.filter((c) => c.id !== activeId) };
        }
        if (col.id === targetColId) {
          const overIndex = col.cards.findIndex((c) => c.id === overId);
          const insertAt = overIndex >= 0 ? overIndex : col.cards.length;
          const cards = [...col.cards];
          cards.splice(insertAt, 0, { ...card, column_id: targetColId });
          return { ...col, cards };
        }
        return col;
      });
      return next;
    });
  };

  const handleDragEnd = ({ active, over }) => {
    const wasColumn = active.data.current?.type === 'column';
    setActiveCardId(null);
    setActiveColumnId(null);
    if (!over) return;

    if (wasColumn) {
      if (active.id === over.id) return;
      setColumns((prev) => {
        const oldIndex = prev.findIndex((c) => c.id === active.id);
        const newIndex = prev.findIndex((c) => c.id === over.id);
        if (oldIndex < 0 || newIndex < 0) return prev;
        const reordered = arrayMove(prev, oldIndex, newIndex);
        api.reorderColumns(projectId, reordered.map((c) => c.id)).catch((err) => setError(err.message));
        return reordered;
      });
      return;
    }

    setColumns((prev) => {
      const col = findColumnOfCard(prev, active.id);
      if (!col) return prev;
      const oldIndex = col.cards.findIndex((c) => c.id === active.id);
      let newIndex = col.cards.findIndex((c) => c.id === over.id);
      if (newIndex < 0) newIndex = col.cards.length - 1;
      const reorderedCards = oldIndex === newIndex ? col.cards : arrayMove(col.cards, oldIndex, newIndex);
      const next = prev.map((c) => (c.id === col.id ? { ...c, cards: reorderedCards } : c));

      api
        .moveCard(active.id, { columnId: col.id, order: reorderedCards.map((c) => c.id) })
        .then((moved) => {
          // the server may have changed the status because of the column; show it and refresh progress
          setColumns((cur) => cur.map((c) => ({ ...c, cards: c.cards.map((x) => (x.id === moved.id ? { ...x, status: moved.status, completed_at: moved.completed_at } : x)) })));
          api.getProject(projectId).then(setProject).catch(() => {});
        })
        .catch((err) => { setError(err.message); api.listColumns(projectId).then(setColumns).catch(() => {}); });   // refused (e.g. column full): put the card back

      return next;
    });
  };

  const addColumn = async (e) => {
    e.preventDefault();
    if (!newColumnName.trim()) return;
    try {
      const column = await api.createColumn(projectId, newColumnName.trim());
      setColumns((prev) => [...prev, column]);
      setNewColumnName('');
      setAddingColumn(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const renameColumn = async (columnId, newName) => {
    try {
      await api.renameColumn(columnId, newName);
      setColumns((prev) => prev.map((c) => (c.id === columnId ? { ...c, name: newName } : c)));
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteColumn = async (columnId) => {
    try {
      await api.deleteColumn(columnId);
      setColumns((prev) => prev.filter((c) => c.id !== columnId));
    } catch (err) {
      setError(err.message);
    }
  };

  const addCard = async (columnId, title) => {
    try {
      const card = await api.createCard(columnId, { title, creator: name, owner: name });
      setColumns((prev) =>
        prev.map((c) => (c.id === columnId ? { ...c, cards: [...c.cards, { ...card, commentCount: 0, attachmentCount: 0 }] } : c))
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const createCardFull = async ({ columnId, ...fields }) => {
    try {
      const card = await api.createCard(columnId, fields);
      setColumns((prev) =>
        prev.map((c) => (c.id === columnId ? { ...c, cards: [...c.cards, { ...card, commentCount: 0, attachmentCount: 0 }] } : c))
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCardChanged = (updatedCard) => {
    // a status change can move the card to another column on the server: reload when it is no longer where we show it
    const shown = columns?.find((col) => col.cards.some((c) => c.id === updatedCard.id));
    if (updatedCard.column_id && shown && shown.id !== updatedCard.column_id) api.listColumns(projectId).then(setColumns).catch(() => {});
    setColumns((prev) =>
      prev.map((col) => ({
        ...col,
        cards: col.cards.map((c) =>
          c.id === updatedCard.id
            ? {
                ...c,
                ...updatedCard,
                commentCount: updatedCard.comments?.length ?? c.commentCount,
                attachmentCount: updatedCard.attachments?.length ?? c.attachmentCount,
              }
            : c
        ),
      }))
    );
  };

  const handleCardDeleted = (cardId) => {
    setColumns((prev) => prev.map((col) => ({ ...col, cards: col.cards.filter((c) => c.id !== cardId) })));
  };

  if (error && !columns) {
    return (
      <div className="page">
        <p style={{ color: 'var(--color-danger)' }}>{error}</p>
      </div>
    );
  }

  return (
    <div className="main" style={{ minHeight: 0 }}>
      <div className="board-header">
        <button type="button" className="btn btn-icon btn-ghost" onClick={() => navigate('/projects')} title="Back" aria-label="Back to projects">
          <ArrowLeft size={18} />
        </button>
        <h2>{project?.name || 'Loading…'}</h2>
        {project && canWrite(active?.role) && (
          <button type="button" className="btn" onClick={async () => { try { const r = await api.createReport({ kind: 'project_status', project_id: projectId }); navigate(`/reports/${r.id}`); } catch (err) { setError(err.message); } }}>Report</button>
        )}
        {project && canWrite(active?.role) && <CopyToWorkspace entity="project" id={projectId} label={project.name} />}
        {project && (
          <button type="button" className="btn" onClick={() => setDetailsOpen(true)}>
            Details · {project.progress}%
          </button>
        )}
        {columns && columns.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setAiHelperOpen(true)}
            title="AI task helper"
          >
            <Sparkles size={16} />
            AI task
          </button>
        )}
      </div>

      {columns === null ? (
        <div className="loading-screen">Loading board…</div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="board">
            <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
              {columns.map((column) => (
                <Column
                  key={column.id}
                  column={column}
                  onOpenCard={(card) => setOpenCardId(card.id)}
                  onAddCard={addCard}
                  onRename={renameColumn}
                  onDelete={deleteColumn}
                  onSettings={saveColumnSettings}
                  writable={canWrite(active?.role)}
                />
              ))}
            </SortableContext>

            <div className="add-column">
              <div className="add-column__inner">
                {addingColumn ? (
                  <form onSubmit={addColumn}>
                    <input
                      type="text"
                      autoFocus
                      placeholder="Column name"
                      value={newColumnName}
                      onChange={(e) => setNewColumnName(e.target.value)}
                      style={{ marginBottom: 8 }}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="submit" className="btn btn-primary" disabled={!newColumnName.trim()}>
                        Add
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setAddingColumn(false)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <button type="button" className="btn btn-ghost btn-block" onClick={() => setAddingColumn(true)}>
                    <Plus size={16} />
                    Add column
                  </button>
                )}
              </div>
            </div>
          </div>

          <DragOverlay>
            {activeCard && <CardItem card={activeCard} onOpen={() => {}} />}
            {activeColumn && (
              <div className="column">
                <div className="column__header">
                  <span className="column__title">{activeColumn.name}</span>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {detailsOpen && project && (
        <ProjectDetailsModal project={project} writable={canWrite(active?.role)} onClose={() => setDetailsOpen(false)} onSaved={setProject} />
      )}

      {openCardId && (
        <CardModal
          cardId={openCardId}
          onClose={closeCard}
          onChanged={handleCardChanged}
          onDeleted={handleCardDeleted}
        />
      )}

      {aiHelperOpen && columns && (
        <AITaskModal
          projectId={projectId}
          columns={columns.map((c) => ({ id: c.id, name: c.name }))}
          defaultName={name}
          onClose={() => setAiHelperOpen(false)}
          onCreate={createCardFull}
        />
      )}
    </div>
  );
}
