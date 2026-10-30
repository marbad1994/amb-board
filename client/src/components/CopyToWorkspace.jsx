import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

const SKIPPED = { attachments: 'attachments', linked_projects: 'links to projects', links_to_project_or_goal: 'links to a project or goal' };

// Button + dialog: copy a project, goal, note or idea into another workspace the person belongs to (with write access).
// The original stays where it is.
export default function CopyToWorkspace({ entity, id, label, className = 'btn', iconOnly = false }) {
  const { workspaces, active } = useAuth();
  const targets = workspaces.filter((w) => w.id !== active?.id && ['owner', 'admin', 'member'].includes(w.role));
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  const go = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { setDone(await api.copyToWorkspace({ entity, id, target_workspace_id: target })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const close = () => { setOpen(false); setDone(null); setError(''); setTarget(''); };
  const skipped = done ? Object.entries(done.skipped || {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${SKIPPED[k] || k}`) : [];

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-label={`Copy ${label} to another workspace`} title="Copy to another workspace">
        <Copy size={16} aria-hidden="true" />{!iconOnly && ' Copy to...'}
      </button>
      {open && (
        <div className="modal-overlay" onClick={close}>
          <form className="modal modal--small" role="dialog" aria-modal="true" aria-label="Copy to another workspace" onClick={(e) => e.stopPropagation()} onSubmit={go}>
            <div className="modal__header"><h2>Copy to another workspace</h2><button type="button" className="btn btn-icon btn-ghost" onClick={close} aria-label="Close"><X size={18} /></button></div>
            <div className="modal__body">
              {done ? (
                <>
                  <p>Copied "{done.name}" to <b>{done.target.name}</b>. The original is unchanged.</p>
                  {Object.keys(done.copied).length > 0 && <p className="hint">Copied: {Object.entries(done.copied).map(([k, n]) => `${n} ${k}`).join(', ')}.</p>}
                  {skipped.length > 0 && <p className="hint">Not copied: {skipped.join(', ')}.</p>}
                  <div className="inline-form"><button type="button" className="btn btn-primary" onClick={close}>Done</button></div>
                </>
              ) : targets.length === 0 ? (
                <p className="muted">You have no other workspace you can write to. Create or join a shared workspace under Workspace &amp; account first.</p>
              ) : (
                <>
                  <p className="hint">Makes an independent copy in the workspace you choose. Attachments, budgets and links to other records are not copied; journal entries never are.</p>
                  <label className="field"><span className="field__label">Copy "{label}" to</span>
                    <select value={target} onChange={(e) => setTarget(e.target.value)} required>
                      <option value="">Choose a workspace</option>
                      {targets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select></label>
                  {error && <p className="form-error" role="alert">{error}</p>}
                  <div className="inline-form"><button type="submit" className="btn btn-primary" disabled={!target || busy}>Copy</button><button type="button" className="btn" onClick={close}>Cancel</button></div>
                </>
              )}
              {done && <p className="hint">Switch workspace in the sidebar to see it{done.link ? <> (<Link to={done.link} onClick={close}>open here after switching</Link>)</> : null}.</p>}
            </div>
          </form>
        </div>
      )}
    </>
  );
}
