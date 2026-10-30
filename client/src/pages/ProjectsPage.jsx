import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Folder, Archive, ArchiveRestore } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canWrite } from '../context/AuthContext.jsx';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6'];

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

  const setFilter = (value) => setParams(value ? { lifeArea: value } : {});

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">LIFE MANAGEMENT</div>
          <h1>Projects Board</h1>
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
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {projects === null && !error && <p>Loading…</p>}

      {projects && projects.length === 0 && (
        <div className="empty-state">
          <Folder size={32} />
          <p>{showArchived ? 'No archived projects.' : 'No projects here yet.'}</p>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="project-grid">
          {projects.map((project) => (
            <div key={project.id} style={{ position: 'relative' }}>
              <Link to={`/projects/${project.id}`} className="project-card" style={{ borderLeftColor: project.color }}>
                <h3>{project.name}</h3>
                <p>{project.life_area_name || 'No life area'} · {project.card_count} {project.card_count === 1 ? 'task' : 'tasks'}</p>
              </Link>
              {writable && (
                <div className="project-card__actions">
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
          ))}
        </div>
      )}
    </div>
  );
}
