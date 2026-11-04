import { api } from '../lib/api';
import type { FindingRow } from './api.types';
import { findingPillarScopes } from './findings.repository';
import { pillarList, pillarMeta } from './pillarMeta';
import type { PillarKey } from './dashboard/dashboard.types';

/**
 * ─── Header search ───────────────────────────────────────────────────
 *
 * TWO SOURCES, BOTH REAL, KEPT APART.
 *
 *   DESTINATIONS  Every page this app actually has. Built from the SAME catalogue the sidebar and
 *                 the router use (pillarMeta), so a sub-pillar cannot exist in navigation and be
 *                 missing from search, or vice versa. Matched in the browser, so it answers on the
 *                 keystroke with no request.
 *
 *   ISSUES        Findings from the store's most recent audit, matched by the SERVER through
 *                 GET /findings?search= — the same endpoint and the same latest-audit scoping the
 *                 dashboard uses. Nothing is matched against a cached copy here, so a result
 *                 can never describe an audit that has been superseded.
 *
 * NOTHING IS INVENTED WHEN THERE IS NOTHING TO SHOW. An empty query returns no results rather than
 * a list of "suggested" pages nobody asked for, and a findings request that fails is reported as a
 * failure — the destinations still answer, and the panel says the issues could not be searched
 * rather than implying the store has none matching.
 */

export type SearchGroup = 'Pages' | 'Issues';

export interface SearchResult {
  id: string;
  group: SearchGroup;
  /** What the merchant reads first. */
  title: string;
  /** Where it lives, or what it says. Never padded when there is nothing to add. */
  detail: string;
  /** In-app path. Always a path, never a URL — nothing here may become an off-site redirect. */
  to: string;
  /** Severity, for an issue. Absent on a destination. */
  severity?: FindingRow['severity'];
}

interface Destination {
  title: string;
  detail: string;
  to: string;
  /** Extra words that should match this page but do not appear in its title. */
  keywords: string[];
}

/**
 * The fixed pages, then every pillar and sub-pillar derived from the catalogue.
 *
 * The derived half is the point: eight SEO sub-pillars, five content, four speed and the rest are
 * real pages with real routes, and hand-listing them here is how search ends up two releases
 * behind the sidebar.
 */
const STATIC_PAGES: Destination[] = [
  { title: 'Dashboard', detail: 'Scores, priority issues and recommended actions', to: '/', keywords: ['home', 'overview', 'score'] },
  { title: 'Products', detail: 'Every product the latest audit checked, with what it is missing', to: '/products', keywords: ['catalog', 'catalogue', 'product', 'images', 'readiness'] },
  { title: 'Collections', detail: 'Every collection the latest audit checked, with what it is missing', to: '/collections', keywords: ['collection', 'category', 'categories', 'catalog'] },
  { title: 'Blog articles', detail: 'Every blog article the latest audit checked, with what it is missing', to: '/blog-articles', keywords: ['blog', 'article', 'articles', 'post', 'posts', 'content'] },
  { title: 'Integrations', detail: 'Shopify, Search Console, Analytics and PageSpeed', to: '/integrations', keywords: ['connect', 'shopify', 'google', 'api', 'pagespeed'] },
  { title: 'Reports', detail: 'How your scores have moved over time', to: '/reports', keywords: ['history', 'trend', 'export', 'csv'] },
  { title: 'Notifications', detail: 'Everything Rankvora AI has told you', to: '/notifications', keywords: ['alerts', 'bell'] },
  { title: 'Settings', detail: 'Profile, workspace and store, integrations, plan', to: '/settings', keywords: ['preferences', 'account', 'profile', 'workspace', 'store'] },
  { title: 'Guided setup', detail: 'Review or change your setup answers', to: '/onboarding', keywords: ['onboarding', 'wizard', 'setup'] },
];

const PILLAR_PAGES: Destination[] = pillarList.flatMap((pillar) => [
  {
    title: pillar.label,
    detail: `${pillar.label} pillar dashboard`,
    to: `/${pillar.key}`,
    keywords: [],
  },
  ...pillar.subPillars.map((sub) => ({
    title: sub.label,
    detail: `${pillar.label} · sub-pillar`,
    to: `/${pillar.key}/${sub.id}`,
    // The route slug is searchable too: someone who knows the url ("cwv", "dup-templated") should
    // not have to remember the label Rankvora AI gave it.
    keywords: [sub.id, pillar.label],
  })),
]);

const DESTINATIONS: Destination[] = [...STATIC_PAGES, ...PILLAR_PAGES];

/**
 * How well a destination matches, or 0 for not at all.
 *
 * Ranked rather than merely filtered, because "meta" should put "Meta descriptions" above
 * "Settings" even though both contain the letters. A title that STARTS with the query beats one
 * that merely contains it, and a keyword hit ranks below both — the merchant typed a page name far
 * more often than a synonym for one.
 */
function scoreDestination(destination: Destination, query: string): number {
  const title = destination.title.toLowerCase();
  if (title === query) return 100;
  if (title.startsWith(query)) return 80;
  if (title.includes(query)) return 60;
  if (destination.keywords.some((keyword) => keyword.toLowerCase().startsWith(query))) return 40;
  if (destination.keywords.some((keyword) => keyword.toLowerCase().includes(query))) return 30;
  if (destination.detail.toLowerCase().includes(query)) return 20;
  return 0;
}

