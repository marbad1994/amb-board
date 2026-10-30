import { Route, Routes, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './context/AuthContext.jsx';
import AppShell from './components/AppShell.jsx';
import AuthPage from './pages/AuthPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import LifeAreasPage from './pages/LifeAreasPage.jsx';
import ProjectsPage from './pages/ProjectsPage.jsx';
import BoardPage from './pages/BoardPage.jsx';
import FinancePage from './pages/FinancePage.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import AssistantPage from './pages/AssistantPage.jsx';
import MyDayPage from './pages/MyDayPage.jsx';
import GoalsPage from './pages/GoalsPage.jsx';
import NotesPage from './pages/NotesPage.jsx';
import DocumentsPage from './pages/DocumentsPage.jsx';
import ReportsPage, { ReportView } from './pages/ReportsPage.jsx';
import AutomationsPage from './pages/AutomationsPage.jsx';
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
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/assistant" element={<AssistantPage />} />
        <Route path="/my-day" element={<MyDayPage />} />
        <Route path="/goals" element={<GoalsPage />} />
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/reports/:id" element={<ReportView />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/ideas" element={<IdeaBoardPage />} />
        <Route path="/settings" element={<WorkspaceSettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
