import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { User } from './types';

interface SessionState {
  user: User | null;
  fallbackCredentialId: string | null;
  registrationEnabled: boolean;
  /** True until the initial `GET /api/auth/session` resolves. */
  loading: boolean;
}

export interface SessionContextValue extends SessionState {
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setFallbackCredential: (credentialId: string | null) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionResponse {
  user: User;
  fallbackCredentialId: string | null;
  registrationEnabled: boolean;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    user: null,
    fallbackCredentialId: null,
    registrationEnabled: true,
    loading: true,
  });

  const load = useCallback(async () => {
    try {
      const session = await api.get<SessionResponse>('/api/auth/session');
      setState({
        user: session.user,
        fallbackCredentialId: session.fallbackCredentialId,
        registrationEnabled: session.registrationEnabled,
        loading: false,
      });
    } catch (error) {
      // A 401 simply means "not signed in". Either way we resolve the public
      // registration flag so the sign-up screen can hide itself when disabled.
      void error;
      let registrationEnabled = true;
      try {
        const availability = await api.get<{ registrationEnabled: boolean }>('/api/auth/signup-availability');
        registrationEnabled = availability.registrationEnabled;
      } catch {
        // Keep the optimistic default.
      }
      setState({ user: null, fallbackCredentialId: null, registrationEnabled, loading: false });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await api.post<{ user: User }>('/api/auth/signin', { email, password });
      await load();
    },
    [load],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName?: string) => {
      await api.post<{ user: User }>('/api/auth/signup', { email, password, displayName });
      await load();
    },
    [load],
  );

  const signOut = useCallback(async () => {
    await api.post('/api/auth/signout');
    setState((current) => ({ ...current, user: null, fallbackCredentialId: null }));
  }, []);

  const setFallbackCredential = useCallback(async (credentialId: string | null) => {
    await api.post('/api/provider-credentials/fallback', { fallbackCredentialId: credentialId });
    setState((current) => ({ ...current, fallbackCredentialId: credentialId }));
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, signIn, signUp, signOut, refresh: load, setFallbackCredential }),
    [state, signIn, signUp, signOut, load, setFallbackCredential],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}
