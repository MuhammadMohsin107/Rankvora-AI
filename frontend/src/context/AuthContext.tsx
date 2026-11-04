import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UserRow } from '../data/api.types';
import * as authRepository from '../data/auth.repository';
import { resetCachedUser, updateCachedUser } from '../data/user.repository';
import { resetNotifications } from '../data/notifications';
import { SESSION_ENDED_EVENT } from '../lib/api';
import { isEmbedded } from '../lib/embedded';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: UserRow | null;
  /**
   * The server's reason code when it ended the last session on its own (expired, or no installed
   * Shopify store), so the sign-in page can say why. Null after a normal sign-out.
   */
  sessionEndedReason: string | null;
  clearSessionEndedReason: () => void;
  /** Finishes a Shopify sign-in from the grant it returned with, and starts the session. */
  completeShopifySignIn: (grant: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserRow | null>(null);
  const [sessionEndedReason, setSessionEndedReason] = useState<string | null>(null);

  /**
   * Bumped whenever the session changes hands: a sign-in, a sign-out, or the server ending it. The
   * check on mount applies its answer only if nothing changed while it was out. Without this, a
   * Shopify sign-in that finished first was overwritten by the slower check, which still had the
   * old session's answer.
   */
  const sessionVersion = useRef(0);

  // Resolve the session once on mount. `status` stays 'loading' until this settles so the
  // router never flashes the login screen at an already-signed-in customer.
  useEffect(() => {
    let active = true;
    const startedAt = sessionVersion.current;

    // Inside the Shopify admin there is no sign-in and no stored session: the shop that opened the app
    // is proved by the ID token App Bridge sends, and "resolving the session" is opening the app for
    // that shop. When that fails the reason is kept, so the page can say why instead of showing a form
    // that asks for something the merchant has no way to provide.
    if (isEmbedded()) {
      authRepository.openEmbeddedSession().then((result) => {
        if (!active || sessionVersion.current !== startedAt) return;
        if ('user' in result) {
          updateCachedUser(result.user);
          setUser(result.user);
          setStatus('authenticated');
        } else {
          setSessionEndedReason(result.code);
          setStatus('unauthenticated');
        }
      });
      return () => {
        active = false;
      };
    }

    authRepository.fetchSession().then((session) => {
      if (!active || sessionVersion.current !== startedAt) return;
      if (session) {
        updateCachedUser(session);
        setUser(session);
        setStatus('authenticated');
      } else {
        setStatus('unauthenticated');
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // The server refused to continue the session. Sign out here too, so RequireAuth sends the
  // customer to sign-in straight away instead of leaving them on a page whose requests all fail.
  useEffect(() => {
    function handleSessionEnded(event: Event) {
      const code = (event as CustomEvent<{ code?: string }>).detail?.code;
      sessionVersion.current += 1;
      resetCachedUser();
      resetNotifications();
      setUser(null);
      setStatus('unauthenticated');
      setSessionEndedReason(code ?? 'INVALID_REFRESH_TOKEN');
    }
    window.addEventListener(SESSION_ENDED_EVENT, handleSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, handleSessionEnded);
  }, []);

  const adoptSession = useCallback((session: UserRow) => {
    sessionVersion.current += 1;
    resetCachedUser();
    // The notification store is module state that outlives a sign-out, so without this the next
    // person to sign in on this browser would see the previous account's bell until it refetched.
    resetNotifications();
    updateCachedUser(session);
    setUser(session);
    setStatus('authenticated');
    setSessionEndedReason(null);
  }, []);

  const completeShopifySignIn = useCallback(
    async (grant: string) => {
      adoptSession(await authRepository.completeShopifySignIn(grant));
    },
    [adoptSession],
  );

  const logout = useCallback(async () => {
    sessionVersion.current += 1;
    await authRepository.logout();
    resetCachedUser();
    resetNotifications();
    setUser(null);
    setStatus('unauthenticated');
    setSessionEndedReason(null);
  }, []);

  const clearSessionEndedReason = useCallback(() => setSessionEndedReason(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      sessionEndedReason,
      clearSessionEndedReason,
      completeShopifySignIn,
      logout,
    }),
    [status, user, sessionEndedReason, clearSessionEndedReason, completeShopifySignIn, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
