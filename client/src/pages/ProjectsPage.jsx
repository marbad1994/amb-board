import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, Folder } from 'lucide-react';
import { api } from '../api/client.js';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6'];

export default function ProjectsPage() {
  const [projects, setProjects] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.listProjects().then(setProjects).catch((err) => setError(err.message));
  }, []);

  const createProject = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const project = await api.createProject(name.trim(), color);
      setProjects((prev) => [...(prev || []), project]);
      setName('');
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteProject = async (id) => {
    if (!window.confirm('Delete this project and all its columns and cards?')) return;
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Projects</h1>
      </div>

      <form onSubmit={createProject} className="field-with-mic" style={{ marginBottom: 20 }}>
        <div className="field-with-mic__row">
          <input
            type="text"
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              flex: 1,
              minHeight: 'var(--touch-target)',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface)',
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            <Plus size={18} />
            Add
          </button>
        </div>
      </form>

      {error && <p style={{ color: 'var(--color-danger)' }}>{error}</p>}

      {projects === null && <p>Loading…</p>}

      {projects && projects.length === 0 && (
        <div className="empty-state">
          <Folder size={32} />
          <p>No projects yet. Create your first one above.</p>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="project-grid">
          {projects.map((project) => (
            <div key={project.id} style={{ position: 'relative' }}>
              <Link
                to={`/projects/${project.id}`}
                className="project-card"
                style={{ borderLeftColor: project.color }}
              >
                <h3>{project.name}</h3>
                <p>Created {new Date(project.created_at).toLocaleDateString()}</p>
              </Link>
              <button
                type="button"
                className="btn btn-icon btn-ghost project-card__delete"
                onClick={() => deleteProject(project.id)}
                title="Delete project"
              >
                <Trash2 size={16} color="var(--color-danger)" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
