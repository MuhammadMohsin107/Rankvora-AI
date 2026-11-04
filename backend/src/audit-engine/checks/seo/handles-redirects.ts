import type { AuditCheck, Severity, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { HandleResourceType, SnapshotHandle, StoreSnapshot } from '../../store-data/types.js';
import { REDIRECTS_SCOPE } from '../../store-data/shopify.queries.js';
import { EVIDENCE_ROW_LIMIT, formatCount, takeEvidenceSample } from './page-inventory.js';

/**
 * ─── SEO · Handles & redirects ───────────────────────────────────────
 * Two separate things, kept separate:
 *
 * URL REDIRECTS — every UrlRedirect record the shop has (Shopify's complete, paginated list).
 *   Each is followed the way a visitor would be: through any further redirects, until it reaches a
 *   page, leaves the store, or comes back on itself. Shopify applies a redirect only to a path that
 *   would otherwise 404, so a live page at a path stops the walk — and a redirect whose own source
 *   is a live page never fires at all. Destinations are judged against the store's real handles:
 *   a redirect ending on a product, collection, page or article that does not exist, or is not
 *   published, sends visitors to an error page.
 *
 * HANDLES — the handle of every published product, collection, page and article. A handle is the
 *   resource's URL segment, not a redirect: nothing here assumes a changed handle left a redirect,
 *   or that a redirect means a handle changed.
 *
 * Nothing is inferred beyond what the data shows. A destination on another website, or on a path
 * that is not a store resource (a locale folder, a policy page), is counted and named as not
 * verified — never scored as working or as broken. A resource type whose handles could not be read
 * completely is never used to call a destination missing.
 */

const HEALTHY = 'Healthy';

type IssueKey = 'broken' | 'invalid' | 'loop' | 'inactive' | 'chain' | 'duplicate' | 'copyHandle' | 'handleFormat';

interface IssueDefinition {
  status: string;
  severity: Severity;
  resolutionType: 'settings' | 'content';
  title: string;
  why: string;
  recommendation: string;
  noun: 'redirects' | 'handles';
  problem: (count: number) => string;
}

/** Worst first — a row shows its first issue in this order, and findings are raised in it. */
const ISSUE_ORDER: IssueKey[] = ['broken', 'invalid', 'loop', 'inactive', 'chain', 'duplicate', 'copyHandle', 'handleFormat'];

const REDIRECTS_ADMIN = 'Online Store → Navigation → URL redirects';

const ISSUES: Record<IssueKey, IssueDefinition> = {
  broken: {
    status: 'Broken Redirect',
    severity: 'critical',
    resolutionType: 'settings',
    noun: 'redirects',
    title: 'Redirects that end on a page that does not exist',
    problem: (count) => `${formatCount(count)} redirects send visitors to a product, collection, page or article that does not exist in your store or is not published.`,
    why: 'A visitor following an old link — or a search engine re-crawling it — lands on an error page. The ranking the old URL earned is lost instead of passed on.',
    recommendation: `Point each one at a live page that replaces what the old URL offered, or delete it (${REDIRECTS_ADMIN}).`,
  },
  invalid: {
    status: 'Invalid Target',
    severity: 'high',
    resolutionType: 'settings',
    noun: 'redirects',
    title: 'Redirects whose target is not a usable address',
    problem: (count) => `${formatCount(count)} redirects have a target that is empty or is not a web address a browser can follow.`,
    why: 'A redirect with no usable destination cannot send the visitor anywhere, so the old URL behaves as broken.',
    recommendation: `Give each one a full path starting with “/” or a complete URL (${REDIRECTS_ADMIN}).`,
  },
  loop: {
    status: 'Redirect Loop',
    severity: 'high',
    resolutionType: 'settings',
    noun: 'redirects',
    title: 'Redirects that loop back on themselves',
    problem: (count) => `${formatCount(count)} redirects lead back to a path already visited, so they never reach a page.`,
    why: 'Browsers stop after a few rounds and show an error; search engines drop the URL. Nobody following the old link reaches anything.',
    recommendation: `Break the loop: point one redirect in each loop at a live page, and delete the rest (${REDIRECTS_ADMIN}).`,
  },
  inactive: {
    status: 'Inactive Redirect',
    severity: 'medium',
    resolutionType: 'settings',
    noun: 'redirects',
    title: 'Redirects that never apply because a live page owns the path',
    problem: (count) => `${formatCount(count)} redirects start at a path where a live page exists, so Shopify never applies them.`,
    why: 'Shopify only redirects a path that would otherwise show a 404. These records look like they send traffic somewhere, but visitors still see the live page at the old path.',
    recommendation: `If the live page should stay, delete the redirect. If traffic should move, unpublish or rename the page first — then the redirect takes effect (${REDIRECTS_ADMIN}).`,
  },
  chain: {
    status: 'Redirect Chain',
    severity: 'medium',
    resolutionType: 'settings',
    noun: 'redirects',
    title: 'Redirects that pass through another redirect',
    problem: (count) => `${formatCount(count)} redirects take visitors through two or more hops before they reach a page.`,
    why: 'Every extra hop is another round trip before the page starts loading, and search engines may stop following a chain before its end.',
    recommendation: `Point each redirect straight at its final destination — the “Point it straight at” value on each row (${REDIRECTS_ADMIN}).`,
  },
  duplicate: {
    status: 'Duplicate Source',
    severity: 'medium',
    resolutionType: 'settings',
    noun: 'redirects',
    title: 'More than one redirect for the same path',
    problem: (count) => `${formatCount(count)} redirects share their source path with another redirect.`,
    why: 'Only one of them can apply. Which one is not under your control, and the others are dead records that make the list harder to maintain.',
    recommendation: `Keep one redirect per path and delete the others (${REDIRECTS_ADMIN}).`,
  },
  copyHandle: {
    status: 'Copy Handle',
    severity: 'medium',
    resolutionType: 'content',
    noun: 'handles',
    title: 'Published pages still using a “copy-of” handle',
    problem: (count) => `${formatCount(count)} published pages have a handle beginning “copy-of-” — the handle Shopify gives a duplicated item.`,
    why: 'The handle is the page’s URL. “copy-of-…” tells shoppers and search engines nothing, and marks the page as an unedited duplicate. The longer it stays, the more links point at it, and the costlier it is to change.',
    recommendation: 'Give each a descriptive handle (Search engine listing → URL handle in the item’s Shopify editor) and leave “Create a URL redirect” ticked so the old address keeps working.',
  },
  handleFormat: {
    status: 'Handle Formatting',
    severity: 'low',
    resolutionType: 'content',
    noun: 'handles',
    title: 'Handles with uppercase letters or underscores',
    problem: (count) => `${formatCount(count)} published pages have a handle containing uppercase letters or underscores.`,
    why: 'URLs are conventionally lowercase with hyphens between words. Search engines read a hyphen as a word break but an underscore as joining two words, and mixed case invites duplicate URLs that differ only in case.',
    recommendation: 'Rename to lowercase words separated by hyphens — the suggested handle on each row — and keep “Create a URL redirect” ticked when you save.',
  },
};

const FACET: Record<HandleResourceType, string> = { product: 'Product', collection: 'Collection', page: 'Page', article: 'Blog' };

/** Paths every Shopify storefront serves. Anything else that is not a resource is not verified. */
const SYSTEM_PATHS = new Set(['/', '/cart', '/search', '/collections', '/collections/all']);

/** A path as Shopify compares it: decoded, lowercase, no trailing slash. The query is kept. */
function normalizePath(raw: string): string {
  const [pathPart = '', ...queryParts] = raw.split('?');
  let path = pathPart;
  try {
    path = decodeURIComponent(pathPart);
  } catch {
    // Malformed encoding: compare as written.
  }
  path = path.trim().toLowerCase();
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  return queryParts.length > 0 ? `${path}?${queryParts.join('?')}` : path;
}

const withoutQuery = (path: string) => path.split('?')[0] ?? path;

type Target = { kind: 'internal'; path: string } | { kind: 'external'; url: string } | { kind: 'invalid' };

/** Where a redirect target points: a path on this store, another website, or nowhere usable. */
function resolveTarget(raw: string, storeHosts: Set<string>): Target {
  const target = raw.trim();
  if (!target) return { kind: 'invalid' };
  if (target.startsWith('/') && !target.startsWith('//')) return { kind: 'internal', path: target };
  try {
    const url = new URL(target.startsWith('//') ? `https:${target}` : target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'invalid' };
    const host = url.host.toLowerCase().replace(/^www\./, '');
    if (storeHosts.has(host)) return { kind: 'internal', path: `${url.pathname}${url.search}` };
    return { kind: 'external', url: url.toString() };
  } catch {
    return { kind: 'invalid' };
  }
}

type Destination =
  | { state: 'live' }
  | { state: 'missing'; type: HandleResourceType; handle: string }
  | { state: 'unpublished'; resource: SnapshotHandle }
  | { state: 'unverified'; why: string };

export const handlesRedirectsCheck: AuditCheck = {
  id: 'seo.handles-redirects',
  pillar: 'seo',
  subPillar: 'handles-redirects',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const redirects = snapshot.redirects;
    if (!redirects.available) {
      if (redirects.reason === 'scope') {
        // Not a successful audit and not an empty one: the page shows this reason and offers the
        // existing Shopify re-approval flow, named by `requiredScope`.
        const result = unavailableResult(
          'handles-redirects',
          `Shopify did not let Rankvora AI read your URL redirects: reading them needs the “${REDIRECTS_SCOPE}” permission, which this store's connection was not granted. Grant access in Shopify, then run the audit again. Nothing on this page is scored until then.`,
        );
        return { ...result, details: { ...result.details, requiredScope: REDIRECTS_SCOPE } };
      }
      return unavailableResult(
        'handles-redirects',
        `Shopify returned an error while Rankvora AI was reading your URL redirects, so this check could not run and nothing on this page is scored. Run the audit again; if it keeps failing, check the Shopify connection on Integrations. (${redirects.detail})`,
      );
    }

    const index = snapshot.handleIndex;
    const storeHosts = new Set<string>();
    for (const value of [snapshot.shop.primaryUrl, `https://${snapshot.shop.domain}`]) {
      try {
        storeHosts.add(new URL(value).host.toLowerCase().replace(/^www\./, ''));
      } catch {
        // An unparseable shop URL adds no host; its redirects are then treated as external.
      }
    }

    // ── Resources by storefront path ──
    const byPath = new Map<string, SnapshotHandle>();
    const blogs = new Set<string>();
    for (const resource of index?.handles ?? []) {
      const handle = resource.handle.toLowerCase();
      if (resource.type === 'product') byPath.set(`/products/${handle}`, resource);
      else if (resource.type === 'collection') byPath.set(`/collections/${handle}`, resource);
      else if (resource.type === 'page') byPath.set(`/pages/${handle}`, resource);
      else if (resource.blogHandle) {
        byPath.set(`/blogs/${resource.blogHandle.toLowerCase()}/${handle}`, resource);
        if (resource.published !== false) blogs.add(resource.blogHandle.toLowerCase());
      }
    }
    const complete = (type: HandleResourceType) => index?.complete[type] === true;

    /** What a path on this store resolves to, judged only against data that is complete. */
    const destinationOf = (rawPath: string): Destination => {
      const path = withoutQuery(normalizePath(rawPath));
      if (SYSTEM_PATHS.has(path)) return { state: 'live' };
      const match =
        /^\/products\/([^/]+)$/.exec(path) ? { type: 'product' as const, key: path }
          : /^\/collections\/[^/]+\/products\/([^/]+)$/.exec(path) ? { type: 'product' as const, key: `/products/${path.split('/').pop()}` }
            : /^\/collections\/([^/]+)$/.exec(path) ? { type: 'collection' as const, key: path }
              : /^\/pages\/([^/]+)$/.exec(path) ? { type: 'page' as const, key: path }
                : /^\/blogs\/[^/]+\/[^/]+$/.exec(path) && !path.includes('/tagged/') ? { type: 'article' as const, key: path }
                  : null;
      if (!match) {
        if (/^\/blogs\/([^/]+)$/.test(path) && blogs.has(path.split('/')[2]!)) return { state: 'live' };
        // /apps/… is an app proxy: an installed app answers it, and nothing in the store's data
        // says what it serves. Named as such so the merchant knows why it was not judged.
        if (path === '/apps' || path.startsWith('/apps/')) return { state: 'unverified', why: 'app' };
        return { state: 'unverified', why: 'other' };
      }
      const resource = byPath.get(match.key);
      if (resource) return resource.published === false ? { state: 'unpublished', resource } : { state: 'live' };
      if (!complete(match.type)) return { state: 'unverified', why: `incomplete:${match.type}` };
      return { state: 'missing', type: match.type, handle: match.key.split('/').pop()! };
    };
    /**
     * True only when a page is KNOWN to be served at this path: a system page, or a resource Shopify
     * says is published. A collection exists but carries no publication state, so it does not
     * count — calling a redirect inactive, or stopping a route, on a guess would be a false claim.
     */
    const isDefinitelyLive = (rawPath: string) => {
      const path = withoutQuery(normalizePath(rawPath));
      if (SYSTEM_PATHS.has(path)) return true;
      const key = /^\/collections\/[^/]+\/products\/([^/]+)$/.test(path) ? `/products/${path.split('/').pop()}` : path;
      return byPath.get(key)?.published === true;
    };

    // ── Redirects ──
    const bySource = new Map<string, typeof redirects.items>();
    for (const redirect of redirects.items) {
      const key = normalizePath(redirect.path);
      bySource.set(key, [...(bySource.get(key) ?? []), redirect]);
    }

    const rows: SubPillarEvidenceRow[] = [];
    const rowsByIssue = new Map<IssueKey, SubPillarEvidenceRow[]>();
    let healthy = 0;
    let external = 0;
    const unverifiedWhy = new Map<string, number>();

    const record = (row: Omit<SubPillarEvidenceRow, 'status'>, issues: Set<IssueKey>) => {
      const primary = ISSUE_ORDER.find((key) => issues.has(key)) ?? null;
      const full: SubPillarEvidenceRow = { ...row, status: primary ? ISSUES[primary].status : HEALTHY };
      if (!primary) healthy += 1;
      rows.push(full);
      for (const issue of issues) rowsByIssue.set(issue, [...(rowsByIssue.get(issue) ?? []), full]);
    };

    for (const redirect of redirects.items) {
      const issues = new Set<IssueKey>();
      const source = normalizePath(redirect.path);
      if ((bySource.get(source)?.length ?? 0) > 1) issues.add('duplicate');

      let meta = '';
      let hops: number | null = null;
      let route = [redirect.path];
      let straightTo: string | null = null;

      if (isDefinitelyLive(redirect.path)) {
        // Never fires, so where it would have gone does not affect anyone.
        issues.add('inactive');
        meta = `A live page exists at ${redirect.path}, so Shopify serves that page and never applies this redirect.`;
      } else {
        const first = resolveTarget(redirect.target, storeHosts);
        if (first.kind === 'invalid') {
          issues.add('invalid');
          meta = `The target “${redirect.target}” is not a usable address.`;
        } else {
          // Follow it the way a visitor would.
          const visited = new Set([source]);
          let current: Target = first;
          hops = 1;
          for (;;) {
            if (current.kind === 'external') {
              route = [...route, current.url];
              external += 1;
              meta = hops > 1 ? `Leaves your store for ${current.url} after ${hops} hops. Rankvora AI does not check other websites.` : `Sends visitors to another website (${current.url}). Rankvora AI does not check other websites.`;
              if (hops > 1) {
                issues.add('chain');
                straightTo = current.url;
              }
              break;
            }
            if (current.kind === 'invalid') {
              issues.add('broken');
              meta = `After ${hops - 1} hop(s) the route reaches a redirect whose target is not a usable address.`;
              break;
            }
            const path = current.path;
            route = [...route, path];
            const key = normalizePath(path);
            if (visited.has(key)) {
              issues.add('loop');
              meta = hops === 1 ? 'The redirect points at its own path.' : `After ${hops} hops the route returns to ${path}, which it has already passed through.`;
              break;
            }
            const next = bySource.get(key)?.[0];
            if (isDefinitelyLive(path) || !next) {
              const destination = destinationOf(path);
              if (destination.state === 'missing') {
                issues.add('broken');
                meta = `Ends at ${path} — your store has no ${destination.type} with the handle “${destination.handle}”.`;
              } else if (destination.state === 'unpublished') {
                issues.add('broken');
                meta = `Ends at ${path} — “${destination.resource.title.trim() || destination.resource.handle}” exists but is not published, so visitors get a 404.`;
              } else if (destination.state === 'unverified') {
                unverifiedWhy.set(destination.why, (unverifiedWhy.get(destination.why) ?? 0) + 1);
                meta = destination.why === 'app'
                  ? `Ends at ${path}, an app page served by an app installed on your store. Rankvora AI cannot see what an app serves, so this was not judged.`
                  : destination.why === 'other'
                    ? `Ends at ${path}, which is not a product, collection, page or article, so Rankvora AI could not check it and did not judge it.`
                    : `Ends at ${path}. Not every ${destination.why.replace('incomplete:', '')} could be read from Shopify, so Rankvora AI did not judge whether it exists.`;
              } else {
                meta = hops === 1 ? `Sends visitors straight to ${path}, a live page.` : `Reaches ${path}, a live page, after ${hops} hops.`;
              }
              if (hops > 1 && !issues.has('broken')) {
                issues.add('chain');
                straightTo = path;
              }
              break;
            }
            visited.add(key);
            current = resolveTarget(next.target, storeHosts);
            hops += 1;
          }
        }
      }

      record({
        id: `redirect:${redirect.id}`,
        facet: 'Redirect',
        cells: { path: redirect.path, label: 'URL redirect', target: redirect.target, hops, kind: 'Redirect' },
        current: { label: 'Route', value: route.join('  →  '), meta: meta! },
        ...(straightTo ? { suggested: { label: 'Point it straight at', value: straightTo } } : {}),
      }, issues);
    }

    // ── Handles ──
    let published = 0;
    let unpublished = 0;
    const takenByScope = new Set((index?.handles ?? []).map((resource) => `${resource.type}:${resource.blogHandle ?? ''}:${resource.handle.toLowerCase()}`));
    for (const resource of index?.handles ?? []) {
      if (resource.published === false) { unpublished += 1; continue; }
      published += 1;
      const issues = new Set<IssueKey>();
      const path = resource.type === 'product' ? `/products/${resource.handle}`
        : resource.type === 'collection' ? `/collections/${resource.handle}`
          : resource.type === 'page' ? `/pages/${resource.handle}`
            : `/blogs/${resource.blogHandle}/${resource.handle}`;

      let suggested: SubPillarEvidenceRow['suggested'];
      if (/^copy-of-/i.test(resource.handle)) issues.add('copyHandle');
      if (/[A-Z_]/.test(resource.handle)) {
        issues.add('handleFormat');
        const cleaned = resource.handle.toLowerCase().replace(/_+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
        // Only suggested when it is free — a suggestion that collides would fail in Shopify.
        if (cleaned && !takenByScope.has(`${resource.type}:${resource.blogHandle ?? ''}:${cleaned}`)) {
          suggested = { label: 'Suggested handle', value: cleaned };
        }
      }

      record({
        id: `${resource.type}:${resource.id}`,
        facet: FACET[resource.type],
        cells: { path, label: resource.title.trim() || null, target: null, hops: null, kind: FACET[resource.type] },
        current: { label: 'Handle', value: resource.handle, meta: `${FACET[resource.type]} · ${resource.title.trim() || 'untitled'}` },
        ...(suggested ? { suggested } : {}),
      }, issues);
    }

    const incomplete = (['product', 'collection', 'page', 'article'] as const).filter((type) => !complete(type));
    const analyzed = rows.length;
    const redirectCount = redirects.items.length;

    if (analyzed === 0) {
      if (!index || incomplete.length === 4) {
        return unavailableResult('handles-redirects', 'Your store has no URL redirects, and Rankvora AI could not read your products, collections, pages or articles to check their handles.');
      }
    }

    // ── Findings, worst first ──
    const findings: SubPillarFindingResult[] = [];
    for (const key of ISSUE_ORDER) {
      const affected = rowsByIssue.get(key) ?? [];
      if (affected.length === 0) continue;
      const issue = ISSUES[key];
      const population = issue.noun === 'redirects' ? redirectCount : published;
      findings.push({
        title: issue.title,
        severity: issue.severity,
        affectedCount: affected.length,
        affectedLabel: issue.noun,
        scoreLift: analyzed > 0 ? Math.round((affected.length / analyzed) * 100) : 0,
        resolutionType: issue.resolutionType,
        problem: issue.problem(affected.length),
        why: issue.why,
        recommendation: issue.recommendation,
        evidence: [
          `${formatCount(affected.length)} of ${formatCount(population)} ${issue.noun === 'redirects' ? 'URL redirects' : 'published handles'}.`,
          ...affected.slice(0, 5).map((row) => (issue.noun === 'redirects' ? `${row.cells.path} — ${row.current?.meta ?? ''}` : `${row.cells.path} (${row.cells.kind})`)),
        ],
        evidenceRows: affected.slice(0, EVIDENCE_ROW_LIMIT),
        details: { issueType: issue.status },
      });
    }

    // ── Summary: what was read, and what was not judged ──
    const parts: string[] = [];
    parts.push(analyzed > 0
      ? `${formatCount(healthy)} of ${formatCount(analyzed)} redirects and handles show no problem.`
      : 'There was nothing to check.');
    parts.push(redirectCount === 0
      ? 'Your store has no URL redirects.'
      : `Read all ${formatCount(redirectCount)} URL redirects in your store${redirects.truncated ? ' that Shopify returned before its list stopped advancing' : ''}.`);
    parts.push(`Checked the handles of ${formatCount(published)} published products, collections, pages and articles.`);
    const redirectsWord = (n: number) => `${formatCount(n)} ${n === 1 ? 'redirect' : 'redirects'}`;
    if (external > 0) parts.push(`${redirectsWord(external)} ${external === 1 ? 'leads' : 'lead'} to other websites, which Rankvora AI does not check.`);
    // One plain sentence per reason, so the merchant reads WHY each group was not judged.
    for (const [why, n] of unverifiedWhy) {
      if (why === 'app') parts.push(`${redirectsWord(n)} ${n === 1 ? 'goes' : 'go'} to app pages (/apps/…) served by an app installed on your store; Rankvora AI cannot see what an app serves, so ${n === 1 ? 'it was' : 'they were'} not judged.`);
      else if (why === 'other') parts.push(`${redirectsWord(n)} ${n === 1 ? 'ends' : 'end'} on a path that is not a product, collection, page or article (for example a policy page or a language folder), so ${n === 1 ? 'it was' : 'they were'} not judged.`);
      else parts.push(`${redirectsWord(n)} ${n === 1 ? 'ends' : 'end'} on a ${why.replace('incomplete:', '')} Rankvora AI could not confirm, because not every one could be read from Shopify.`);
    }
    if (incomplete.length > 0) {
      const detail = incomplete.map((type) => `${type}s${index?.gaps[type] ? ` (${index.gaps[type]})` : ''}`).join(', ');
      parts.push(`Not every handle could be read for ${detail}, so no destination of that type was called missing.`);
    }
    if (unpublished > 0) parts.push(`${formatCount(unpublished)} unpublished ${unpublished === 1 ? 'item was' : 'items were'} not checked — ${unpublished === 1 ? 'it is' : 'they are'} not on your storefront.`);

    return {
      subPillar: 'handles-redirects',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: parts.join(' '),
        healthChip: analyzed > 0 ? `${((healthy / analyzed) * 100).toFixed(1)}% healthy` : 'Nothing to check',
        contextLabel: 'URL redirects',
        contextValue: formatCount(redirectCount),
        healthyStatus: HEALTHY,
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
