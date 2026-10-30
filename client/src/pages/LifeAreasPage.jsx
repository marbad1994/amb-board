import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Archive, ArchiveRestore, Check, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth, canManage } from '../context/AuthContext.jsx';
import { LifeAreaIcon } from '../lib/lifeAreaIcons.jsx';

function AreaCard({ area, manage, onChange, onError }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: area.name, description: area.description });
  const [sub, setSub] = useState('');
  const [subOpen, setSubOpen] = useState(false);
  const archived = !!area.archived_at;

  const run = async (fn) => {
    try {
      onChange(await fn());
    } catch (err) {
      onError(err.message);
    }
  };

  const save = () => run(async () => {
    const updated = await api.updateLifeArea(area.id, draft);
    setEditing(false);
    return updated;
  });

  const addSub = (e) => {
    e.preventDefault();
    if (!sub.trim()) return;
    run(async () => {
      await api.addSubcategory(area.id, sub.trim());
      setSub('');
      return (await api.listLifeAreas(true)).find((a) => a.id === area.id);
    });
  };

  return (
    <article className={`area-card ${archived ? 'area-card--archived' : ''}`}>
      <div className="area-card__head">
        <span className="area-card__icon"><LifeAreaIcon name={area.icon} /></span>
        {editing ? (
          <input type="text" aria-label="Life area name" value={draft.name} maxLength={80}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        ) : (
          <h3>{area.name}</h3>
        )}
        {manage && (
          <div className="area-card__actions">
            {editing ? (
              <>
                <button type="button" className="btn btn-icon btn-ghost" onClick={save} aria-label="Save"><Check size={16} /></button>
                <button type="button" className="btn btn-icon btn-ghost" onClick={() => setEditing(false)} aria-label="Cancel"><X size={16} /></button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-icon btn-ghost" onClick={() => setEditing(true)} aria-label={`Edit ${area.name}`}><Pencil size={16} /></button>
                <button type="button" className="btn btn-icon btn-ghost"
                  onClick={() => run(() => api.updateLifeArea(area.id, { archived: !archived }))}
                  aria-label={archived ? `Restore ${area.name}` : `Archive ${area.name}`}>
                  {archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <textarea aria-label="Description" rows={3} maxLength={1000} value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      ) : (
        <p className="area-card__desc">{area.description || 'No description.'}</p>
      )}
      {area.subcategories.length > 0 && (
        <ul className="chips">
          {area.subcategories.map((s) => (
            <li key={s.id}>{s.name}
              {manage && (
                <button type="button" aria-label={`Remove ${s.name}`}
                  onClick={() => run(async () => {
                    await api.removeSubcategory(area.id, s.id);
                    return (await api.listLifeAreas(true)).find((a) => a.id === area.id);
                  })}><X size={12} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && !archived && !subOpen && <button type="button" className="btn btn-ghost btn-small" onClick={() => setSubOpen(true)}><Plus size={14} aria-hidden="true" /> Add subcategory</button>}
      {manage && !archived && subOpen && (
        <form className="inline-form inline-form--nowrap" onSubmit={(e) => { addSub(e); setSubOpen(false); }}>
          <input type="text" autoFocus aria-label={`Add subcategory to ${area.name}`} placeholder="Subcategory name" maxLength={80}
            value={sub} onChange={(e) => setSub(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSubOpen(false)} />
          <button type="submit" className="btn btn-icon" aria-label="Add subcategory" disabled={!sub.trim()}><Plus size={16} /></button>
        </form>
      )}
      <div className="area-card__foot">
        <Link to={`/projects?lifeArea=${area.id}`}>{area.project_count} {area.project_count === 1 ? 'project' : 'projects'}</Link>
        {archived && <span className="role-tag">Archived</span>}
      </div>
    </article>
  );
}

export default function LifeAreasPage() {
  const { active } = useAuth();
  const manage = canManage(active?.role);
  const [areas, setAreas] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.listLifeAreas(showArchived).then(setAreas).catch((err) => setError(err.message));
  }, [showArchived]);

  const replace = (updated) => {
    if (!updated) return;
    setAreas((prev) => prev.flatMap((a) => (a.id !== updated.id ? [a] : (updated.archived_at && !showArchived ? [] : [updated]))));
  };

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const created = await api.createLifeArea({ name: name.trim() });
      setAreas((prev) => [...prev, created]);
      setName('');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">LIFE FRAMEWORK</div>
          <h1>Life Areas</h1>
          <p className="page-sub">Broad domains of your life that group related projects. Rename, add or archive them to fit you.</p>
        </div>
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>

      {manage && (
        <form className="inline-form inline-form--wide" onSubmit={create}>
          <input type="text" aria-label="New life area name" placeholder="New life area" maxLength={80} value={name}
            onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}><Plus size={16} /> Add</button>
        </form>
      )}
      {!manage && <p className="muted">Only owners and admins can change life areas.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!areas && !error && <p>Loading…</p>}
      {areas && (
        <div className="area-grid">
          {areas.map((a) => <AreaCard key={a.id} area={a} manage={manage} onChange={replace} onError={setError} />)}
        </div>
      )}
    </div>
  );
}
