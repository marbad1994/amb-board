import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler, setWorkspaceId } from '../api/client.js';

const AuthContext = createContext(null);
const WS_KEY = 'amb-board.workspace';

function readStoredWorkspace() {
  try {
    return localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [activeId, setActiveId] = useState(readStoredWorkspace);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((data) => {
    setUser(data.user);
    setWorkspaces(data.workspaces);
    setActiveId((prev) => {
      const valid = data.workspaces.some((w) => w.id === prev);
      return valid ? prev : (data.workspaces.find((w) => w.kind === 'personal') || data.workspaces[0])?.id ?? null;
    });
  }, []);

  const clear = useCallback(() => {
    setUser(null);
    setWorkspaces([]);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    api.me().then(apply).catch(clear).finally(() => setLoading(false));
  }, [apply, clear]);

  // keep the API client and storage in sync with the selected workspace
  useEffect(() => {
    setWorkspaceId(activeId);
    try {
      if (activeId) localStorage.setItem(WS_KEY, activeId);
    } catch {
      // storage unavailable
    }
  }, [activeId]);

  const value = useMemo(() => {
    const active = workspaces.find((w) => w.id === activeId) || null;
    return {
      user, workspaces, active, loading,
      setActiveWorkspace: setActiveId,
      refreshWorkspaces: async () => {
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        return list;
      },
      login: async (email, password) => apply(await api.login(email, password)),
      register: async (data) => apply(await api.register(data)),
      logout: async () => {
        try { await api.logout(); } finally { clear(); }
      },
      logoutAll: async () => {
        try { await api.logoutAll(); } finally { clear(); }
      },
    };
  }, [user, workspaces, activeId, loading, apply, clear]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Roles that may modify workspace content.
export const canWrite = (role) => ['owner', 'admin', 'member'].includes(role);
export const canManage = (role) => ['owner', 'admin'].includes(role);
