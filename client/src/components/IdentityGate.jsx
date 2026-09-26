import { useState } from 'react';
import { useIdentity } from '../context/IdentityContext.jsx';

export default function IdentityGate({ children }) {
  const { name, setName } = useIdentity();
  const [draft, setDraft] = useState('');

  if (name) return children;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="identity-modal">
          <h2>Welcome</h2>
          <p>What should we call you? This name is used as the owner/creator on cards and notes.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) setName(draft);
            }}
          >
            <div className="field">
              <label htmlFor="identity-name">Your name</label>
              <input
                id="identity-name"
                type="text"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. Marcus"
              />
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={!draft.trim()}>
              Continue
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
