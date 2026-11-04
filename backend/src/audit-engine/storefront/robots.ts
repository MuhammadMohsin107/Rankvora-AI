/**
 * robots.txt parsing — the crawler's permission layer.
 *
 * Rankvora AI crawls a merchant's own store with their consent, but it still honours robots.txt:
 * a merchant who has disallowed a path has expressed an intent about automated traffic, and a
 * tool that ignores that is one misconfiguration away from hammering a URL space the merchant
 * deliberately fenced off (faceted collection filters, search results, cart URLs).
 *
 * Implements the subset of the spec that actually governs behaviour here: User-agent grouping,
 * Allow/Disallow with longest-match-wins, Crawl-delay, and Sitemap discovery. Wildcards (`*`)
 * and end-anchors (`$`) are supported because Shopify's own default robots.txt uses both.
 */

export interface RobotsRules {
  /** Longest-match-wins rule list, already narrowed to the group matching our user-agent. */
  rules: Array<{ allow: boolean; pattern: string }>;
  /** Seconds the host asked crawlers to wait between requests, if stated. */
  crawlDelaySeconds: number | null;
  /** Absolute sitemap URLs declared in robots.txt. */
  sitemaps: string[];
  /** False when robots.txt could not be fetched — the crawler then proceeds with defaults. */
  fetched: boolean;
}

export const EMPTY_ROBOTS: RobotsRules = { rules: [], crawlDelaySeconds: null, sitemaps: [], fetched: false };

/** Converts a robots path pattern into an anchored RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  // Escape everything regex-significant except '*', which robots.txt defines as "any sequence".
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`);
}

/**
 * Parses robots.txt, keeping the rule group that applies to `userAgent`.
 * A specific group wins over `*`, matching the spec's "most specific group" rule.
 */
export function parseRobots(text: string, userAgent: string): Omit<RobotsRules, 'fetched'> {
  const lowerAgent = userAgent.toLowerCase();
  const groups: Array<{ agents: string[]; rules: RobotsRules['rules']; crawlDelay: number | null }> = [];
  const sitemaps: string[] = [];

  let current: (typeof groups)[number] | null = null;
  // True while consecutive User-agent lines are still accumulating into the same group.
  let collectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    collectingAgents = false;

    if (field === 'disallow') {
      // An empty Disallow means "allow everything" and carries no pattern.
      if (value) current.rules.push({ allow: false, pattern: value });
    } else if (field === 'allow') {
      if (value) current.rules.push({ allow: true, pattern: value });
    } else if (field === 'crawl-delay') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) current.crawlDelay = parsed;
    }
  }

  const specific = groups.find((group) => group.agents.some((agent) => agent !== '*' && lowerAgent.includes(agent)));
  const wildcard = groups.find((group) => group.agents.includes('*'));
  const chosen = specific ?? wildcard;

  return {
    rules: chosen?.rules ?? [],
    crawlDelaySeconds: chosen?.crawlDelay ?? null,
    sitemaps,
  };
}

/**
 * Longest-match-wins, per the spec: the most specific rule decides, and Allow beats Disallow
 * when both match at the same length. With no rules at all, everything is allowed.
 */
export function isAllowed(robots: RobotsRules, pathname: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of robots.rules) {
    if (!patternToRegExp(rule.pattern).test(pathname)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}
