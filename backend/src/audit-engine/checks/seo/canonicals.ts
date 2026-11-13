import type { AuditCheck, Severity, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import type { CrawledPage, StorefrontCrawl } from '../../storefront/types.js';
import { comparableFromString, comparableUrl, resolveCanonical } from '../../storefront/canonical-url.js';
import { decodeEntities } from '../../storefront/html-parser.js';
import { crawlScopeNote, crawlUnavailableSentence, pageName } from '../shared/crawl.js';
import { pushInto } from '../shared/collect.js';
import { EVIDENCE_ROW_LIMIT, formatCount, pathOf, takeEvidenceSample } from './page-inventory.js';

/**
 * ─── SEO · Canonicals & duplicates ───────────────────────────────────
 * Two measurements, each from the only source that can answer it:
 *
 * 1. RENDERED CANONICAL TAGS — from the storefront crawl. What `<link rel="canonical">` a page
 *    carries is decided by the theme and apps at render time; the Admin API cannot see it. Every
 *    page the crawl loaded is checked for a missing, empty, conflicting, off-domain or
 *    elsewhere-pointing canonical, and a canonical that points elsewhere is requested to see
 *    whether its target loads, redirects or is broken. The crawl is a bounded sample, and the
 *    summary says exactly how many pages it covered — nothing is extrapolated to pages it did not
 *    load.
 *
 * 2. DUPLICATE PAGES — from Admin data, across every PUBLISHED product, collection, page and
 *    article. When a resource is created or duplicated under a handle that is taken, Shopify
 *    appends `-1`, `-2`, …. Pages of one type whose handles differ only by that suffix, AND that
 *    carry the same description or the same title, are copies competing with each other.
 *
 *    Both conditions are required, and that is deliberate. A `-N` suffix alone is how merchants
 *    name sizes, strengths and model years — `whey-protein-2` and `whey-protein-5`, `iphone-15` —
 *    and those are different products with different copy. Matching content is what separates a
 *    copy from a sibling. It has to be the description OR the title: a store that duplicates a
 *    product and numbers the copy's title ("Formula", "Formula 1", "Formula 2") keeps the body
 *    word for word, while one that re-creates a product keeps the title. A description too short
 *    to identify anything is never treated as a match. Unpublished resources are skipped: they are
 *    not on the storefront and cannot compete for anything.
 *
 * A duplicate that canonicalises onto its original has been consolidated — that is the fix — so
 * it is not reported, when the crawl loaded it and could see that.
 */

const HEALTHY = 'Healthy';

type IssueKey =
  | 'targetBroken'
  | 'invalid'
  | 'conflicting'
  | 'missing'
  | 'offDomain'
  | 'duplicate'
  | 'elsewhere'
  | 'targetRedirects'
  | 'repeated';

interface IssueDefinition {
  status: string;
  severity: Severity;
  resolutionType: 'theme' | 'content';
  title: string;
  why: string;
  recommendation: string;
  /** "{n} pages …" — completes the problem statement. */
  problem: (count: number) => string;
}

/**
 * Worst first. A page with more than one problem is listed under the first of its issues in this
 * order, and findings are raised in the same order, so a row's own status always names the
 * finding it opens.
 */
const ISSUE_ORDER: IssueKey[] = [
  'targetBroken',
  'invalid',
  'conflicting',
  'missing',
  'offDomain',
  'duplicate',
  'elsewhere',
  'targetRedirects',
  'repeated',
];

const THEME_FIX = 'The standard Shopify tag is `<link rel="canonical" href="{{ canonical_url }}">` inside <head> in layout/theme.liquid.';

const ISSUES: Record<IssueKey, IssueDefinition> = {
  targetBroken: {
    status: 'Canonical Target Broken',
    severity: 'critical',
    resolutionType: 'theme',
    title: 'Canonical tags pointing at pages that do not load',
    problem: (count) => `${formatCount(count)} pages declare a canonical URL that answered with an error when Rankvora AI requested it.`,
    why: 'A canonical is an instruction to index a different URL instead of this one. When that URL is broken, search engines are told to drop a working page in favour of a missing one — the page can fall out of results entirely.',
    recommendation: `Point each canonical back at the page itself, or at a URL that loads. ${THEME_FIX} An app or a hardcoded tag overriding it is the usual cause.`,
  },
  invalid: {
    status: 'Invalid Canonical',
    severity: 'high',
    resolutionType: 'theme',
    title: 'Canonical tags with an empty or unusable URL',
    problem: (count) => `${formatCount(count)} pages carry a canonical tag whose href is empty or is not a web address.`,
    why: 'Search engines discard a canonical they cannot read, so these pages have no canonical at all — while looking, to anyone reading the theme, as though they do.',
    recommendation: `Give the tag a real URL. ${THEME_FIX}`,
  },
  conflicting: {
    status: 'Conflicting Canonicals',
    severity: 'high',
    resolutionType: 'theme',
    title: 'Pages declaring more than one canonical URL',
    problem: (count) => `${formatCount(count)} pages carry several canonical tags that name different URLs.`,
    why: 'Given conflicting canonicals, Google ignores all of them and chooses the URL itself — the page ends up with no canonical signal, and duplicate URLs of it are no longer consolidated.',
    recommendation: `Keep exactly one canonical tag. Two usually means the theme outputs one and an SEO app adds another; remove one of them. ${THEME_FIX}`,
  },
  missing: {
    status: 'Missing Canonical',
    severity: 'high',
    resolutionType: 'theme',
    title: 'Pages with no canonical tag in <head>',
    problem: (count) => `${formatCount(count)} pages render no canonical tag in <head>.`,
    why: 'Shopify serves every product under several URLs — /products/…, /collections/…/products/…, with ?variant= and tracking parameters. The canonical tag is what tells search engines they are one page. Without it, ranking signals split across the copies.',
    recommendation: `Add the canonical tag to the theme. ${THEME_FIX} A canonical placed after </head> does not count — search engines ignore it there.`,
  },
  offDomain: {
    status: 'Off-Domain Canonical',
    severity: 'high',
    resolutionType: 'theme',
    title: 'Canonical tags pointing at another domain or protocol',
    problem: (count) => `${formatCount(count)} pages declare a canonical URL on a different domain or protocol than the page itself.`,
    why: 'The canonical tells search engines which address to index. Pointing it at another host — often the .myshopify.com domain — or at http:// sends that signal to an address customers are not meant to land on.',
    recommendation: `Make the canonical use your primary domain over https. Shopify's {{ canonical_url }} does this automatically once the primary domain is set under Settings → Domains; a hardcoded tag or an app is the usual cause. ${THEME_FIX}`,
  },
  duplicate: {
    status: 'Duplicate Handle',
    severity: 'high',
    resolutionType: 'content',
    title: 'Duplicated pages under suffixed handles',
    problem: (count) => `${formatCount(count)} published pages are copies: same description or same title as another page of the same type, under the same handle with “-N” appended — the pattern Shopify creates when a resource is duplicated or re-created.`,
    why: 'Each copy is a near-identical page competing with its siblings for the same searches. Search engines typically index one and suppress the rest, and which one wins is out of your control.',
    recommendation: 'For each group, keep one page, then delete the copies or redirect them to it under Online Store → Navigation → URL redirects. If a copy has to stay, make its canonical point at the original.',
  },
  elsewhere: {
    status: 'Canonicalised Elsewhere',
    severity: 'medium',
    resolutionType: 'theme',
    title: 'Pages whose canonical names a different page',
    problem: (count) => `${formatCount(count)} pages declare a canonical URL other than their own.`,
    why: 'A canonical pointing elsewhere asks search engines to index that other URL instead of this page. Unless that is intended, this page will not appear in results.',
    recommendation: `Confirm each one is intended. If not, make the page canonicalise to itself. ${THEME_FIX}`,
  },
  targetRedirects: {
    status: 'Canonical Target Redirects',
    severity: 'medium',
    resolutionType: 'theme',
    title: 'Canonical tags pointing at a redirect',
    problem: (count) => `${formatCount(count)} pages declare a canonical URL that redirects somewhere else.`,
    why: 'A canonical should name the final URL. Pointing it at a redirect gives search engines two contradicting instructions, and they may ignore the canonical.',
    recommendation: `Point the canonical at the URL the redirect ends on — usually the page itself. ${THEME_FIX}`,
  },
  repeated: {
    status: 'Repeated Canonical Tag',
    severity: 'low',
    resolutionType: 'theme',
    title: 'Pages repeating the same canonical tag',
    problem: (count) => `${formatCount(count)} pages carry the same canonical tag more than once.`,
    why: 'Repeated identical tags are tolerated today, but they mean two things write the tag. If either changes, the page ends up with conflicting canonicals.',
    recommendation: 'Remove the duplicate tag so only one source writes it — usually either the theme or an SEO app, not both.',
  },
};

type Facet = 'Product' | 'Collection' | 'Page' | 'Blog' | 'Home';

/** A published storefront page, from Admin data or — for the homepage — the crawl alone. */
interface InventoryItem {
  id: string;
  facet: Facet;
  title: string;
  handle: string | null;
  url: string;
  /** The resource's own description / body, normalised for comparison. '' when too short to match on. */
  body: string;
  /** Handles are unique per resource type (and per blog for articles), so collisions are too. */
  scope: string | null;
  /** The crawled page for this resource, when the crawl loaded it. */
  page: CrawledPage | null;
}

const FACET_BY_PAGE_TYPE: Record<CrawledPage['pageType'], Facet | null> = {
  home: 'Home',
  product: 'Product',
  collection: 'Collection',
  page: 'Page',
  article: 'Blog',
  other: null,
};

/** A title as comparable text: trimmed, whitespace and case folded. */
function comparableTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameTitle(a: string, b: string): boolean {
  const left = comparableTitle(a);
  return left !== '' && left === comparableTitle(b);
}

/** Below this, two descriptions matching says nothing — "Coming soon." is not a fingerprint. */
const MIN_BODY_CHARS = 60;

/** A description as comparable text: tags and entities stripped, whitespace and case folded. */
function comparableBody(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().toLowerCase();
  return text.length >= MIN_BODY_CHARS ? text : '';
}

/**
 * Joins the pages of one group into families of copies: two pages are copies when they carry the same
 * description or the same title, and copies of copies belong to the same family.
 *
 * Done by KEY, not by comparing every pair. Two pages are copies exactly when they share a key (a
 * description or a title), so each key only needs its first page remembered and every later page with
 * that key joined to it. That reaches the same families in one pass over the group; the pairwise
 * version took time proportional to the square of the group, and a catalogue whose handles are all
 * "product-1", "product-2" … is a single group of every product.
 *
 * Returns the families as lists of indexes into `group`, each in group order.
 */
function copyFamilies(group: readonly InventoryItem[]): number[][] {
  const parent = group.map((_, index) => index);
  const root = (start: number): number => {
    let node = start;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]!]!; // halve the path as we climb, so later lookups stay short
      node = parent[node]!;
    }
    return node;
  };
  const join = (a: number, b: number) => {
    const rootA = root(a);
    const rootB = root(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  };

  const firstWithBody = new Map<string, number>();
  const firstWithTitle = new Map<string, number>();
  group.forEach((item, index) => {
    if (item.body !== '') {
      const seen = firstWithBody.get(item.body);
      if (seen === undefined) firstWithBody.set(item.body, index);
      else join(index, seen);
    }
    const title = comparableTitle(item.title);
    if (title !== '') {
      const seen = firstWithTitle.get(title);
      if (seen === undefined) firstWithTitle.set(title, index);
      else join(index, seen);
    }
  });

  const families = new Map<number, number[]>();
  group.forEach((_, index) => pushInto(families, root(index), index));
  return [...families.values()];
}

