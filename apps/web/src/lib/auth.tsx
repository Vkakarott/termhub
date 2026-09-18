import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { AuthConfig, User, ViewAs } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  config: AuthConfig | null;
  login: (email: string, password: string) => Promise<void>;
  sendCode: (email: string) => Promise<number>;
  verifyCode: (email: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /** admin data-scope switch (see ViewAs); null when viewing own data */
  viewAs: ViewAs;
  /** admin only: switch the data scope and reload the app so every list/socket follows */
  setViewAs: (user_id: string | null) => Promise<void>;
  /** true when the signed-in user's role grants resource:action (admins: always) */
  can: (resource: string, action?: 'create' | 'read' | 'update' | 'delete') => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [viewAs, setViewAsState] = useState<ViewAs>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, me] = await Promise.all([
          api.auth.config().catch(() => null),
          api.auth.me().catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setUser(me?.user ?? null);
        setViewAsState(me?.view_as ?? null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const onUnauthorized = () => setUser(null);
    window.addEventListener('termhub:unauthorized', onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener('termhub:unauthorized', onUnauthorized);
    };
  }, []);

  const can = useCallback(
    (resource: string, action: 'create' | 'read' | 'update' | 'delete' = 'read') => {
      if (!user) return false;
      if (user.role_info?.is_admin) return true;
      return (user.permissions ?? []).includes(`${resource}:${action}`);
    },
    [user],
  );

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await api.auth.login(email, password);
    setUser(user);
  }, []);

  const sendCode = useCallback(async (email: string) => {
    const r = await api.auth.sendCode(email);
    return r.ttl_minutes;
  }, []);

  const verifyCode = useCallback(async (email: string, code: string) => {
    const { user } = await api.auth.verifyCode(email, code);
    setUser(user);
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => {});
    setUser(null);
    setViewAsState(null);
  }, []);

  const setViewAs = useCallback(async (user_id: string | null) => {
    const r = await api.auth.viewAs(user_id);
    setViewAsState(r.view_as);
    // Machines, projects and open terminals are all scope-bound: a full reload is the honest reset.
    window.location.assign('/');
  }, []);

  return <AuthContext.Provider value={{ user, loading, config, login, sendCode, verifyCode, logout, viewAs, setViewAs, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}
