import { sortByCell, type SubPillarAnalysis } from '../subpillar.model';

// ─── Static presentation config only ──────────────────────────────────
// Data fields (summary/healthChip/totals/findings/evidence.rows/
// lastAnalyzed) are placeholders overwritten by fetchSubPillarAnalysis()
// on load — see data/seo/subpillar.repository.ts. `evidence.sorts`
// intentionally omits the severity sort — the repository prepends it
// once real findings are known (sortBySeverity closes over them).

export const sitemapAnalysis: SubPillarAnalysis = {
  slug: 'sitemap',
  title: 'Sitemap & Indexability',
  description: 'Confirm the pages you want ranking are submitted, crawlable and actually indexed.',
  summary: '',
  healthChip: '',
  totals: {
    score: 0,
    analyzed: 0,
    healthy: 0,
    issues: 0,
    critical: 0,
    analyzedLabel: 'URLs analyzed',
    healthyLabel: 'Indexed',
    issuesLabel: 'Issues',
    criticalLabel: 'Blocked',
    contextLabel: '',
    contextValue: '',
  },
  findings: [],
  evidence: {
    title: 'Affected URLs',
    // `indexability`, `inSitemap` and `robots` were never written by the check, so all three
    // rendered empty on every row. What it actually probes is three storefront endpoints — the
    // homepage, /robots.txt and /sitemap.xml — recording each one's result and HTTP status.
    caption: 'Storefront endpoints probed by the latest audit',
    searchPlaceholder: 'Search endpoint…',
    searchKeys: ['url', 'title'],
    sampleNoun: 'probed endpoints',
    facet: { label: 'Endpoint', allLabel: 'All endpoints', values: ['Storefront', 'robots.txt', 'sitemap.xml'] },
    columns: [
      { key: 'url', header: 'Endpoint', variant: 'mono', subKey: 'pageType', clamp: 'max-w-[17rem]' },
      { key: 'title', header: 'Result', clamp: 'max-w-[20rem]' },
      { key: 'length', header: 'HTTP', align: 'center', variant: 'number' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'severity', header: 'Severity', variant: 'severity' },
      { key: 'action', header: 'Action', align: 'right', variant: 'action' },
    ],
    rows: [],
    sorts: [sortByCell('length', 'Sort: HTTP status', 'desc'), sortByCell('url', 'Sort: endpoint')],
  },
  relatedAreas: [
    { label: 'Canonicals & Duplicates', href: '/seo/canonicals', hint: 'Which URL should be indexed' },
    { label: 'Handles & Redirects', href: '/seo/handles-redirects', hint: 'Redirected URLs still in the sitemap' },
    { label: 'Internal Links & 404s', href: '/seo/internal-links', hint: 'How crawlers discover these pages' },
  ],
  lastAnalyzed: '',
};