/** How many handles a duplicate note spells out before it says "and N more". */
const NOTE_HANDLES_SHOWN = 8;

/** Published resources Shopify let us read, plus what was skipped and why. */
function publishedInventory(snapshot: StoreSnapshot, crawledById: Map<string, CrawledPage>) {
  const items: InventoryItem[] = [];
  const unread: string[] = [];
  let unpublished = 0;
  const add = (item: Omit<InventoryItem, 'page'>, crawlKey: string) => items.push({ ...item, page: crawledById.get(crawlKey) ?? null });

  if (snapshot.coverage.products) {
    for (const product of snapshot.products) {
      // Same rule the crawler uses: an unpublished product is not on the storefront at all.
      if (product.status !== 'active' || product.publishedAt === null || !product.handle) { unpublished += 1; continue; }
      add({ id: `product:${product.id}`, facet: 'Product', title: product.title, handle: product.handle, url: product.url, body: comparableBody(product.bodyHtml), scope: 'product' }, `product:${product.id}`);
    }
  } else unread.push('products');

  if (snapshot.coverage.collections) {
    // Collections carry no publication state in the snapshot, so all of them are included.
    for (const collection of snapshot.collections) {
      if (!collection.handle) continue;
      add({ id: `collection:${collection.id}`, facet: 'Collection', title: collection.title, handle: collection.handle, url: collection.url, body: comparableBody(collection.bodyHtml), scope: 'collection' }, `collection:${collection.id}`);
    }
  } else unread.push('collections');

  if (snapshot.coverage.pages) {
    for (const page of snapshot.pages) {
      if (page.publishedAt === null || !page.handle) { unpublished += 1; continue; }
      add({ id: `page:${page.id}`, facet: 'Page', title: page.title, handle: page.handle, url: page.url, body: comparableBody(page.bodyHtml), scope: 'page' }, `page:${page.id}`);
    }
  } else unread.push('pages');

  if (snapshot.coverage.articles) {
    for (const article of snapshot.articles) {
      if (article.publishedAt === null || !article.handle) { unpublished += 1; continue; }
      add({ id: `article:${article.id}`, facet: 'Blog', title: article.title, handle: article.handle, url: article.url, body: comparableBody(article.bodyHtml), scope: `article:${article.blogHandle}` }, `article:${article.id}`);
    }
  } else unread.push('articles');

  return { items, unread, unpublished };
}

