/**
 * ─── Which proxy hops Express believes ───────────────────────────────
 *
 * Rankvora AI is never reached directly in production: a browser talks to the edge proxy, which
 * talks to frontend/server.cjs, which forwards /api to this process over loopback. Every request
 * therefore ARRIVES from 127.0.0.1, and unless Express is told which hops to believe, `req.ip` is
 * that loopback address for every caller on earth.
 *
 * That is not cosmetic. The rate limiters key on `req.ip`, so without this one bucket was shared
 * by every visitor: ten sign-ins in fifteen minutes from ANYONE locked EVERYONE out.
 *
 * The default trusts loopback hops only. With the chain
 *
 *   X-Forwarded-For: <anything the caller typed>, <real client>, <loopback hop>
 *
 * Express walks in from the right, skips the loopback hops it trusts, and stops at the first
 * address it does not — the real client. Whatever the caller typed further left is never reached,
 * so a caller cannot choose their own rate-limit bucket by sending an X-Forwarded-For of their own.
 * Trusting everything (`true`) would let them, so it is refused.
 *
 * TRUST_PROXY overrides the default for a deployment whose proxies are not on loopback:
 *   unset / blank   loopback
 *   false           trust no proxy header at all (the socket's own address is the caller)
 *   2               trust exactly that many hops in from this process
 *   10.0.0.0/8,...  trust these addresses, ranges or Express keywords (loopback, linklocal, uniquelocal)
 */
export type TrustProxySetting = false | number | string;

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim();
  if (!value) return 'loopback';
  if (value === 'false') return false;
  if (value === 'true') {
    throw new Error(
      'TRUST_PROXY=true would believe any X-Forwarded-For a caller sends, which lets them pick their own rate-limit bucket. '
      + 'Use a hop count (e.g. 2) or the proxies\' addresses instead.',
    );
  }
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
