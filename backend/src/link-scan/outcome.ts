/**
 * ─── What an answer means ────────────────────────────────────────────
 *
 * Every address a scan asks about ends in one of six outcomes. The wording matters as much as the
 * sorting: a scan that says "broken" about a link that merely did not answer a robot is worse than no
 * scan, so the line between BROKEN (a shopper following the link would hit a dead end) and everything
 * that is only "we could not tell" is drawn here, in one place, and tested.
 *
 *   ok          answered 2xx, straight away
 *   redirect    answered 2xx after being sent on elsewhere — it works, but the link should name the new address
 *   broken      a dead end: the page is gone (404, 410), the server is failing (5xx, after a retry), the host
 *               does not exist, refuses connections or has a certificate a browser would refuse, or the
 *               redirect chain never ends
 *   blocked     the site answered, but refused an automated visitor (401, 403, 429, 451, 999, a bot challenge).
 *               A person may well get through, so this is never called broken
 *   unverified  no usable answer: it timed out, the connection dropped, or another website replied with a
 *               status that says nothing about the page. Not counted either way
 *   skipped     deliberately not requested — a private-network address, an unusual port, an address with a
 *               password in it
 *
 * Another website's 400 or an odd 4xx is unverified, not broken (sites send them to robots a browser would
 * never see them for); the store's OWN 4xx is broken, because the store answers a robot and a browser alike.
 */

export type Outcome = 'ok' | 'redirect' | 'broken' | 'blocked' | 'unverified' | 'skipped';

export type Reason =
  | 'not_found'
  | 'gone'
  | 'server_error'
  | 'client_error'
  | 'dns_failed'
  | 'connection_refused'
  | 'ssl_error'
  | 'redirect_loop'
  | 'too_many_redirects'
  | 'bad_redirect'
  | 'forbidden'
  | 'rate_limited'
  | 'bot_challenge'
  | 'unavailable_legal'
  | 'timed_out'
  | 'connection_lost'
  | 'dns_unavailable'
  | 'network_error'
  | 'password_protected'
  | 'not_requested';

export interface Classified {
  outcome: Outcome;
  reason: Reason | null;
  /** One sentence for the merchant. Null for a plain success. */
  detail: string | null;
}

