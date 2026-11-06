import { sortByCell, type SubPillarAnalysis } from '../subpillar.model';

// ─── Static presentation config only ──────────────────────────────────
// Data fields (summary/healthChip/totals/findings/evidence.rows/
// lastAnalyzed) are placeholders overwritten by fetchSubPillarAnalysis()
// on load — see data/seo/subpillar.repository.ts. `evidence.sorts`
// intentionally omits the severity sort — the repository prepends it
// once real findings are known (sortBySeverity closes over them).

export const imageAltTextAnalysis: SubPillarAnalysis = {
  slug: 'image-alt-text',
  title: 'Image Alt Text',
  supportsBulkFix: true,
  /**
   * Values come from the merchant's saved alt-text template, not from a model.
   *
   * Alt text is formulaic — product name, type, vendor, image number — so the template renders it
   * deterministically, for free, on a server with no AI credentials at all. Sending it to a model
   * instead is what produced the empty boxes: the planner had no image to talk about, so it echoed
   * the row's coverage summary back and validation rejected it as unchanged.
   */
  bulkFixGenerator: 'template',
  summary: '',
  healthChip: '',
  totals: {
    score: 0,
    analyzed: 0,
    healthy: 0,
    issues: 0,
    critical: 0,
    // Products, not images: a product is the unit this check scores, and it is healthy only when
    // every one of its images is described. The image totals are in `contextValue`.
    analyzedLabel: 'Products analyzed',
    healthyLabel: 'Fully described',
    issuesLabel: 'Issues',
    criticalLabel: 'No alt attribute',
    contextLabel: '',
    contextValue: '',
  },
  findings: [],
  evidence: {
    // ─── One row per IMAGE ─────────────────────────────────────────────
    // Alt text is written to an image, so the row that offers to fix it has to BE an image. The
    // table used to show one row per product carrying a coverage summary ("0 of 1 images
    // labelled") — readable, but not a value: it could not say which of three photos a
    // recommendation belonged to, and there was nothing for Rankvora AI to write it to.
    //
    // Each row now names its own media id, shows that image's real alt text, and is writable. The
    // Issue column still carries the PRODUCT's verdict, because that is what the findings above
    // count and what their filter chips select.
    title: 'Affected images',
    caption: 'Product images sampled from the latest audit with their alt text',
    searchPlaceholder: 'Search product or URL…',
    searchKeys: ['name', 'url'],
    sampleNoun: 'analyzed images',
    facet: { label: 'Resource type', allLabel: 'All types', values: ['Product image'] },
    columns: [
      // The product's own name identifies the row, as on Title Tags; the image number separates
      // two photos of the same product. The URL stays searchable rather than taking a column.
      { key: 'name', fallbackKey: 'url', header: 'Product', clamp: 'max-w-[16rem]' },
      { key: 'imageLabel', header: 'Image', align: 'center', variant: 'muted' },
      // Empty is the finding, so it is named rather than left as a dash.
      { key: 'alt', header: 'Alt text', clamp: 'max-w-[16rem]', emptyText: 'No alt text' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'severity', header: 'Severity', variant: 'severity' },
      { key: 'action', header: 'Action', align: 'right', variant: 'action' },
    ],
    rows: [],
    sorts: [sortByCell('name', 'Sort: product'), sortByCell('length', 'Sort: alt-text length')],
  },
  relatedAreas: [
    { label: 'Schema / JSON-LD', href: '/seo/schema' },
    { label: 'Title Tags', href: '/seo/title-tags' },
    { label: 'Internal Links & 404s', href: '/seo/internal-links' },
  ],
  lastAnalyzed: '',
};
