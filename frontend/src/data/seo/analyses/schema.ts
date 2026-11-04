import { sortByCell, type SubPillarAnalysis } from '../subpillar.model';

// ─── Static presentation config only ──────────────────────────────────
// Brought into line with the other seven SEO analyses. This file previously carried a full set
// of invented measurements — a computed score, three hand-written findings and fourteen evidence
// rows with real-looking URLs and error counts — which SchemaJsonLdPage rendered without ever
// calling the API. Data fields (summary/healthChip/totals/findings/evidence.rows/lastAnalyzed)
// are now placeholders overwritten by fetchSubPillarAnalysis() on load, exactly as in
// canonicals.ts and its siblings. `evidence.sorts` intentionally omits the severity sort — the
// repository prepends it once real findings are known (sortBySeverity closes over them).

export const schemaAnalysis: SubPillarAnalysis = {
  slug: 'schema',
  title: 'Schema / JSON-LD',
  description: 'Verify that your structured data is present, valid and complete enough to earn rich results.',
  summary: '',
  healthChip: '',
  totals: {
    score: 0,
    analyzed: 0,
    healthy: 0,
    issues: 0,
    critical: 0,
    analyzedLabel: 'Pages analyzed',
    healthyLabel: 'Valid schema',
    issuesLabel: 'Issues',
    criticalLabel: 'Errors',
    contextLabel: 'Schema types in use',
    contextValue: '',
  },
  findings: [],
  evidence: {
    title: 'Affected pages',
    // `errors` and `warnings` were never written — the check does not validate markup against
    // schema.org, it records which JSON-LD types a page emits and how many blocks it has. Both
    // count columns therefore showed nothing on every row. `types` and `detail` were also the
    // wrong keys for `schemaTypes`.
    caption: 'Crawled pages with the structured data they emit',
    searchPlaceholder: 'Search product, page or schema type…',
    searchKeys: ['name', 'url', 'schemaTypes'],
    sampleNoun: 'crawled pages',
    facet: { label: 'Page type', allLabel: 'All page types', values: ['Product', 'Collection', 'Blog', 'Page'] },
    columns: [
      // The resource's own name from Shopify, as on Title Tags. Falls back to the path for an audit
      // taken before the check wrote `name`, so those rows still identify themselves.
      { key: 'name', fallbackKey: 'url', header: 'Product / page', clamp: 'max-w-[18rem]' },
      { key: 'schemaTypes', header: 'Schema types', emptyText: 'no markup', clamp: 'max-w-[18rem]' },
      { key: 'blocks', header: 'Blocks', align: 'center', variant: 'number' },
      { key: 'recommendation', header: 'Recommendation', variant: 'muted', clamp: 'max-w-[16rem]' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'severity', header: 'Severity', variant: 'severity' },
      { key: 'action', header: 'Action', align: 'right', variant: 'action' },
    ],
    rows: [],
    sorts: [sortByCell('blocks', 'Sort: blocks', 'desc'), sortByCell('name', 'Sort: name')],
  },
  relatedAreas: [
    { label: 'Title Tags', href: '/seo/title-tags', hint: 'What the result headline says' },
    { label: 'Meta Descriptions', href: '/seo/meta-descriptions', hint: 'What the result snippet says' },
    { label: 'Sitemap & Indexability', href: '/seo/sitemap', hint: 'Whether these pages are indexable' },
  ],
  lastAnalyzed: '',
};
