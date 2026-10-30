import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, Sparkles, X } from 'lucide-react';
import { CATALOG, StepIcon, newStep, KIND } from './stepMeta.jsx';

// "Add a step": pick by what it does. `suggest` is an optional { item, why } built from the data the earlier steps produced.
export default function Picker({ title, taskTrigger, hasServers, hasSkills, insideLoop, suggest, onPick, onClose }) {
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [onClose]);
  const groups = useMemo(() => CATALOG.map((g) => ({
    ...g,
    items: g.items.filter((it) => (!it.needs || (it.needs === 'taskTrigger' ? taskTrigger : it.needs === 'skills' ? hasSkills : hasServers)) && !(insideLoop && it.noLoop)
      && (!q.trim() || `${it.name} ${it.desc} ${g.group}`.toLowerCase().includes(q.trim().toLowerCase()))),
  })).filter((g) => g.items.length), [q, taskTrigger, hasServers, hasSkills, insideLoop]);
  return (
    <div className="ab-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ab-dialog" role="dialog" aria-modal="true" aria-label="Add a step">
        <div className="ab-dialog__head">
          <div><h2>{title || 'Add a step'}</h2><p className="muted">Pick by what you want to happen. You can test every step before saving.</p></div>
          <button type="button" className="ab-x" onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button>
        </div>
        <label className="ab-search"><Search size={18} aria-hidden="true" /><input ref={ref} type="search" aria-label="Search steps" placeholder="Search steps, for example email, scrape, loop" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        {suggest && !q && (
          <div className="ab-suggest"><Sparkles size={18} aria-hidden="true" /><p><b>Suggested next:</b> {suggest.why}</p><button type="button" className="ab-btn ab-btn--primary" onClick={() => onPick(newStep(suggest.item, suggest.over))}>Add this step</button></div>
        )}
        <div className="ab-dialog__body">
          {groups.map((g) => (
            <section key={g.group} aria-label={g.group}>
              <h3>{g.group} <span>{g.hint}</span></h3>
              <div className="ab-opts">
                {g.items.map((it) => (
                  <button key={it.name} type="button" className="ab-opt" onClick={() => onPick(newStep(it))}>
                    <StepIcon type={it.preset?.tool === 'web_search' ? 'web_search' : it.type} size={18} />
                    <span><b>{it.name}</b><span className="d">{it.desc}</span>{it.gives && <span className="r">{it.gives}</span>}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {groups.length === 0 && <p className="muted">No step matches "{q}".</p>}
        </div>
        <p className="ab-dialog__foot"><Plus size={14} aria-hidden="true" /> Most flows follow the same shape: get data, shape it, then do something with it.</p>
      </div>
    </div>
  );
}
export { KIND };
