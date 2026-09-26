import { Route, Routes } from 'react-router-dom';
import TopBar from './components/TopBar.jsx';
import IdentityGate from './components/IdentityGate.jsx';
import ProjectsPage from './pages/ProjectsPage.jsx';
import BoardPage from './pages/BoardPage.jsx';
import IdeaBoardPage from './pages/IdeaBoardPage.jsx';

export default function App() {
  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <IdentityGate>
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<BoardPage />} />
            <Route path="/ideas" element={<IdeaBoardPage />} />
          </Routes>
        </IdentityGate>
      </div>
    </div>
  );
}
