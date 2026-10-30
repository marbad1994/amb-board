import { useLocation } from 'react-router-dom';

// Which page (and which item) the user is looking at: sent to the assistant so "this project" just works.
export function useAssistantContext() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  const first = parts[0] || 'dashboard';
  const map = { projects: parts[1] ? 'project' : 'projects', 'my-day': 'my-day', tasks: 'tasks', calendar: 'calendar', finance: 'finance', goals: 'goals', notes: 'notes',
    documents: 'documents', 'life-areas': 'life-areas', ideas: 'ideas', reports: 'reports', settings: 'settings', assistant: 'assistant', dashboard: 'dashboard' };
  const page = map[first] || 'dashboard';
  const id = page === 'project' ? parts[1] : undefined;
  const label = { dashboard: 'Dashboard', 'my-day': 'My Day', projects: 'Projects', project: 'A project board', tasks: 'Tasks', calendar: 'Calendar', finance: 'Finance',
    goals: 'Goals & habits', notes: 'Notes', documents: 'Documents', 'life-areas': 'Life areas', ideas: 'Idea board', reports: 'Reports', settings: 'Settings', assistant: 'Assistant' }[page];
  return { page, id, label, context: { page, ...(id ? { id } : {}) }, suggestionKey: id ? `${page}:${id}` : page };
}
