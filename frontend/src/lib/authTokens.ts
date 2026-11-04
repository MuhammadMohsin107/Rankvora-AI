// ─── Auth token storage ──────────────────────────────────────────────
// The ACCESS token is kept in memory only: it never touches web storage, so an
// XSS payload cannot read it out of storage after the fact.
//
// The REFRESH token is persisted in localStorage, so a reload, a new tab or a restarted
// browser does not sign the customer out. Web storage is the pragmatic choice for a token
// the SPA itself must replay, but it is readable by injected script — moving refresh to an
// httpOnly, SameSite cookie is the intended hardening step before public launch (it
// requires the backend to set the cookie).

const REFRESH_STORAGE_KEY = 'scorelo.refreshToken';

let accessToken: string | null = null;

function readStored(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_STORAGE_KEY);
  } catch {
    // Private browsing / storage disabled.
    return null;
  }
}

function writeStored(refreshToken: string): void {
  try {
    window.localStorage.setItem(REFRESH_STORAGE_KEY, refreshToken);
  } catch {
    // Non-fatal: the in-memory access token still authenticates this tab.
  }
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return readStored();
}

/** Stores the pair a sign-in issued. */
export function setTokens(tokens: { accessToken: string; refreshToken: string }): void {
  accessToken = tokens.accessToken;
  writeStored(tokens.refreshToken);
}

export function setAccessToken(token: string): void {
  accessToken = token;
}

/**
 * Stores the rotated refresh token a refresh returned — only while a session is still stored, so a
 * refresh that finishes after the customer signed out cannot sign them back in.
 */
export function replaceRefreshToken(refreshToken: string): void {
  if (readStored() !== null) writeStored(refreshToken);
}

/**
 * Forgets the session on this device.
 *
 * With `refusedToken`, only that exact refresh token is removed: when the server refuses a token,
 * another tab may already have stored the newer one from its own refresh, and that sign-in is still
 * good.
 */
export function clearTokens(refusedToken?: string): void {
  accessToken = null;
  try {
    if (refusedToken === undefined || readStored() === refusedToken) {
      window.localStorage.removeItem(REFRESH_STORAGE_KEY);
    }
  } catch {
    // Nothing to clean up.
  }
}