/** What a network failure was, from the error `fetch` threw. Never the raw message: it can carry an address or a hostname. */
export function classifyNetworkError(error: unknown): { reason: Reason; retry: boolean } {
  const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const code = String(err?.cause?.code ?? err?.code ?? '');
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`.toLowerCase();

  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || /timed out|timeout/.test(text)) {
    return { reason: 'timed_out', retry: true };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_NODATA' || /enotfound|no such host|hostname not found|could not resolve|name not resolved/.test(text)) {
    return { reason: 'dns_failed', retry: false };
  }
  if (code === 'EAI_AGAIN') return { reason: 'dns_unavailable', retry: true };
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code === 'EPROTO' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || /certificate|ssl|tls handshake|self.signed|handshake/.test(text)) {
    return { reason: 'ssl_error', retry: false };
  }
  if (code === 'ECONNREFUSED' || /connection refused|econnrefused/.test(text)) return { reason: 'connection_refused', retry: true };
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE' || /connection lost|connection reset|socket hang up|network connection lost|terminated/.test(text)) {
    return { reason: 'connection_lost', retry: true };
  }
  return { reason: 'network_error', retry: true };
}

/** Sentences for a failure that produced no HTTP status. */
const NETWORK_DETAIL: Record<string, string> = {
  dns_failed: 'The domain name does not exist.',
  connection_refused: 'The server refused the connection.',
  ssl_error: 'The site’s security certificate is not valid, so a browser would show a warning instead of the page.',
  timed_out: 'The site did not answer in time.',
  connection_lost: 'The connection was dropped before the site answered.',
  dns_unavailable: 'The domain name could not be looked up just now.',
  network_error: 'The site could not be reached.',
  redirect_loop: 'The address redirects back to itself.',
  too_many_redirects: 'The address passes through too many redirects to reach a page.',
  bad_redirect: 'The address redirects without saying where.',
};

/**
 * The outcome of a failure that produced no HTTP status. A host that does not exist, refuses connections
 * or has an invalid certificate is a dead end for a shopper; a timeout or a dropped connection is only
 * "could not tell" — the site may be slow today.
 */
export function classifyFailure(reason: Reason): Classified {
  const detail = NETWORK_DETAIL[reason] ?? 'The site could not be reached.';
  switch (reason) {
    case 'dns_failed':
    case 'connection_refused':
    case 'ssl_error':
    case 'redirect_loop':
    case 'too_many_redirects':
    case 'bad_redirect':
      return { outcome: 'broken', reason, detail };
    default:
      return { outcome: 'unverified', reason, detail };
  }
}

export interface ResponseFacts {
  status: number;
  /** Redirects followed to reach this response. */
  hops: number;
  /** True for an address on the store itself. */
  internal: boolean;
  /** True when the response carries a bot-challenge marker (Cloudflare and similar). */
  challenged?: boolean;
}

/** The outcome of a final HTTP response. */
export function classifyResponse({ status, hops, internal, challenged }: ResponseFacts): Classified {
  if (status >= 200 && status < 300) {
    return hops > 0
      ? { outcome: 'redirect', reason: null, detail: `Redirects ${hops === 1 ? 'once' : `${hops} times`} before reaching the page. Link to the final address instead.` }
      : { outcome: 'ok', reason: null, detail: null };
  }
  if (status >= 300 && status < 400) {
    return { outcome: 'broken', reason: 'bad_redirect', detail: NETWORK_DETAIL.bad_redirect! };
  }
  if (challenged && (status === 403 || status === 429 || status === 503)) {
    return { outcome: 'blocked', reason: 'bot_challenge', detail: `The site showed a check meant for robots (HTTP ${status}), so the link could not be tested. A visitor would most likely get through.` };
  }
  if (status === 404) return { outcome: 'broken', reason: 'not_found', detail: 'Page not found (HTTP 404).' };
  if (status === 410) return { outcome: 'broken', reason: 'gone', detail: 'The page has been removed (HTTP 410).' };
  if (status === 401 || status === 403) {
    return { outcome: 'blocked', reason: 'forbidden', detail: `The site refused the check (HTTP ${status}). A visitor may be able to open it, so it is not counted as broken.` };
  }
  if (status === 429) return { outcome: 'blocked', reason: 'rate_limited', detail: 'The site asked the check to slow down (HTTP 429), so the link could not be tested.' };
  if (status === 451 || status === 999) {
    return { outcome: 'blocked', reason: 'unavailable_legal', detail: `The site does not answer automated checks (HTTP ${status}), so the link could not be tested.` };
  }
  if (status >= 500) return { outcome: 'broken', reason: 'server_error', detail: `The server is failing (HTTP ${status}).` };
  if (status === 408) return { outcome: 'unverified', reason: 'timed_out', detail: NETWORK_DETAIL.timed_out! };
  if (status >= 400) {
    return internal
      ? { outcome: 'broken', reason: 'client_error', detail: `The store answers this address with an error (HTTP ${status}).` }
      : { outcome: 'unverified', reason: 'client_error', detail: `The site answered HTTP ${status}, which does not say whether the page works for a visitor.` };
  }
  return { outcome: 'unverified', reason: 'network_error', detail: `The site answered HTTP ${status}.` };
}

export const PASSWORD_PROTECTED: Classified = {
  outcome: 'unverified',
  reason: 'password_protected',
  detail: 'The store’s password page was shown instead of this page, so it could not be read.',
};

export const NOT_REQUESTED = (why: string): Classified => ({
  outcome: 'skipped',
  reason: 'not_requested',
  detail: `Not requested: ${why}.`,
});
