import { sortByCell, type SubPillarAnalysis } from '../subpillar.model';

// ─── Static presentation config only ──────────────────────────────────
// Data fields (summary/healthChip/totals/findings/evidence.rows/
// lastAnalyzed) are placeholders overwritten by fetchSubPillarAnalysis()
// on load — see data/seo/subpillar.repository.ts. `evidence.sorts`
// intentionally omits the severity sort — the repository prepends it
// once real findings are known (sortBySeverity closes over them).

export const internalLinksAnalysis: SubPillarAnalysis = {
  slug: 'internal-links',
  title: 'Internal Links & 404s',
  description: 'Make sure crawlers and shoppers can reach every page, and that no link leads to a dead end.',
  summary: '',
  healthChip: '',
  totals: {
    score: 0,
    analyzed: 0,
    healthy: 0,
    issues: 0,
    critical: 0,
    analyzedLabel: 'Pages analyzed',
    healthyLabel: 'Healthy pages',
    issuesLabel: 'Issues',
    criticalLabel: 'Broken links',
    contextLabel: '',
    contextValue: '',
  },
  findings: [],
  evidence: {
    title: 'Affected links',
    // The unit here is the PAGE, not the individual link: the check counts each crawled page's
    // internal and external links. `source`, `target`, `anchor` and `httpStatus` were never
    // written — no link is followed, so no HTTP status exists to report.
    caption: 'Crawled pages with their internal linking counts',
    searchPlaceholder: 'Search product or page…',
    searchKeys: ['name', 'url', 'recommendation'],
    sampleNoun: 'crawled pages',
    facet: { label: 'Page type', allLabel: 'All page types', values: ['Product', 'Collection', 'Blog', 'Page'] },
    columns: [
      // The resource's own name from Shopify, as on Title Tags. Falls back to the path for an audit
      // taken before the check wrote `name`, so those rows still identify themselves.
      { key: 'name', fallbackKey: 'url', header: 'Product / page', clamp: 'max-w-[18rem]' },
      { key: 'internalLinks', header: 'Internal', align: 'center', variant: 'number' },
      { key: 'externalLinks', header: 'External', align: 'center', variant: 'number' },
      { key: 'recommendation', header: 'Recommendation', variant: 'muted', clamp: 'max-w-[18rem]' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'severity', header: 'Severity', variant: 'severity' },
      { key: 'action', header: 'Action', align: 'right', variant: 'action' },
    ],
    rows: [],
    sorts: [sortByCell('internalLinks', 'Sort: internal links'), sortByCell('name', 'Sort: name')],
  },
  relatedAreas: [
    { label: 'Handles & Redirects', href: '/seo/handles-redirects', hint: 'Where these 404s should redirect' },
    { label: 'Sitemap & Indexability', href: '/seo/sitemap', hint: 'How orphan pages get discovered' },
    { label: 'Canonicals & Duplicates', href: '/seo/canonicals', hint: 'Which URL links should point at' },
  ],
  lastAnalyzed: '',
};
