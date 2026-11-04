import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UserRow } from '../data/api.types';
import * as authRepository from '../data/auth.repository';
import { updateCachedUser } from '../data/user.repository';
import { isEmbedded } from '../lib/embedded';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: UserRow | null;
  /**
   * The server's reason code when the app could not open inside the Shopify admin, so the screen
   * that stands where a sign-in page would be can say why. Null when nothing went wrong.
   */
  openFailure: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Who is using the app. There is no sign-in to run and nothing to sign out of: inside the Shopify
 * admin the shop that opened the app is proved by Shopify's ID token (data/auth.repository.ts), and
 * outside it — local development with MOCK_AUTH — the API answers for a mock user.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserRow | null>(null);
  const [openFailure, setOpenFailure] = useState<string | null>(null);

  // Resolved on mount. `status` stays 'loading' until this settles so the router never flashes an
  // "unavailable" screen at someone whose app is simply still opening. (React StrictMode runs this
  // twice in development; the first run is ignored through `active`. Two first opens of one shop at
  // once can make the second fail on the server's unique keys — openEmbeddedSession retries it.)
  useEffect(() => {
    let active = true;

    if (isEmbedded()) {
      authRepository.openEmbeddedSession().then((result) => {
        if (!active) return;
        if ('user' in result) {
          updateCachedUser(result.user);
          setUser(result.user);
          setStatus('authenticated');
        } else {
          setOpenFailure(result.code);
          setStatus('unauthenticated');
        }
      });
    } else {
      authRepository.fetchSession().then((session) => {
        if (!active) return;
        if (session) {
          updateCachedUser(session);
          setUser(session);
          setStatus('authenticated');
        } else {
          setStatus('unauthenticated');
        }
      });
    }
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ status, user, openFailure }), [status, user, openFailure]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
