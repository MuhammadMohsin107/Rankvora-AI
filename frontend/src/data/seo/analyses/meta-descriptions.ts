import { sortByCell, type SubPillarAnalysis } from '../subpillar.model';

// ─── Static presentation config only ──────────────────────────────────
// Data fields (summary/healthChip/totals/findings/evidence.rows/
// lastAnalyzed) are placeholders overwritten by fetchSubPillarAnalysis()
// on load — see data/seo/subpillar.repository.ts. `evidence.sorts`
// intentionally omits the severity sort — the repository prepends it
// once real findings are known (sortBySeverity closes over them).

export const metaDescriptionsAnalysis: SubPillarAnalysis = {
  slug: 'meta-descriptions',
  title: 'Meta Descriptions',
  description: 'Check that every page earns its click with a unique, well-sized description in the search snippet.',
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
    criticalLabel: 'Missing',
    contextLabel: '',
    contextValue: '',
  },
  findings: [],
  evidence: {
    title: 'Affected pages',
    // NOT "sampled from the latest crawl". This sub-pillar never fetches the storefront — it
    // reads the SEO description field from the Shopify Admin API (meta-descriptions.ts:43). The
    // old wording promised rendered-page evidence and so made a correct result look wrong: a
    // product whose theme derives a description from its body copy still has NO description
    // configured in Shopify, which is the gap this check reports and the merchant can act on.
    caption: 'Pages from your Shopify catalog with the meta description set on each one',
    searchPlaceholder: 'Search product, URL or description…',
    searchKeys: ['name', 'url', 'description'],
    sampleNoun: 'analyzed pages',
    facet: { label: 'Page type', allLabel: 'All page types', values: ['Product', 'Collection', 'Blog', 'Page'] },
    columns: [
      // This table needs the name most: every row's description is empty on a store that sets
      // none, so without it a truncated URL was the only thing distinguishing one row from another.
      // Name only — the URL stays searchable but is not worth a visible line.
      { key: 'name', fallbackKey: 'url', header: 'Product / page', clamp: 'max-w-[18rem]' },
      // "no description" claimed something this check never looked at — whether the SERVED page
      // has a <meta name="description">. It only knows the Shopify field is empty, so it says so.
      { key: 'description', header: 'Meta description in Shopify', emptyText: 'none set in Shopify', clamp: 'max-w-[24rem]' },
      { key: 'length', header: 'Length', align: 'center', variant: 'number' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'severity', header: 'Severity', variant: 'severity' },
      { key: 'action', header: 'Action', align: 'right', variant: 'action' },
    ],
    rows: [],
    sorts: [
      sortByCell('length', 'Sort: description length', 'desc'),
      sortByCell('url', 'Sort: URL'),
    ],
  },
  relatedAreas: [
    { label: 'Title Tags', href: '/seo/title-tags', hint: 'The other half of the search snippet' },
    { label: 'Canonicals & Duplicates', href: '/seo/canonicals', hint: 'Where duplicate snippets originate' },
    { label: 'Sitemap & Indexability', href: '/seo/sitemap', hint: 'Whether these pages can rank at all' },
  ],
  lastAnalyzed: '',
};
