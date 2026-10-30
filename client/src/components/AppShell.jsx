import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Layers, FolderKanban, StickyNote, Settings, Sun, ListChecks, Calendar, Landmark,
  NotebookPen, Sparkles, Menu, LogOut, ChevronDown, X, Check, Plus, Target, FileText, BarChart3,
  Workflow,
} from 'lucide-react';
import { useAuth, canWrite } from '../context/AuthContext.jsx';
import SearchBox from './SearchBox.jsx';
import QuickAddTask from './QuickAddTask.jsx';
import NotificationBell from './NotificationBell.jsx';
import AssistantDock from './AssistantDock.jsx';

const NAV = [
  { label: 'Overview', items: [
    { to: '/', icon: LayoutDashboard, text: 'Dashboard', end: true },
    { to: '/my-day', icon: Sun, text: 'My Day' },
    { to: '/life-areas', icon: Layers, text: 'Life Areas' },
  ] },
  { label: 'Manage', items: [
    { to: '/projects', icon: FolderKanban, text: 'Projects' },
    { to: '/tasks', icon: ListChecks, text: 'Tasks' },
    { to: '/goals', icon: Target, text: 'Goals & Habits' },
    { to: '/ideas', icon: StickyNote, text: 'Idea Board' },
    { to: '/calendar', icon: Calendar, text: 'Calendar' },
    { to: '/automations', icon: Workflow, text: 'Automations' },
  ] },
  { label: 'Personal', items: [
    { to: '/finance', icon: Landmark, text: 'Finance & Budget' },
    { to: '/notes', icon: NotebookPen, text: 'Notes & Journal' },
    { to: '/documents', icon: FileText, text: 'Documents' },
    { to: '/reports', icon: BarChart3, text: 'Reports' },
    { to: '/assistant', icon: Sparkles, text: 'AI Assistant' },
  ] },
  { label: 'System', items: [
    { to: '/settings', icon: Settings, text: 'Workspace' },
  ] },
];

export default function AppShell({ children }) {
  const { user, workspaces, active, setActiveWorkspace, logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [quickAdd, setQuickAdd] = useState(false);
  const [prefill, setPrefill] = useState(null);
  useEffect(() => {
    const h = (e) => { setPrefill(e.detail || null); setQuickAdd(true); };
    window.addEventListener('amb:quick-add', h);
    return () => window.removeEventListener('amb:quick-add', h);
  }, []);
  const wsRef = useRef(null);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    if (!wsOpen) return undefined;
    const close = (e) => {
      if (e.type === 'keydown' ? e.key === 'Escape' : !wsRef.current?.contains(e.target)) setWsOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [wsOpen]);

  const initials = (user?.name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className={`shell ${navOpen ? 'shell--nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar__scroll">
        <div className="sidebar__brand">
          <div className="sidebar__logo" aria-hidden="true">A</div>
          <div>
            <strong>AMB BOARD</strong>
            <small>LIFE MANAGEMENT</small>
          </div>
          <button type="button" className="sidebar__close" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        <div className="sidebar__ws" ref={wsRef}>
          <span className="sidebar__ws-label">WORKSPACE</span>
          <button type="button" className="sidebar__ws-btn" aria-haspopup="listbox" aria-expanded={wsOpen}
            onClick={() => setWsOpen((v) => !v)}>
            <span>{active?.name || 'Select workspace'}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          {wsOpen && (
            <ul className="ws-menu" role="listbox" aria-label="Workspaces">
              {workspaces.map((w) => (
                <li key={w.id} role="option" aria-selected={w.id === active?.id}>
                  <button type="button" onClick={() => { setActiveWorkspace(w.id); setWsOpen(false); }}>
                    <span>{w.name}<small>{w.kind === 'personal' ? 'Personal' : 'Shared'} · {w.role}</small></span>
                    {w.id === active?.id && <Check size={16} aria-hidden="true" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <nav className="sidebar__nav">
          {NAV.map((group) => (
            <div key={group.label}>
              <div className="sidebar__group">{group.label.toUpperCase()}</div>
              {group.items.map(({ to, icon: Icon, text, end }) =>
                to ? (
                  <NavLink key={text} to={to} end={end} className={({ isActive }) => `sidebar__link ${isActive ? 'active' : ''}`}>
                    <Icon size={18} aria-hidden="true" /> {text}
                  </NavLink>
                ) : (
                  <span key={text} className="sidebar__link sidebar__link--soon" aria-disabled="true" title="Not available yet">
                    <Icon size={18} aria-hidden="true" /> {text}<em>Soon</em>
                  </span>
                ))}
            </div>
          ))}
        </nav>
        </div>

        <div className="sidebar__foot">
          <div className="sidebar__user">
            <div className="sidebar__avatar" aria-hidden="true">{initials}</div>
            <div className="sidebar__user-text">
              <b>{user?.name}</b>
              <span>{user?.email}</span>
            </div>
            <button type="button" className="sidebar__signout" onClick={logout} title="Sign out" aria-label="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {navOpen && <button type="button" className="shell__scrim" aria-label="Close menu" onClick={() => setNavOpen(false)} />}

      <div className="shell__body">
        <header className="shell__top">
          <button type="button" className="btn btn-icon btn-ghost shell__menu" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Menu size={20} />
          </button>
          <SearchBox />
          <div className="shell__top-right">
            <span className="shell__top-title">{active?.name}</span>
            {active && <span className="role-tag">{active.role}</span>}
            <NotificationBell key={active?.id} />
            {canWrite(active?.role) && (
              <button type="button" className="btn btn-primary" onClick={() => setQuickAdd(true)}><Plus size={16} aria-hidden="true" /> Quick Add Task</button>
            )}
          </div>
        </header>
        <main className="app"><div className="main">{children}</div></main>
        {quickAdd && <QuickAddTask key={prefill?.title || 'qa'} prefill={prefill} onClose={() => { setQuickAdd(false); setPrefill(null); }} />}
        {location.pathname !== '/assistant' && <AssistantDock key={active?.id} />}
      </div>
    </div>
  );
}
