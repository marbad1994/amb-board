import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api } from '../api/client.js';

export default function SearchBox() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const navigate = useNavigate();
  const loc = useLocation();
  // a search belongs to the page it was typed on
  useEffect(() => { setQ(''); setResults(null); setOpen(false); }, [loc.pathname]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return undefined;
    let stale = false;
    const t = setTimeout(() => {
      api.search(term).then((r) => { if (!stale) { setResults(r); setOpen(true); } }).catch(() => {});
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);

  useEffect(() => {
    const close = (e) => (e.type === 'keydown' ? e.key === 'Escape' : !wrap.current?.contains(e.target)) && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, []);

  const go = (path) => { setOpen(false); setQ(''); setResults(null); navigate(path); };
  const visible = open && q.trim().length >= 2 && results;
  const total = results ? results.projects.length + results.tasks.length + results.ideas.length : 0;

  return (
    <div className="search" ref={wrap}>
      <Search size={16} aria-hidden="true" />
      <input type="search" aria-label="Search projects, tasks and ideas" placeholder="Search projects, tasks, ideas..."
        value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => results && setOpen(true)} />
      {visible && (
        <div className="search__results" role="region" aria-label="Search results">
          {total === 0 && <p className="muted">No matches.</p>}
          {results.projects.length > 0 && <h3>Projects</h3>}
          {results.projects.map((p) => <button key={p.id} type="button" onClick={() => go(`/projects/${p.id}`)}>{p.name}</button>)}
          {results.tasks.length > 0 && <h3>Tasks</h3>}
          {results.tasks.map((t) => (
            <button key={t.id} type="button" onClick={() => go(`/projects/${t.project_id}?card=${t.id}`)}>{t.title}<small>{t.project_name}</small></button>
          ))}
          {results.ideas.length > 0 && <h3>Ideas</h3>}
          {results.ideas.map((i) => <button key={i.id} type="button" onClick={() => go('/ideas')}>{i.text.slice(0, 80)}</button>)}
        </div>
      )}
    </div>
  );
}
