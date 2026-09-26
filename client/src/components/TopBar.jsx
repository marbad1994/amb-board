import { NavLink } from 'react-router-dom';
import { LayoutGrid, StickyNote, User } from 'lucide-react';
import { useIdentity } from '../context/IdentityContext.jsx';

export default function TopBar() {
  const { name, setName } = useIdentity();

  return (
    <header className="topbar">
      <NavLink to="/" className="topbar__brand">
        <LayoutGrid size={20} />
        AMB Board
      </NavLink>
      <nav className="topbar__nav">
        <NavLink to="/" end title="Projects" className={({ isActive }) => (isActive ? 'active' : '')}>
          <LayoutGrid size={20} />
        </NavLink>
        <NavLink to="/ideas" title="Idea board" className={({ isActive }) => (isActive ? 'active' : '')}>
          <StickyNote size={20} />
        </NavLink>
      </nav>
      <button
        type="button"
        className="identity-pill"
        onClick={() => {
          const next = window.prompt('Your name', name);
          if (next && next.trim()) setName(next);
        }}
        title="Change name"
      >
        <User size={14} />
        <span>{name || 'You'}</span>
      </button>
    </header>
  );
}
