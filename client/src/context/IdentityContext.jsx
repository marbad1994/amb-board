import { createContext, useContext, useEffect, useState } from 'react';

const IdentityContext = createContext(null);
const STORAGE_KEY = 'amb-board.identity';

export function IdentityProvider({ children }) {
  const [name, setNameState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    try {
      if (name) localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // ignore storage errors (private mode, etc.)
    }
  }, [name]);

  const setName = (value) => setNameState(value.trim());

  return (
    <IdentityContext.Provider value={{ name, setName }}>
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentity() {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider');
  return ctx;
}
