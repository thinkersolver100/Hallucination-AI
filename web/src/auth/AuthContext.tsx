import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError, request, setUnauthorizedHandler } from '../api/client';
import { sessionSchema, type Session } from '../api/types';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; session: Session };

interface AuthApi {
  state: AuthState;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, organizationName: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anonymous' }));
    let cancelled = false;
    request('GET', '/auth/me', { schema: sessionSchema, expect401: true })
      .then((session) => {
        if (!cancelled) setState({ status: 'authenticated', session });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'anonymous' });
      });
    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const session = await request('POST', '/auth/login', {
      body: { email, password },
      schema: sessionSchema,
      expect401: true,
    });
    setState({ status: 'authenticated', session });
  }, []);

  const register = useCallback(async (email: string, password: string, organizationName: string) => {
    const session = await request('POST', '/auth/register', {
      body: { email, password, organizationName },
      schema: sessionSchema,
      expect401: true,
    });
    setState({ status: 'authenticated', session });
  }, []);

  const logout = useCallback(async () => {
    try {
      await request('POST', '/auth/logout', { expect401: true });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err; // the session is gone either way
    }
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, login, register, logout }), [state, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <p className="muted center">Loading…</p>;
  if (state.status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
