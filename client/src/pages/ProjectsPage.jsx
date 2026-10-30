import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Folder, Archive, ArchiveRestore, ArrowRight } from 'lucide-react';
import { DndContext, MouseSensor, TouchSensor, useSensor, useSensors, useDraggable, useDroppable, pointerWithin } from '@dnd-kit/core';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import { PROJECT_STATUSES, priorityLabel, formatDate } from '../lib/labels.js';
import CopyToWorkspace from '../components/CopyToWorkspace.jsx';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6'];

function StatusColumn({ status, count, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: status.value });
  return (
    <section ref={setNodeRef} className={`status-col ${isOver ? 'is-over' : ''}`} aria-label={status.label}>
      <h2>{status.label}<span>{count}</span></h2>
      {children}
    </section>
  );
}
function DraggableProject({ id, enabled, children }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id, disabled: !enabled });
  return <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'is-dragging' : ''} style={{ touchAction: 'manipulation' }}>{children}</div>;
}

export default function ProjectsPage() {
  const { active } = useAuth();
  const writable = canWrite(active?.role);
  const [params, setParams] = useSearchParams();
  const lifeArea = params.get('lifeArea') || '';
  const [showArchived, setShowArchived] = useState(false);
  const [projects, setProjects] = useState(null);
  const [areas, setAreas] = useState([]);
  const [name, setName] = useState('');
  const [newArea, setNewArea] = useState('');
  const [error, setError] = useState('');
  const [view, setView] = useState('grid');
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));
  const onDragEnd = ({ active, over }) => {
    const project = projects?.find((p) => p.id === active.id);
    if (project && over && PROJECT_STATUSES.some((s) => s.value === over.id) && over.id !== project.status) setStatus(project, over.id);
  };

  useEffect(() => {
    api.listLifeAreas().then(setAreas).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setProjects(null);
    api.listProjects({ archived: showArchived, lifeArea }).then(setProjects).catch((err) => setError(err.message));
  }, [showArchived, lifeArea]);

  const createProject = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const project = await api.createProject(name.trim(), color, newArea || lifeArea || null);
      if (!showArchived && (!lifeArea || project.life_area_id === lifeArea)) setProjects((prev) => [...(prev || []), project]);
      setName('');
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteProject = async (id) => {
    if (!window.confirm('Delete this project and all its columns and cards? This cannot be undone. Archiving keeps your data.')) return;
    try {
      await api.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleArchive = async (project) => {
    try {
      await api.updateProject(project.id, { archived: !project.archived_at });
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
    } catch (err) {
      setError(err.message);
    }
  };

  const setStatus = async (project, status) => {
    try {
      const updated = await api.updateProject(project.id, { status });
      setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)));
    } catch (err) {
      setError(err.message);
    }
  };

  const setFilter = (value) => setParams(value ? { lifeArea: value } : {});

  const renderCard = (project, withStatus) => (
    <div key={project.id} style={{ position: 'relative' }}>
      <Link to={`/projects/${project.id}`} className="project-card" style={{ borderLeftColor: project.color }}>
        <h3>{project.name}</h3>
        <p>{project.life_area_name || 'No life area'} · {project.card_count} {project.card_count === 1 ? 'task' : 'tasks'} · {project.progress}% complete</p>
        <div className="progress" role="progressbar" aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${project.name} progress`}>
          <div style={{ width: `${project.progress}%` }} />
        </div>
        <div className="project-card__meta">
          <span className={`prio prio--${project.priority}`}>{priorityLabel(project.priority)}</span>
          {project.target_date && <span>Due {formatDate(project.target_date)}</span>}
          {project.overdue_count > 0 && <span className="prio prio--urgent">{project.overdue_count} overdue</span>}
          <span className="project-card__open">Open board <ArrowRight size={14} aria-hidden="true" /></span>
        </div>
      </Link>
      {writable && withStatus && !showArchived && (
        <select className="project-card__status" aria-label={`Status of ${project.name}`} value={project.status}
          onChange={(e) => setStatus(project, e.target.value)}>
          {PROJECT_STATUSES.map((st) => <option key={st.value} value={st.value}>{st.label}</option>)}
        </select>
      )}
      {writable && (
        <div className="project-card__actions">
          <CopyToWorkspace entity="project" id={project.id} label={project.name} className="btn btn-icon btn-ghost" iconOnly />
          <button type="button" className="btn btn-icon btn-ghost" onClick={() => toggleArchive(project)}
            title={project.archived_at ? 'Restore project' : 'Archive project'}
            aria-label={project.archived_at ? `Restore ${project.name}` : `Archive ${project.name}`}>
            {project.archived_at ? <ArchiveRestore size={16} /> : <Archive size={16} />}
          </button>
          <button type="button" className="btn btn-icon btn-ghost" onClick={() => deleteProject(project.id)}
            title="Delete project" aria-label={`Delete ${project.name}`}>
            <Trash2 size={16} color="var(--color-danger)" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">LIFE MANAGEMENT</div>
          <h1>Projects</h1>
          <p className="page-sub">Each project has its own board of tasks. Open a project to drag its tasks between columns.</p>
        </div>
      </div>

      {writable && !showArchived && (
        <form onSubmit={createProject} className="inline-form inline-form--wide" style={{ marginBottom: 12 }}>
          <input type="text" aria-label="New project name" placeholder="New project name" value={name}
            onChange={(e) => setName(e.target.value)} maxLength={120} />
          <select aria-label="Life area for new project" value={newArea || lifeArea} onChange={(e) => setNewArea(e.target.value)}>
            <option value="">No life area</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            <Plus size={18} /> Add
          </button>
        </form>
      )}

      <div className="filter-row">
        <label>Life area
          <select aria-label="Filter by life area" value={lifeArea} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>All projects</button>
          <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>By status</button>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {projects === null && !error && <p>Loading…</p>}

      {projects && projects.length === 0 && (
        <div className="empty-state">
          <Folder size={32} />
          <p>{showArchived ? 'No archived projects.' : 'No projects here yet.'}</p>
        </div>
      )}

      {projects && projects.length > 0 && view === 'grid' && (
        <div className="project-grid">
          {projects.map((project) => renderCard(project, false))}
        </div>
      )}

      {projects && projects.length > 0 && view === 'board' && (
        <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
          <p className="hint">Drag a project to another column to change its status. To work on its tasks, open the project.</p>
          <div className="status-board">
            {PROJECT_STATUSES.map((st) => {
              const items = projects.filter((p) => p.status === st.value);
              return (
                <StatusColumn key={st.value} status={st} count={items.length}>
                  {items.map((project) => <DraggableProject key={project.id} id={project.id} enabled={writable && !showArchived}>{renderCard(project, true)}</DraggableProject>)}
                </StatusColumn>
              );
            })}
          </div>
        </DndContext>
      )}
    </div>
  );
}
