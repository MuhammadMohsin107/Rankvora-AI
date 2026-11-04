import { clearTokens, getAccessToken, getRefreshToken, replaceRefreshToken, setAccessToken } from './authTokens';
import { currentIdToken, isEmbedded } from './embedded';

// Default to a same-origin '/api' path: in production the static server (server.cjs) proxies
// /api to the backend, so the browser never needs a separate API hostname. Dev uses the Vite
// proxy for the same reason. Set VITE_API_BASE_URL only to point at a genuinely separate host.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The server's id for this request (`X-Request-Id`) — the key to its entry in the API log. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends RequestInit {
  /** Skips both the Authorization header and the 401-refresh retry. Used by the auth
   * endpoints themselves, so a failed login can never trigger a refresh loop. */
  skipAuth?: boolean;
}

/**
 * Fired when the server refuses to continue a session — it expired, or the account no longer has a
 * Shopify store with Rankvora AI installed. `detail.code` is the server's reason. AuthContext
 * listens and signs the customer out, so protected pages stop rendering at once.
 */
export const SESSION_ENDED_EVENT = 'rankvora:session-ended';

/**
 * Ends the session the server refused, unless it has already been replaced.
 *
 * A newer refresh token in storage means a sign-in finished, or another tab refreshed, while this
 * request was in flight. The refusal is about a token nobody uses any more, so the newer sign-in
 * is left alone and nobody is signed out.
 */
function endSession(code: string | undefined, refusedToken: string) {
  if (getRefreshToken() !== refusedToken) return;
  clearTokens(refusedToken);
  window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { code } }));
}

/**
 * What a refresh came back with:
 *   'refreshed'   — a new token pair is stored.
 *   'refused'     — the server said no (the session expired, was revoked, or has no store). The
 *                   session is over.
 *   'unavailable' — no answer about the session at all: a network drop, a 502 while the API
 *                   restarts during a deploy, a 500. The customer stays signed in and the next
 *                   request tries again.
 */
type RefreshResult = 'refreshed' | 'refused' | 'unavailable';

type RefreshAttempt =
  | { kind: 'refreshed'; accessToken: string; refreshToken?: string }
  | { kind: 'refused'; code?: string }
  | { kind: 'unavailable' };

async function postRefresh(refreshToken: string): Promise<RefreshAttempt> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    return { kind: 'unavailable' };
  }

  // Only a 401 (a token the server will not honour) or a 400 (one it cannot even read) is the
  // server refusing the session. Every other failure says nothing about the session.
  if (response.status === 401 || response.status === 400) {
    let code: string | undefined;
    try {
      const failure = await response.json();
      if (failure && typeof failure.code === 'string') code = failure.code;
    } catch {
      // No JSON body — the generic wording applies.
    }
    return { kind: 'refused', code };
  }
  if (!response.ok) return { kind: 'unavailable' };

  try {
    const data = (await response.json())?.data;
    if (data && typeof data.accessToken === 'string') {
      return { kind: 'refreshed', accessToken: data.accessToken, refreshToken: data.refreshToken };
    }
  } catch {
    // An unreadable success body: treated like no answer.
  }
  return { kind: 'unavailable' };
}

/**
 * Refreshes with the token currently in storage. Runs inside the cross-tab lock.
 */
async function refreshWithStoredToken(): Promise<RefreshResult> {
  // Read here, inside the lock, not before it: the tab that held the lock before this one may have
  // just rotated the token.
  let sent = getRefreshToken();
  if (!sent) return 'refused';
  let attempt = await postRefresh(sent);

  // Refused, but the stored token changed while this request was out — a sign-in finished in this
  // tab, or a tab without the lock refreshed. Try once more with the token that is current now.
  if (attempt.kind === 'refused') {
    const current = getRefreshToken();
    if (current && current !== sent) {
      sent = current;
      attempt = await postRefresh(sent);
    }
  }

  switch (attempt.kind) {
    case 'refreshed':
      // The backend rotates refresh tokens, so store the new pair, not just the access token.
      setAccessToken(attempt.accessToken);
      if (attempt.refreshToken) replaceRefreshToken(attempt.refreshToken);
      return 'refreshed';
    case 'refused':
      endSession(attempt.code, sent);
      return 'refused';
    default:
      return 'unavailable';
  }
}

/**
 * Runs a refresh while every other tab of this site waits its turn.
 *
 * A refresh token works once. Tabs that refresh at the same moment, as every restored tab does
 * after a browser restart, would present the same token, and all but one would be refused. In the
 * lock each tab reads the token the previous one stored, so a token is never presented twice.
 * Browsers without the Web Locks API run the refresh directly; the retry in
 * refreshWithStoredToken still covers most of that race.
 */
async function withRefreshLock(task: () => Promise<RefreshResult>): Promise<RefreshResult> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') return task();
  return await locks.request('scorelo.refresh', () => task());
}

/** Refresh is shared: if several requests 401 at once they await one refresh, not N. */
let refreshInFlight: Promise<RefreshResult> | null = null;