/** The handles of a family, spelled out up to a few and then counted, so one huge family cannot put a ten-thousand-handle sentence on every one of its rows. */
function listHandles(members: readonly InventoryItem[]): string {
  const shown = members.slice(0, NOTE_HANDLES_SHOWN).map((member) => member.handle);
  const rest = members.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest.toLocaleString('en-US')} more` : shown.join(', ');
}

interface CanonicalVerdict {
  issue: Exclude<IssueKey, 'duplicate'> | null;
  /** What the page renders, for the table. */
  display: string;
  /** What the page renders, in full, for the drawer. */
  value: string;
  /** One line on what was found. */
  meta: string;
  /** The single resolved canonical target, when there is one. */
  target: URL | null;
}

function displayUrl(url: URL, pageOrigin: string): string {
  return url.origin === pageOrigin ? `${url.pathname}${url.search}` : url.toString();
}

/** Classifies the canonical tag a crawled page actually rendered. */
function assessCanonical(page: CrawledPage, crawl: StorefrontCrawl, loaded: Map<string, CrawledPage>): CanonicalVerdict {
  const pageUrl = new URL(page.finalUrl);
  const head = page.canonicals;

  if (head.length === 0) {
    const outside = page.canonicalsOutsideHead[0];
    return {
      issue: 'missing',
      display: outside !== undefined ? 'Only outside <head>' : 'None in <head>',
      value: outside !== undefined ? outside || '(empty href)' : 'No canonical tag in <head>',
      meta: outside !== undefined
        ? 'The only canonical tag on this page sits after </head>, where search engines ignore it.'
        : 'The page renders no <link rel="canonical"> in its <head>.',
      target: null,
    };
  }

  const resolved = head.map((href) => resolveCanonical(href, page.finalUrl));
  const unusable = head.find((_, index) => resolved[index] === null);
  if (unusable !== undefined) {
    return {
      issue: 'invalid',
      display: unusable ? unusable : '(empty href)',
      value: unusable ? unusable : '(empty href)',
      meta: unusable ? 'This canonical is not a web address a search engine can use.' : 'The canonical tag has an empty href.',
      target: null,
    };
  }

  const targets = resolved as URL[];
  const distinct = new Set(targets.map(comparableUrl));
  if (distinct.size > 1) {
    return {
      issue: 'conflicting',
      display: `${head.length} tags, ${distinct.size} URLs`,
      value: targets.map((url) => displayUrl(url, pageUrl.origin)).join('  ·  '),
      meta: `${head.length} canonical tags in <head> name ${distinct.size} different URLs.`,
      target: null,
    };
  }

  const target = targets[0]!;
  const display = displayUrl(target, pageUrl.origin);
  const base = { display, value: target.toString(), target };
  const repeatedNote = head.length > 1 ? ` The same tag appears ${head.length} times.` : '';

  if (target.origin !== pageUrl.origin) {
    const protocolOnly = target.host === pageUrl.host;
    return {
      ...base,
      issue: 'offDomain',
      meta: (protocolOnly
        ? `The canonical uses ${target.protocol}// on a page served over ${pageUrl.protocol}//.`
        : `The canonical points at ${target.host}, not ${pageUrl.host}.`) + repeatedNote,
    };
  }

  if (comparableUrl(target) !== comparableUrl(pageUrl)) {
    if (!loaded.has(comparableUrl(target))) {
      const probe = crawl.canonicalTargets[target.toString()];
      if (probe && probe.reason === null && probe.status >= 400) {
        return { ...base, issue: 'targetBroken', meta: `The canonical target answered HTTP ${probe.status}.${repeatedNote}` };
      }
      if (probe && probe.reason === null && probe.status >= 300) {
        const to = probe.location ? displayUrl(new URL(probe.location), pageUrl.origin) : 'another URL';
        return { ...base, issue: 'targetRedirects', meta: `The canonical target redirects (HTTP ${probe.status}) to ${to}.${repeatedNote}` };
      }
      const unverified = !probe || probe.reason !== null ? ' Rankvora AI could not request the target to confirm it loads.' : '';
      return { ...base, issue: 'elsewhere', meta: `The canonical names ${display} instead of this page.${unverified}${repeatedNote}` };
    }
    return { ...base, issue: 'elsewhere', meta: `The canonical names ${display} instead of this page.${repeatedNote}` };
  }

  if (head.length > 1) {
    return { ...base, issue: 'repeated', meta: `The page repeats the same canonical tag ${head.length} times.` };
  }
  return { ...base, issue: null, meta: 'Points at the page itself.' };
}

