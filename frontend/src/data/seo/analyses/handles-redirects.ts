import { sortByCell, type SubPillarAnalysis } from '../subpillar.model';

// ─── Static presentation config only ──────────────────────────────────
// Data fields (summary/healthChip/totals/findings/evidence.rows/
// lastAnalyzed) are placeholders overwritten by fetchSubPillarAnalysis()
// on load — see data/seo/subpillar.repository.ts. `evidence.sorts`
// intentionally omits the severity sort — the repository prepends it
// once real findings are known (sortBySeverity closes over them).

export const handlesRedirectsAnalysis: SubPillarAnalysis = {
  slug: 'handles-redirects',
  title: 'Handles & Redirects',
  description: 'Keep URLs stable and make sure every redirect resolves cleanly in a single hop.',
  // Nothing here is writable by Rankvora AI: redirects are read with read_online_store_navigation and
  // never edited (no write scope is requested), and a handle is renamed in Shopify so the merchant
  // can keep its "create a URL redirect" option. Row selection and "Generate fixes" would open an
  // editor the server has no way to apply.
  supportsBulkFix: false,
  summary: '',
  healthChip: '',
  totals: {
    score: 0,
    analyzed: 0,
    healthy: 0,
    issues: 0,
    critical: 0,
    // The audit covers two populations — every URL redirect and every published handle — so the
    // tiles say "redirects & handles", not "URLs".
    analyzedLabel: 'Redirects & handles',
    healthyLabel: 'No issues found',
    issuesLabel: 'Issues',
    // Names no issue type, so it shows the count of critical-severity items: broken redirects.
    // "Broken redirects" never matched an issue type the check raised and fell back silently.
    criticalLabel: 'Critical',
    contextLabel: '',
    contextValue: '',
  },
  findings: [],
  evidence: {
    title: 'Redirects & handles',
    // Every key below is one the check writes: path, label, target, hops. A redirect row has a
    // target and a hop count (null when the redirect never fires or its target is unusable); a
    // handle row has neither, and says so with a dash rather than an invented value.
    caption: 'URL redirects and published handles read from the store in the latest audit',
    searchPlaceholder: 'Search path, target or name…',
    searchKeys: ['path', 'target', 'label'],
    sampleNoun: 'redirects & handles',
    facet: { label: 'Type', allLabel: 'All types', values: ['Redirect', 'Product', 'Collection', 'Page', 'Blog'] },
    columns: [
      { key: 'path', header: 'Path', variant: 'mono', subKey: 'label', clamp: 'max-w-[18rem]' },
      { key: 'target', header: 'Redirects to', variant: 'mono', emptyText: '—', clamp: 'max-w-[18rem]' },
      { key: 'hops', header: 'Hops', align: 'center', variant: 'number', emptyText: '—' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'severity', header: 'Severity', variant: 'severity' },
      { key: 'action', header: 'Action', align: 'right', variant: 'action' },
    ],
    rows: [],
    sorts: [sortByCell('hops', 'Sort: hops', 'desc'), sortByCell('path', 'Sort: path')],
  },
  relatedAreas: [
    { label: 'Internal Links & 404s', href: '/seo/internal-links', hint: 'What still links to these URLs' },
    { label: 'Canonicals & Duplicates', href: '/seo/canonicals', hint: 'How duplicate URLs consolidate' },
    { label: 'Sitemap & Indexability', href: '/seo/sitemap', hint: 'Whether redirected URLs are still listed' },
  ],
  lastAnalyzed: '',
};
