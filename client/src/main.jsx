import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { IdentityProvider } from './context/IdentityContext.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <IdentityProvider>
        <App />
      </IdentityProvider>
    </BrowserRouter>
  </StrictMode>
);
