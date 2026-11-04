import type { Request } from 'express';

/**
 * ─── Real request metadata ───────────────────────────────────────────
 *
 * Extracts the client IP and User-Agent from an actual request, and NOTHING ELSE.
 *
 * There is no device parser and no geolocation here on purpose. A "device" string is a guess
 * derived from a header anyone can set, and a location needs a geo-IP database this project does
 * not carry — presenting either as fact on a security page would be inventing evidence about a
 * customer's own account. What is genuinely known gets recorded; what is not returns null.
 *
 * Every value produced here is stored as-is and rendered as-is. Null means "we do not know",
 * and the UI says exactly that.
 */

export interface RequestMetadata {
  /** Client IP, or null when the request carries none that can be trusted. */
  ipAddress: string | null;
  /** Raw User-Agent header, truncated to the column width, or null when absent. */
  userAgent: string | null;
}

/** Matches security_events.user_agent. */
const USER_AGENT_MAX = 512;
/** Matches the ip_address columns — long enough for a full IPv6 address. */
const IP_MAX = 45;

/**
 * Rankvora AI sits behind two hops in production: an edge proxy, then frontend/server.cjs, which
 * APPENDS itself to X-Forwarded-For rather than overwriting it. So the header is a list, oldest
 * first, and the CLIENT is the leftmost entry:
 *
 *   X-Forwarded-For: <real client>, <edge proxy>, <server.cjs hop>
 *
 * Express's own `req.ip` respects `trust proxy`, which this app does not set — so it would report
 * the nearest hop, not the customer. Reading the header's first entry is what actually answers
 * "where did this person sign in from".
 *
 * CAVEAT, STATED PLAINLY: X-Forwarded-For is client-settable. A caller can put anything in it, so
 * this value is descriptive context on a security page, never an access-control input. Nothing in
 * this codebase makes a decision based on it.
 */
function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  const candidate = raw
    ? raw.split(',')[0]?.trim()
    // No proxy header: the socket address is the direct peer, which in local development IS the
    // client. In production this branch means the proxy chain did not forward, and recording the
    // loopback address would be misleading — so it is filtered below.
    : req.socket.remoteAddress;

  if (!candidate) return null;

  // Normalise the IPv4-mapped IPv6 form Node reports on dual-stack sockets (::ffff:203.0.113.4).
  const normalised = candidate.startsWith('::ffff:') ? candidate.slice('::ffff:'.length) : candidate;

  // Loopback tells the customer nothing about where they signed in from — it is the server
  // talking to itself. Better to record "unknown" than something that reads like a fact.
  if (normalised === '::1' || normalised === '127.0.0.1') return null;

  return normalised.slice(0, IP_MAX);
}

export function requestMetadata(req: Request): RequestMetadata {
  const agent = req.headers['user-agent'];
  return {
    ipAddress: clientIp(req),
    userAgent: typeof agent === 'string' && agent.trim() ? agent.trim().slice(0, USER_AGENT_MAX) : null,
  };
}
