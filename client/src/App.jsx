import { Route, Routes, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './context/AuthContext.jsx';
import AppShell from './components/AppShell.jsx';
import AuthPage from './pages/AuthPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import LifeAreasPage from './pages/LifeAreasPage.jsx';
import ProjectsPage from './pages/ProjectsPage.jsx';
import BoardPage from './pages/BoardPage.jsx';
import TasksPage from './pages/TasksPage.jsx';
import IdeaBoardPage from './pages/IdeaBoardPage.jsx';
import WorkspaceSettingsPage from './pages/WorkspaceSettingsPage.jsx';

export default function App() {
  const { user, loading, active } = useAuth();

  if (loading) {
    return (
      <div className="splash" role="status" aria-label="Loading">
        <Loader2 className="spin" size={28} />
      </div>
    );
  }
  if (!user) return <AuthPage />;

  return (
    <AppShell>
      {/* key remounts pages when the workspace changes so no stale data from another workspace lingers */}
      <Routes key={active?.id}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/life-areas" element={<LifeAreasPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<BoardPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/ideas" element={<IdeaBoardPage />} />
        <Route path="/settings" element={<WorkspaceSettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