export const canonicalsCheck: AuditCheck = {
  id: 'seo.canonicals',
  pillar: 'seo',
  subPillar: 'canonicals',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const crawlGap = crawlUnavailableSentence(snapshot, 'rendered canonical tags');
    const crawl = crawlGap === null ? snapshot.crawl : null;
    const crawledPages = crawl?.pages ?? [];

    const crawledById = new Map<string, CrawledPage>();
    for (const page of crawledPages) {
      if (page.resourceId) crawledById.set(`${page.pageType}:${page.resourceId}`, page);
    }

    const { items, unread, unpublished } = publishedInventory(snapshot, crawledById);

    // Pages the crawl loaded that no published resource accounts for — the homepage always, and
    // anything else the crawl reached. Their canonical was measured, so it is reported.
    const matched = new Set(items.map((item) => item.page).filter(Boolean));
    for (const page of crawledPages) {
      if (matched.has(page)) continue;
      const facet = FACET_BY_PAGE_TYPE[page.pageType];
      if (!facet) continue;
      items.unshift({
        id: page.pageType === 'home' ? 'home' : `${page.pageType}:${page.resourceId ?? page.finalUrl}`,
        facet,
        title: pageName(snapshot, page) ?? pathOf(page.finalUrl),
        handle: null,
        url: page.finalUrl,
        body: '',
        scope: null,
        page,
      });
    }

    if (items.length === 0) {
      const adminGap = unread.length === 4
        ? 'Shopify did not return your products, collections, pages or articles'
        : 'Your store has no published products, collections, pages or articles';
      return unavailableResult('canonicals', `${adminGap}, so duplicate pages could not be checked. ${crawlGap ?? ''}`.trim());
    }

    // ── Rendered canonicals ──
    const loaded = new Map<string, CrawledPage>();
    for (const page of crawledPages) {
      const key = comparableFromString(page.finalUrl);
      if (key) loaded.set(key, page);
    }
    const verdicts = new Map<string, CanonicalVerdict>();
    if (crawl) {
      for (const item of items) if (item.page) verdicts.set(item.id, assessCanonical(item.page, crawl, loaded));
    }

    // ── Duplicate pages ──
    // Group each type's handles by their un-suffixed stem: "formula", "formula-1", "formula-2".
    const suffixOf = (handle: string) => /^(.+)-(\d+)$/.exec(handle);
    const groups = new Map<string, InventoryItem[]>();
    for (const item of items) {
      if (!item.scope || !item.handle) continue;
      const stem = suffixOf(item.handle)?.[1] ?? item.handle;
      const key = `${item.scope}\u0000${stem}`;
      pushInto(groups, key, item);
    }

    // Within a group, pages that are copies of one another (same description or same title) form a
    // family. Handles in a group differ only by the suffix, so any family of two has a suffixed copy.
    const families = new Map<string, { original: InventoryItem; copies: InventoryItem[] }>();
    const assigned = new Set<string>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const indexes of copyFamilies(group)) {
        const members = indexes.map((index) => group[index]!).filter((item) => !assigned.has(item.id));
        if (members.length < 2) continue;
        // The original is the un-suffixed handle when it exists, otherwise the lowest suffix.
        const rank = (item: InventoryItem) => Number(suffixOf(item.handle!)?.[2] ?? -1);
        const [original, ...copies] = [...members].sort((x, y) => rank(x) - rank(y));
        families.set(original!.id, { original: original!, copies });
        for (const member of members) assigned.add(member.id);
      }
    }

    const issuesOf = new Map<string, Set<IssueKey>>(items.map((item) => [item.id, new Set<IssueKey>()]));
    const familyOf = new Map<string, { original: InventoryItem; members: InventoryItem[]; match: string }>();
    for (const { original, copies } of families.values()) {
      const sameBody = copies.every((copy) => copy.body !== '' && copy.body === original.body);
      const titled = copies.every((copy) => sameTitle(copy.title, original.title));
      const match = sameBody && titled ? 'the same title and description' : sameBody ? 'the same description' : titled ? 'the same title' : 'the same description or title';
      // A copy whose canonical points at the original is already consolidated — the fix, applied.
      const originalKey = comparableFromString(original.url);
      const consolidated = copies.filter((copy) => {
        const target = verdicts.get(copy.id)?.target;
        return verdicts.get(copy.id)?.issue === 'elsewhere' && target && originalKey !== null && comparableUrl(target) === originalKey;
      });
      const consolidatedIds = new Set(consolidated.map((copy) => copy.id));
      const open = copies.filter((copy) => !consolidatedIds.has(copy.id));
      const members = [original, ...copies];
      for (const member of members) familyOf.set(member.id, { original, members, match });
      for (const copy of consolidated) {
        const repeats = copy.page?.canonicals.length ?? 0;
        verdicts.set(copy.id, {
          ...verdicts.get(copy.id)!,
          issue: repeats > 1 ? 'repeated' : null,
          meta: `Consolidated onto “${original.handle}” by its canonical tag.${repeats > 1 ? ` The same tag appears ${repeats} times.` : ''}`,
        });
      }
      if (open.length > 0) for (const member of [original, ...open]) issuesOf.get(member.id)!.add('duplicate');
    }

    for (const [id, verdict] of verdicts) if (verdict.issue) issuesOf.get(id)!.add(verdict.issue);

    // ── Rows ──
    const rows: SubPillarEvidenceRow[] = [];
    const rowsByIssue = new Map<IssueKey, SubPillarEvidenceRow[]>();
    let healthy = 0;

    // Loaded pages first, so the table's healthy sample shows pages whose canonical was read.
    const ordered = [...items].sort((a, b) => Number(Boolean(b.page)) - Number(Boolean(a.page)));
    for (const item of ordered) {
      const issues = issuesOf.get(item.id)!;
      const primary = ISSUE_ORDER.find((key) => issues.has(key)) ?? null;
      if (!primary) healthy += 1;

      const verdict = verdicts.get(item.id) ?? null;
      const family = familyOf.get(item.id) ?? null;
      const familyNote = family
        ? `${family.members.length} ${item.facet === 'Blog' ? 'articles' : `${item.facet.toLowerCase()}s`} with ${family.match}: ${listHandles(family.members)}.`
        : undefined;

      let suggested: SubPillarEvidenceRow['suggested'];
      if (primary === 'duplicate') {
        suggested = { label: 'Recommendation', value: `Keep “${family!.original.handle}” and redirect or delete the copies.` };
      } else if (primary && item.page) {
        suggested = { label: 'Expected canonical', value: item.page.finalUrl };
      }

      const row: SubPillarEvidenceRow = {
        id: item.id,
        status: primary ? ISSUES[primary].status : HEALTHY,
        facet: item.facet,
        cells: {
          name: item.title.trim() || null,
          url: item.facet === 'Home' ? '/' : pathOf(item.url),
          pageType: item.facet,
          // Null when the crawl did not load this page — "not measured", never "no canonical".
          canonical: verdict?.display ?? null,
        },
        current: {
          label: 'Rendered canonical',
          value: verdict?.value ?? 'Not loaded in this audit',
          meta: verdict?.meta ?? (crawl ? 'Outside the storefront sample this audit loaded, so its canonical tag was not read.' : 'Rendered canonical tags were not measured in this audit.'),
        },
        ...(suggested ? { suggested } : {}),
        ...(familyNote ? { note: familyNote } : {}),
      };
      rows.push(row);
      for (const issue of issues) pushInto(rowsByIssue, issue, row);
    }

    const analyzed = rows.length;
    const loadedCount = items.filter((item) => item.page).length;

    // ── Findings, worst first ──
    const findings: SubPillarFindingResult[] = [];
    for (const key of ISSUE_ORDER) {
      const affected = rowsByIssue.get(key) ?? [];
      if (affected.length === 0) continue;
      const issue = ISSUES[key];
      const examples = affected.slice(0, 5).map((row) => {
        const where = String(row.cells.url);
        return key === 'duplicate' ? `${where} — ${row.note ?? ''}`.trim() : `${where} — ${row.current?.meta ?? ''}`.trim();
      });
      const base = key === 'duplicate' ? `${formatCount(affected.length)} of ${formatCount(analyzed)} published pages.` : `${formatCount(affected.length)} of ${formatCount(loadedCount)} pages whose canonical was read.`;
      findings.push({
        title: issue.title,
        severity: issue.severity,
        affectedCount: affected.length,
        affectedLabel: 'pages',
        scoreLift: Math.round((affected.length / analyzed) * 100),
        resolutionType: issue.resolutionType,
        problem: issue.problem(affected.length),
        why: issue.why,
        recommendation: issue.recommendation,
        evidence: [base, ...examples],
        evidenceRows: affected.slice(0, EVIDENCE_ROW_LIMIT),
        details: { issueType: issue.status },
      });
    }

    // ── Summary: what was measured, on how much, and what was not ──
    const parts = [`${formatCount(healthy)} of ${formatCount(analyzed)} published pages show no canonical or duplicate-page problem.`];
    if (crawl) {
      parts.push(`Rendered canonical tags were read on ${formatCount(loadedCount)} of them. ${crawlScopeNote(crawl)}`);
      if (analyzed > loadedCount) parts.push(`The other ${formatCount(analyzed - loadedCount)} were checked for duplicate handles only.`);
    } else {
      parts.push(`${crawlGap} Duplicate handles were still checked on every published page.`);
    }
    if (unread.length > 0) {
      const listed = unread.length > 1 ? `${unread.slice(0, -1).join(', ')} and ${unread[unread.length - 1]}` : unread[0];
      parts.push(`Shopify did not return your ${listed}, so they are not included.`);
    }
    if (snapshot.scope.productsTruncated) parts.push(`Only the first ${formatCount(snapshot.scope.productLimit)} products were read, so duplicates among the rest were not checked.`);
    if (unpublished > 0) parts.push(`${formatCount(unpublished)} unpublished ${unpublished === 1 ? 'item was' : 'items were'} skipped — not on your storefront.`);

    return {
      subPillar: 'canonicals',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: parts.join(' '),
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Canonical tags read',
        contextValue: crawl ? `${formatCount(loadedCount)} of ${formatCount(analyzed)} pages` : 'Not measured',
        healthyStatus: HEALTHY,
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
