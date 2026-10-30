import { useAuth } from './AuthContext.jsx';

// Compatibility adapter: components that only need the signed-in user's display name.
export function useIdentity() {
  const { user } = useAuth();
  return { name: user?.name || '' };
}
