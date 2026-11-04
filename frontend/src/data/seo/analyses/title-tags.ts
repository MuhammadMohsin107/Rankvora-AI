import { sortByCell, type SubPillarAnalysis } from '../subpillar.model';

// ─── Static presentation config only ──────────────────────────────────
// Data fields below (summary/healthChip/totals/findings/evidence.rows/
// lastAnalyzed) are placeholders overwritten by fetchSubPillarAnalysis()
// on load — see data/seo/subpillar.repository.ts. This file keeps only
// what doesn't change per audit: labels, columns, facet, sorts, related
// areas. `evidence.sorts` intentionally omits the severity sort — the
// repository rebuilds and prepends it once real findings are known
// (sortBySeverity closes over the findings array).

export const titleTagsAnalysis: SubPillarAnalysis = {
  slug: 'title-tags',
  title: 'Title Tags',
  description: 'Evaluate how effectively your store uses unique, descriptive and search-friendly page titles.',
  supportsBulkFix: true,
  bulkFixMode: 'title-tags',
  summary: '',
  healthChip: '',
  totals: {
    score: 0,
    analyzed: 0,
    healthy: 0,
    issues: 0,
    critical: 0,
    analyzedLabel: 'Pages analyzed',
    healthyLabel: 'Healthy',
    issuesLabel: 'Issues',
    criticalLabel: 'Critical',
    contextLabel: '',
    contextValue: '',
  },
  findings: [],
  evidence: {
    title: 'Affected pages',
    // Like meta descriptions, this sub-pillar scores the Shopify Admin inventory rather than
    // fetched pages — only `internal-links` and `schema` actually crawl. What it DOES read from
    // the storefront is the theme's title suffix, measured from the pages the crawl loaded.
    caption: 'Pages from your Shopify catalog, measured as the theme renders each title',
    searchPlaceholder: 'Search product, URL or title…',
    searchKeys: ['name', 'url', 'title'],
    sampleNoun: 'analyzed pages',
    facet: { label: 'Page type', allLabel: 'All page types', values: ['Product', 'Collection', 'Blog', 'Page'] },
    columns: [
      // The resource's own NAME, and only that. A full URL here spent the whole column on the
      // origin, identical on every row, and truncated the one part that told them apart. The URL
      // is still searchable (searchKeys) — it just does not need a line of its own.
      { key: 'name', fallbackKey: 'url', header: 'Product / page', clamp: 'max-w-[18rem]' },
      // No `keyword` subKey: the check never writes one — nothing in Rankvora AI derives a target
      // keyword for a page — so it only ever rendered as a blank second line under the title.
      { key: 'title', header: 'Current title', emptyText: 'no title tag', clamp: 'max-w-[20rem]' },
      { key: 'length', header: 'Length', align: 'center', variant: 'number' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'severity', header: 'Severity', variant: 'severity' },
      { key: 'action', header: 'Action', align: 'right', variant: 'action' },
    ],
    rows: [],
    sorts: [sortByCell('length', 'Sort: title length', 'desc'), sortByCell('url', 'Sort: URL')],
  },
  relatedAreas: [
    { label: 'Meta Descriptions', href: '/seo/meta-descriptions', hint: 'The other half of the search snippet' },
    { label: 'Canonicals & Duplicates', href: '/seo/canonicals', hint: 'Where duplicate titles usually originate' },
    { label: 'Schema / JSON-LD', href: '/seo/schema', hint: 'Structured data behind rich results' },
  ],
  lastAnalyzed: '',
};
