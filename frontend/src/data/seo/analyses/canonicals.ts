import { sortByCell, type SubPillarAnalysis } from '../subpillar.model';

// ─── Static presentation config only ──────────────────────────────────
// Data fields (summary/healthChip/totals/findings/evidence.rows/
// lastAnalyzed) are placeholders overwritten by fetchSubPillarAnalysis()
// on load — see data/seo/subpillar.repository.ts. `evidence.sorts`
// intentionally omits the severity sort — the repository prepends it
// once real findings are known (sortBySeverity closes over them).

export const canonicalsAnalysis: SubPillarAnalysis = {
  slug: 'canonicals',
  title: 'Canonicals & Duplicates',
  description: 'Make sure every page consolidates its ranking signals onto one preferred URL.',
  // Nothing here is a field Rankvora AI can write: a canonical tag is theme markup, and a duplicate
  // page is resolved by deleting or redirecting it in Shopify. Offering row selection and a
  // "Generate fixes" editor would open a workflow the server has no way to apply.
  supportsBulkFix: false,
  summary: '',
  healthChip: '',
  totals: {
    score: 0,
    analyzed: 0,
    healthy: 0,
    issues: 0,
    critical: 0,
    // Every published page is checked for duplicates; only the crawl sample has its rendered
    // canonical read. "Valid canonicals" claimed a validation most rows never had.
    analyzedLabel: 'Pages analyzed',
    healthyLabel: 'No issues found',
    issuesLabel: 'Issues',
    // A label that names no issue type keeps the count of critical-severity pages — which is what
    // it says. The old "Conflicts" named nothing the check raised, so it read 0 on every store.
    criticalLabel: 'Critical',
    contextLabel: '',
    contextValue: '',
  },
  findings: [],
  evidence: {
    title: 'Pages checked',
    // ─── Columns must match what the CHECK measures ────────────────────
    // `canonical` is the tag the page actually rendered, read by the storefront crawl. It is empty
    // for pages outside the crawl sample, and says so ("Not loaded") rather than implying the page
    // has no canonical. Duplicate-page details — which handles, and whether they share the title
    // or the description — are in the investigation drawer.
    caption: 'Published pages with the canonical tag the storefront rendered and any duplicate-page issue',
    searchPlaceholder: 'Search product, page or URL…',
    searchKeys: ['name', 'url', 'canonical'],
    sampleNoun: 'pages',
    facet: { label: 'Page type', allLabel: 'All page types', values: ['Home', 'Product', 'Collection', 'Page', 'Blog'] },
    columns: [
      // The resource's own name, with its path underneath so two similar names can be told apart.
      { key: 'name', fallbackKey: 'url', subKey: 'url', header: 'Product / page', clamp: 'max-w-[18rem]' },
      { key: 'canonical', header: 'Rendered canonical', variant: 'mono', emptyText: 'Not loaded', clamp: 'max-w-[20rem]' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'severity', header: 'Severity', variant: 'severity' },
      { key: 'action', header: 'Action', align: 'right', variant: 'action' },
    ],
    rows: [],
    sorts: [sortByCell('name', 'Sort: name'), sortByCell('pageType', 'Sort: page type')],
  },
  relatedAreas: [
    { label: 'Handles & Redirects', href: '/seo/handles-redirects', hint: 'Where duplicate URLs are created' },
    { label: 'Sitemap & Indexability', href: '/seo/sitemap', hint: 'Which of these URLs are indexable' },
    { label: 'Title Tags', href: '/seo/title-tags', hint: 'Duplicate titles often follow duplicate URLs' },
  ],
  lastAnalyzed: '',
};
