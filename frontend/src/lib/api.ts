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

// ─── Who is calling ──────────────────────────────────────────────────
//
// This app holds no credential. Inside the Shopify admin, App Bridge intercepts every `fetch` to this
// site and adds an ID token that Shopify signs and that names the shop — so nothing here attaches an
// Authorization header, stores a token or renews one. If the token has gone stale on its way, the
// server answers 401 with X-Shopify-Retry-Invalid-Session-Request and App Bridge fetches a fresh one
// and repeats the request by itself.
//
// Outside the admin there is nothing to prove: local development runs the API with MOCK_AUTH, which
// needs no header, and the bare site has no session at all.

interface RequestOptions extends RequestInit {}

function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...options,
    // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread -- options.headers may be a Headers object or array, so spreading it bare does not type-check
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
}

async function failureOf(response: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  let code: string | undefined;
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string') message = payload.error;
    if (payload && typeof payload.code === 'string') code = payload.code;
  } catch {
    // A non-JSON error body carries nothing useful; the status still does.
  }
  return new ApiError(message, response.status, code, response.headers.get('X-Request-Id') ?? undefined);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await rawRequest(path, options);
  if (!response.ok) throw await failureOf(response, 'Request failed');

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
 * `request` always parses JSON, so a CSV routed through it arrives as a parse error. This shares the
 * `{ error, code }` decoding of a failure and differs only in returning the bytes. The filename
 * comes from Content-Disposition so the server names its own file; `fallbackName` is used only when
 * the header is missing.
 */
async function downloadFile(path: string, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
  const response = await rawRequest(path, { method: 'GET' });
  if (!response.ok) throw await failureOf(response, 'Download failed');

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return { blob: await response.blob(), filename: match ? decodeURIComponent(match[1]) : fallbackName };
}

/**
 * Sends a file's own bytes as the request body (not JSON), reporting how much has gone up.
 *
 * XMLHttpRequest rather than fetch because only XHR reports UPLOAD progress. Everything else about
 * the call is shared with `request`: the `{ data }` unwrapping and the `{ error, code }` decoding of
 * a failure.
 *
 * App Bridge adds the ID token to `fetch` on its own but not to an XMLHttpRequest, so inside the
 * Shopify admin an upload asks for a fresh one itself (they last about a minute — one per request),
 * and asks again, once, if the server found the first one stale.
 */
async function uploadFile<T>(
  path: string,
  file: Blob,
  options: { contentType: string; onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<T> {
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
  const send = async () => sendWith(await currentIdToken());

  let result = await send();
  if (result.status === 401 && isEmbedded()) result = await send();

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
