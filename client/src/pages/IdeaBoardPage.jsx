import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, Trash2, FolderPlus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useIdentity } from '../context/IdentityContext.jsx';
import DictationButton from '../components/DictationButton.jsx';
import CopyToWorkspace from '../components/CopyToWorkspace.jsx';

const COLORS = ['#fde68a', '#fca5a5', '#a7f3d0', '#93c5fd', '#ddd6fe', '#fbcfe8'];
const COLOR_NAMES = { '#fde68a': 'Yellow', '#fca5a5': 'Red', '#a7f3d0': 'Green', '#93c5fd': 'Blue', '#ddd6fe': 'Violet', '#fbcfe8': 'Pink' };

const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const shortDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };

// A textarea that grows with its text, so a whole idea is always readable without an inner scrollbar.
function AutoTextarea({ value, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const fit = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
    fit();
    const box = el.parentElement; let width = box.clientWidth;
    const watch = new ResizeObserver(() => { if (box.clientWidth !== width) { width = box.clientWidth; fit(); } });
    watch.observe(box);
    return () => watch.disconnect();
  }, [value]);
  return <textarea ref={ref} rows={3} value={value} {...props} />;
}

export default function IdeaBoardPage() {
  const { name } = useIdentity();
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const saveTimers = useRef({});

  useEffect(() => {
    api.listIdeas().then(setNotes).catch((err) => setError(err.message));
  }, []);

  const [quick, setQuick] = useState('');
  const addQuick = async (e) => {
    e.preventDefault();
    const text = quick.trim(); if (!text) return;
    try {
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const note = await api.createIdea({ author: name, text, color });
      setNotes((prev) => [note, ...(prev || [])]); setQuick('');
    } catch (err) { setError(err.message); }
  };

  const addNote = async () => {
    try {
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const note = await api.createIdea({ author: name, text: '', color });
      setNotes((prev) => [note, ...(prev || [])]);
    } catch (err) {
      setError(err.message);
    }
  };

  const convert = async (note) => {
    if (!note.text.trim()) return;
    if (!window.confirm('Create a project from this idea? The idea stays on the board, linked to the project.')) return;
    try {
      const { projectId } = await api.convertIdea(note.id);
      navigate(`/projects/${projectId}`);
    } catch (err) {
      setError(err.message);
    }
  };

  const updateLocalText = (id, text) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text } : n)));
    clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(() => {
      api.updateIdea(id, { text }).catch((err) => setError(err.message));
    }, 500);
  };

  const updateColor = async (id, color) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, color } : n)));
    try {
      await api.updateIdea(id, { color });
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteNote = async (id) => {
    if (!window.confirm('Delete this note?')) return;
    setNotes((prev) => prev.filter((n) => n.id !== id));
    try {
      await api.deleteIdea(id);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="page page--wide">
      <div className="page-header">
        <div>
          <div className="eyebrow">LOOSE THOUGHTS</div>
          <h1>Idea board</h1>
          <p className="page-sub">Quick notes from everyone. Speak in English, Romanian or Swedish; notes are saved in English. Turn a good one into a project with "To project".</p>
        </div>
      </div>

      {error && <p style={{ color: 'var(--color-danger-text)' }}>{error}</p>}
      <form className="idea-quick" onSubmit={addQuick} aria-label="Quick add idea">
        <input type="text" aria-label="Quick add idea" placeholder="Type an idea and press Enter" maxLength={2000} value={quick} onChange={(e) => setQuick(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={!quick.trim()}><Plus size={16} aria-hidden="true" /> Add idea</button>
      </form>

      {notes === null && <p>Loading…</p>}

      {notes && notes.length === 0 && <div className="empty-state">No ideas yet. Type one above and press Enter.</div>}

      {notes && notes.length > 0 && (
        <div className="idea-grid">
          {notes.map((note) => (
            <article key={note.id} className="idea" style={{ '--note': note.color }}>
              <header className="idea__head">
                <span className="idea__who">
                  <span className="idea__avatar" aria-hidden="true">{initials(note.author)}</span>
                  <span className="idea__name">{note.author || 'Anonymous'}</span>
                  {shortDate(note.created_at) && <time className="idea__date" dateTime={note.created_at}>{shortDate(note.created_at)}</time>}
                </span>
                <button type="button" className="idea__icon idea__delete" onClick={() => deleteNote(note.id)} title="Delete idea" aria-label="Delete idea">
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </header>
              <div className="idea__body">
                <AutoTextarea
                  className="idea__text"
                  value={note.text}
                  aria-label="Idea"
                  placeholder="Type or dictate an idea…"
                  onChange={(e) => updateLocalText(note.id, e.target.value)}
                />
              </div>
              <footer className="idea__foot">
                <div className="idea__actions">
                  {note.converted_project_id ? (
                    <Link className="idea__btn" to={`/projects/${note.converted_project_id}`}><FolderPlus size={16} aria-hidden="true" /> Project created</Link>
                  ) : (
                    <button type="button" className="idea__btn" onClick={() => convert(note)} disabled={!note.text.trim()} aria-label="Convert idea to project">
                      <FolderPlus size={16} aria-hidden="true" /> To project
                    </button>
                  )}
                  {note.text.trim() && <CopyToWorkspace entity="idea" id={note.id} label="idea" className="idea__icon" iconOnly />}
                  <DictationButton
                    className="idea__mic"
                    onText={(text) => updateLocalText(note.id, `${note.text ? note.text + ' ' : ''}${text}`)}
                  />
                </div>
                <div className="idea__swatches" role="group" aria-label="Idea color">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`idea__swatch ${note.color === c ? 'is-active' : ''}`}
                      style={{ background: c }}
                      aria-pressed={note.color === c}
                      aria-label={COLOR_NAMES[c]}
                      title={COLOR_NAMES[c]}
                      onClick={() => updateColor(note.id, c)}
                    />
                  ))}
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}

      <button type="button" className="idea-board__fab" onClick={addNote} title="Add idea" aria-label="Add idea">
        <Plus size={24} />
      </button>
    </div>
  );
}
