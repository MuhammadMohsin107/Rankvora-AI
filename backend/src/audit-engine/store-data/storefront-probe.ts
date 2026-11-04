import type { SnapshotStorefront, StorefrontProbe } from './types.js';

/**
 * ─── Storefront reachability probes ──────────────────────────────────
 * Three small, read-only GETs against the merchant's public storefront, run ONCE per snapshot.
 * Every crawl-dependent check consumes these results instead of fetching for itself, which
 * keeps checks pure (no network) and means a password-protected storefront is detected in one
 * place with one unambiguous signal.
 *
 * This is deliberately NOT the full crawler (audit-engine/storefront/crawler.ts) — that exists
 * for page-level analysis once the storefront is reachable. These probes answer a smaller
 * question: CAN it be reached at all, and are robots.txt / sitemap.xml present.
 */

const PROBE_TIMEOUT_MS = 12_000;
const USER_AGENT = 'ScoreloAuditBot/1.0 (+https://scorelo.app/bot)';

async function probe(url: string, captureBody: boolean): Promise<StorefrontProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,application/xml;q=0.9,*/*;q=0.8' },
    });
    // Shopify's storefront gate answers with a redirect chain ending at /password.
    const passwordGated = new URL(response.url).pathname === '/password';
    const body = captureBody && response.ok ? (await response.text()).slice(0, 65_536) : undefined;
    return { status: response.status, passwordGated, body };
  } catch {
    // Network failure is status 0 — "could not look", which checks report as unavailable.
    return { status: 0, passwordGated: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeStorefront(origin: string): Promise<SnapshotStorefront> {
  const [homepage, robots, sitemap] = await Promise.all([
    probe(`${origin}/`, false),
    probe(`${origin}/robots.txt`, true),
    probe(`${origin}/sitemap.xml`, true),
  ]);
  return {
    homepage,
    robots,
    sitemap,
    passwordProtected: homepage.passwordGated || robots.passwordGated || sitemap.passwordGated,
  };
}