/** Matching pages, best first. Pure and synchronous — this is why the panel answers instantly. */
export function searchDestinations(query: string, limit = 5): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  return DESTINATIONS
    .map((destination) => ({ destination, score: scoreDestination(destination, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.destination.title.localeCompare(b.destination.title))
    .slice(0, limit)
    .map(({ destination }): SearchResult => ({
      id: `page:${destination.to}`,
      group: 'Pages',
      title: destination.title,
      detail: destination.detail,
      to: destination.to,
    }));
}

/** Where an issue opens: its own sub-pillar page, which is where the evidence and the fix live. */
function findingTarget(finding: FindingRow): string {
  const pillar = finding.pillar as PillarKey;
  // A finding whose pillar is not one this build knows about still has to go somewhere it can be
  // acted on, rather than to a route that 404s.
  if (!pillarMeta[pillar]) return '/';
  return `/${pillar}/${finding.subPillar}`;
}

const SEVERITY_RANK: Record<FindingRow['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface FindingListResponse {
  items: FindingRow[];
  pagination: { total: number };
}

export interface FindingSearchOutcome {
  results: SearchResult[];
  /** Matches on the server, which can exceed what was returned — drives "see all N". */
  total: number;
}

/**
 * Issues matching the query, from the latest audit.
 *
 * Open and reviewed only is the SERVER's rule, not a filter applied here — the same one the Fix
 * Center list uses, so the two never disagree about what is outstanding.
 */
export async function searchFindings(query: string, limit = 5): Promise<FindingSearchOutcome> {
  const needle = query.trim();
  if (!needle) return { results: [], total: 0 };

  // One query per visible pillar when a pillar is hidden (see findingPillarScopes): the server's
  // total and its page limit would otherwise count the hidden pillar's matches. With nothing hidden
  // this is the single unscoped query it always was.
  const responses = await Promise.all(
    findingPillarScopes().map((scope) =>
      api.get<FindingListResponse>(`/findings?search=${encodeURIComponent(needle)}&limit=${limit}${scope}`),
    ),
  );
  const response: FindingListResponse = responses.length === 1
    ? responses[0]
    : {
        // Most severe first, then the most items affected — the order the API itself uses.
        items: responses
          .flatMap((entry) => entry.items)
          .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.affectedCount - a.affectedCount)
          .slice(0, limit),
        pagination: { total: responses.reduce((sum, entry) => sum + entry.pagination.total, 0) },
      };

  return {
    total: response.pagination.total,
    results: response.items.map((finding): SearchResult => ({
      id: `finding:${finding.id}`,
      group: 'Issues',
      title: finding.title,
      // The real count and the real pillar, as the audit recorded them. Nothing is summarised into
      // a phrase that could outlive the numbers behind it.
      detail: `${pillarMeta[finding.pillar as PillarKey]?.label ?? finding.pillar} · ${finding.affectedCount} ${finding.affectedLabel}`,
      to: findingTarget(finding),
      severity: finding.severity,
    })),
  };
}

// ─── The empty state ─────────────────────────────────────────────────

/**
 * What to offer before anything has been typed.
 *
 * REAL PAGES, NOT "POPULAR SEARCHES". Every entry is a route this app actually serves, taken from
 * the same catalogue as the sidebar. Calling them popular or trending would be a claim about what
 * other merchants do, and Rankvora AI measures nothing of the kind — so they are offered as what they
 * are: places to jump to.
 */
export function defaultDestinations(limit = 6): SearchResult[] {
  const shortlist = [
    ...STATIC_PAGES.filter((page) => ['/', '/integrations', '/reports', '/settings'].includes(page.to)),
    // The pillar dashboards, not their sub-pillars: twenty-eight rows is a menu, not a suggestion.
    ...PILLAR_PAGES.filter((page) => page.to.split('/').length === 2),
  ];

  return shortlist.slice(0, limit).map((destination): SearchResult => ({
    id: `page:${destination.to}`,
    group: 'Pages',
    title: destination.title,
    detail: destination.detail,
    to: destination.to,
  }));
}

// ─── Recent searches ─────────────────────────────────────────────────

/**
 * The merchant's OWN last few searches, kept in this browser.
 *
 * STARTS EMPTY AND STAYS EMPTY until they actually search — nothing is seeded, because a "recent"
 * list the merchant never typed is a fabricated history of their own behaviour, and the one thing
 * it would reliably teach them is that this list cannot be trusted.
 *
 * localStorage, deliberately: this is a per-browser convenience, not state the product depends on.
 * It is never read back by the server, never synced between devices, and every access is guarded —
 * a private window, blocked site data or a full quota all throw, and none of them may break search.
 */
const RECENT_KEY = 'scorelo:recent-searches';
const RECENT_LIMIT = 5;

export function recentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything that is not the shape written here is treated as absent rather than coerced — a
    // corrupted key is not a reason to render junk in a menu.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Records a search the merchant actually ran. Newest first, no duplicates, capped. */
export function rememberSearch(query: string): void {
  const value = query.trim();
  if (value.length < 2) return;
  try {
    const existing = recentSearches().filter((entry) => entry.toLowerCase() !== value.toLowerCase());
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([value, ...existing].slice(0, RECENT_LIMIT)));
  } catch {
    // A browser that will not store it simply has no history. Nothing else changes.
  }
}

export function clearRecentSearches(): void {
  try {
    window.localStorage.removeItem(RECENT_KEY);
  } catch {
    // Nothing to clear if it could not be written in the first place.
  }
}