async function refreshAccessToken(): Promise<RefreshResult> {
  if (!getRefreshToken()) return 'refused';

  refreshInFlight ??= (async () => {
    try {
      return await withRefreshLock(refreshWithStoredToken);
    } catch {
      return 'unavailable' as const;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** What a request throws when its session could not be renewed because the server did not answer. */
function sessionUnavailableError(): ApiError {
  return new ApiError('Rankvora AI could not be reached. Check your connection and try again in a moment.', 503, 'SESSION_REFRESH_UNAVAILABLE');
}

/**
 * Whether a 401 can be answered by renewing this app's own session.
 *
 * Never inside the Shopify admin. There the caller is proved by an ID token App Bridge adds to every
 * `fetch` — nothing of ours is stored to renew — and App Bridge itself fetches a fresh token and
 * repeats a request the server answers with X-Shopify-Retry-Invalid-Session-Request. A refresh token
 * left in this browser by an earlier standalone sign-in must not be tried either: its refusal would
 * sign the merchant out of an admin session that is perfectly good.
 */
function canRefresh(): boolean {
  return !isEmbedded() && Boolean(getRefreshToken());
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const token = options.skipAuth ? null : getAccessToken();
  const { skipAuth: _skipAuth, ...init } = options;

  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await rawRequest(path, options);

  // An expired access token is recoverable: refresh once, then replay the request.
  if (response.status === 401 && !options.skipAuth && canRefresh()) {
    const refreshed = await refreshAccessToken();
    if (refreshed === 'refreshed') response = await rawRequest(path, options);
    else if (refreshed === 'unavailable') throw sessionUnavailableError();
  }

  if (!response.ok) {
    let message = 'Request failed';
    let code: string | undefined;
    try {
      const payload = await response.json();
      if (payload && typeof payload.error === 'string') message = payload.error;
      if (payload && typeof payload.code === 'string') code = payload.code;
    } catch {
      // ignore JSON parse errors and fall back to the default message
    }
    throw new ApiError(message, response.status, code, response.headers.get('X-Request-Id') ?? undefined);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json();
  // Every Rankvora AI controller responds with `{ data: ... }` — unwrap it once here
  // so call sites can work with the resource shape directly.
  return (payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload) as T;
}

/**
 * Fetches a file the server generated (today: the Reports CSV export).
 *
 * `request` always parses JSON, so a CSV routed through it arrives as a parse error. This shares
 * everything that matters — the Authorization header, the one-shot refresh-and-replay on 401, and
 * the `{ error, code }` decoding of a failure — and differs only in returning the bytes. The
 * filename comes from Content-Disposition so the server names its own file; `fallbackName` is
 * used only when the header is missing.
 */
async function downloadFile(path: string, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
  let response = await rawRequest(path, { method: 'GET' });

  if (response.status === 401 && canRefresh()) {
    const refreshed = await refreshAccessToken();
    if (refreshed === 'refreshed') response = await rawRequest(path, { method: 'GET' });
    else if (refreshed === 'unavailable') throw sessionUnavailableError();
  }

  if (!response.ok) {
    let message = 'Download failed';
    let code: string | undefined;
    try {
      const payload = await response.json();
      if (payload && typeof payload.error === 'string') message = payload.error;
      if (payload && typeof payload.code === 'string') code = payload.code;
    } catch {
      // A non-JSON error body carries nothing useful; the status still does.
    }
    throw new ApiError(message, response.status, code, response.headers.get('X-Request-Id') ?? undefined);
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return { blob: await response.blob(), filename: match ? decodeURIComponent(match[1]) : fallbackName };
}

/**
 * Sends a file's own bytes as the request body (not JSON), reporting how much has gone up.
 *
 * XMLHttpRequest rather than fetch because only XHR reports UPLOAD progress. Everything else about
 * the call is shared with `request`: the Authorization header, the one-shot refresh-and-replay on
 * 401, the `{ data }` unwrapping and the `{ error, code }` decoding of a failure.
 */
async function uploadFile<T>(
  path: string,
  file: Blob,
  options: { contentType: string; onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<T> {
  // App Bridge adds the ID token to `fetch` on its own but not to an XMLHttpRequest, so inside the
  // Shopify admin an upload asks for a fresh one itself (they last about a minute — one per request).
  const send = async () => {
    const token = getAccessToken() ?? (await currentIdToken());
    return sendWith(token);
  };
  const sendWith = (token: string | null) => new Promise<{ status: number; body: unknown; requestId?: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}${path}`);
    xhr.setRequestHeader('Content-Type', options.contentType);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && options.onProgress) options.onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* an empty or non-JSON body carries nothing to decode */ }
      resolve({ status: xhr.status, body, requestId: xhr.getResponseHeader('X-Request-Id') ?? undefined });
    };
    xhr.onerror = () => reject(new ApiError('The upload could not reach Rankvora AI. Check your connection and try again.', 0));
    xhr.ontimeout = () => reject(new ApiError('The upload timed out. Try again.', 0));
    xhr.onabort = () => reject(new ApiError('The upload was cancelled.', 0, 'ABORTED'));
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });

  let result = await send();
  if (result.status === 401 && isEmbedded()) {
    // The ID token may have lapsed between being issued and arriving: ask for a new one, once.
    result = await send();
  } else if (result.status === 401 && canRefresh()) {
    const refreshed = await refreshAccessToken();
    if (refreshed === 'refreshed') result = await send();
    else if (refreshed === 'unavailable') throw sessionUnavailableError();
  }

  const payload = result.body as { error?: unknown; code?: unknown; data?: unknown } | null;
  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(
      payload && typeof payload.error === 'string' ? payload.error : 'The upload failed',
      result.status,
      payload && typeof payload.code === 'string' ? payload.code : undefined,
      result.requestId,
    );
  }
  return (payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  upload: uploadFile,
  download: downloadFile,
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, {
    ...options,
    method: 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }),
  put: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'DELETE' }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, {
    ...options,
    method: 'PATCH',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }),
};
