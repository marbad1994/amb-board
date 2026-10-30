import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, FolderPlus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useIdentity } from '../context/IdentityContext.jsx';
import DictationButton from '../components/DictationButton.jsx';

const COLORS = ['#fde68a', '#fca5a5', '#a7f3d0', '#93c5fd', '#ddd6fe', '#fbcfe8'];

export default function IdeaBoardPage() {
  const { name } = useIdentity();
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const saveTimers = useRef({});

  useEffect(() => {
    api.listIdeas().then(setNotes).catch((err) => setError(err.message));
  }, []);

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
    <div className="page">
      <div className="page-header">
        <h1>Idea board</h1>
      </div>
      <p style={{ color: 'var(--color-text-muted)', marginTop: -8, fontSize: 13 }}>
        Loose thoughts and ideas from everyone. Speak in English, Romanian or Swedish — notes are saved in English.
      </p>

      {error && <p style={{ color: 'var(--color-danger)' }}>{error}</p>}

      {notes === null && <p>Loading…</p>}

      {notes && notes.length === 0 && <div className="empty-state">No ideas yet. Tap + to add one.</div>}

      {notes && notes.length > 0 && (
        <div className="postit-grid">
          {notes.map((note) => (
            <div key={note.id} className="postit" style={{ background: note.color }}>
              <button
                type="button"
                className="postit__delete"
                onClick={() => deleteNote(note.id)}
                title="Delete note"
              >
                <Trash2 size={14} />
              </button>
              <div className="postit__row">
                <textarea
                  value={note.text}
                  placeholder="Type or dictate an idea…"
                  onChange={(e) => updateLocalText(note.id, e.target.value)}
                />
                <DictationButton
                  onText={(text) => updateLocalText(note.id, `${note.text ? note.text + ' ' : ''}${text}`)}
                />
              </div>
              <div className="postit__footer">
                <span className="postit__author">{note.author || 'Anonymous'}</span>
                {note.converted_project_id ? (
                  <Link className="postit__convert" to={`/projects/${note.converted_project_id}`}>Project created</Link>
                ) : (
                  <button type="button" className="postit__convert" onClick={() => convert(note)} disabled={!note.text.trim()}
                    aria-label="Convert idea to project"><FolderPlus size={14} aria-hidden="true" /> To project</button>
                )}
                <div className="color-swatches">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`color-swatch ${note.color === c ? 'is-active' : ''}`}
                      style={{ background: c }}
                      onClick={() => updateColor(note.id, c)}
                      title="Change color"
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button type="button" className="idea-board__fab" onClick={addNote} title="Add idea">
        <Plus size={24} />
      </button>
    </div>
  );
}
