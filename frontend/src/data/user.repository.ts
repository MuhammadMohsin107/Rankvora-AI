import { api } from '../lib/api';
import type { UserRow } from './api.types';

// One shared in-flight/settled promise so Header and Sidebar (both mounted in
// AppShell) trigger a single /users/me request instead of one each.
let cached: Promise<UserRow> | null = null;

type Listener = (user: UserRow) => void;
const listeners = new Set<Listener>();

export function fetchCurrentUser(): Promise<UserRow> {
  if (!cached) {
    cached = api.get<UserRow>('/users/me').catch((error) => {
      cached = null; // failed request must not be cached, or a retry can never succeed
      throw error;
    });
  }
  return cached;
}

/** Notifies mounted components (Header/Sidebar) when the user changes, e.g. after a Settings save. */
export function subscribeCurrentUser(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by settings.repository after a successful PUT so cached identity stays current. */
export function updateCachedUser(user: UserRow): void {
  cached = Promise.resolve(user);
  listeners.forEach((listener) => listener(user));
}

/** Drops the cached identity on sign-in/sign-out. Without this the next customer to use the
 * same browser tab would briefly see the previous customer's name and email. */
export function resetCachedUser(): void {
  cached = null;
}

export function initialsFor(fullName: string): string {
  return fullName
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'S';
}
