// ─── SEO sub-pillar · master analysis model ──────────────────────────
// The Title Tags page is the approved master template. This file is the
// contract every SEO sub-pillar fills in: same architecture, own data.
//
// Scores and counts are always read from seo-8pillars.mock.ts — the
// existing Rankvora AI data model. Nothing here recomputes a score.

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Status for a row that has no issue. */
export const HEALTHY = 'Healthy' as const;

/** An issue type is the sub-pillar's own vocabulary, e.g. "Too Long". */
export type IssueType = string;
export type RowStatus = IssueType | typeof HEALTHY;

export const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const severityLabel: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

// ─── Findings ────────────────────────────────────────────────────────
export interface SubPillarFinding {
  id: string;
  /** Must match the `status` used by its evidence rows. */
  issueType: IssueType;
  title: string;
  /**
   * Set by the audit's rules — the one rating a finding carries.
   *
   * There is no `impact` and no `effort`. Both were words each check typed in by hand, identical
   * for every store whatever it found, and the pages showed them as if they had been measured.
   */
  severity: Severity;
  affected: number;
  /** What `affected` counts ("products", "pages"). Absent on audits stored before it was sent. */
  affectedLabel?: string;
  /** What `affected` is out of, when the check recorded it — "3 of 20 pages". */
  population?: number | null;
  whatIsWrong: string;
  whyItMatters: string;
  recommendation: string;
  /**
   * The rows this finding actually flagged, as recorded by the check that raised it.
   *
   * Optional because not every check attaches rows to its findings. When it is absent the caller
   * falls back to filtering the sub-pillar sample by `issueType` — which is only correct when one
   * finding owns that issue type, so prefer this list whenever it is present.
   */
  evidenceRows?: EvidenceRow[];
}

// ─── Evidence ────────────────────────────────────────────────────────
export type CellValue = string | number | null;

export interface EvidenceColumn {
  key: string;
  header: string;
  align?: 'left' | 'center' | 'right';
  /**
   * mono     → monospace muted (URLs, handles)
   * text     → normal cell
   * muted    → small muted text
   * number   → tabular numerals
   * status   → the row's issue type
   * severity → severity badge derived from the row's status
   * action   → "Investigate" button
   */
  variant?: 'mono' | 'text' | 'muted' | 'number' | 'status' | 'severity' | 'action';
  /** Optional second line rendered under the main value. */
  subKey?: string;
  /**
   * Cell to fall back to when `key` is absent.
   *
   * Evidence rows are written at audit time, so a column keyed on a cell added after an audit ran
   * would render `emptyText` for every row of that audit until it is re-run. This keeps the older
   * shape readable instead — e.g. a "Product" column showing the URL until the next analysis
   * fills in the name.
   */
  fallbackKey?: string;
  /** Shown instead of an empty value. */
  emptyText?: string;
  /** Max width utility for long text cells. */
  clamp?: string;
}

export interface EvidenceRow {
  id: string;
  /** An issue type from `findings`, or HEALTHY. */
  status: RowStatus;
  cells: Record<string, CellValue>;
  /** Secondary filter value (page type, format, schema type…). */
  facet?: string;
  /** Before/after pair rendered in the investigation drawer. */
  current?: { label: string; value: string; meta?: string };
  suggested?: { label: string; value: string };
  /** Extra context line in the drawer, e.g. "Collides with /x". */
  note?: string;
  /** What one row is ('product', 'page'), set by a check whose table mixes kinds. */
  unit?: string;
}

export interface SortOption {
  key: string;
  label: string;
  /** Comparator over evidence rows. */
  compare: (a: EvidenceRow, b: EvidenceRow) => number;
}

export interface EvidenceConfig {
  /** Heading shown above the table. */
  title: string;
  caption: string;
  searchPlaceholder: string;
  /** Cell keys included in the free-text search. */
  searchKeys: string[];
  columns: EvidenceColumn[];
  rows: EvidenceRow[];
  /** Secondary dropdown filter. Omit to hide it. */
  facet?: { label: string; allLabel: string; values: string[] };
  sorts: SortOption[];
  /** Noun for the sample line, e.g. "crawled pages". */
  sampleNoun: string;
  /** This sub-pillar's word for a row with nothing wrong. Defaults to "Healthy".  */
  healthyStatus?: string;
}

// ─── Totals ──────────────────────────────────────────────────────────
export interface SubPillarTotals {
  score: number;
  analyzed: number;
  healthy: number;
  issues: number;
  critical: number;
  /** Labels so each sub-pillar speaks its own language. */
  analyzedLabel: string;
  healthyLabel: string;
  issuesLabel: string;
  criticalLabel: string;
  /** Small chip under the summary, e.g. "Average length · 58 chars". */
  contextLabel: string;
  contextValue: string;
  /**
   * Flagged-of-total per kind of thing, when the check counts more than one kind — products AND
   * pages. Null when every finding counts the same kind, which is most checks.
   */
  issueUnits?: Array<{ unit: string; flagged: number; of: number }> | null;
}

/** "product" → "products"; the units a check sends are simple English nouns. */
export function pluralUnit(unit: string, count: number): string {
  return count === 1 ? unit : `${unit}s`;
}

/**
 * How much of what this finding covers: "3 of 20 pages", "18 products", or a bare "18" for an
 * audit stored before findings sent their unit. Only what the check recorded — no share is
 * computed against a total the finding was not measured over.
 */
export function affectedPhrase(finding: Pick<SubPillarFinding, 'affected' | 'affectedLabel' | 'population'>): string {
  const count = finding.affected.toLocaleString();
  const label = finding.affectedLabel?.trim();
  if (typeof finding.population === 'number' && finding.population > 0) {
    return `${count} of ${finding.population.toLocaleString()}${label ? ` ${label}` : ''}`;
  }
  return label ? `${count} ${label}` : count;
}

/** "5 of 48 products and 3 of 20 pages". */
export function describeIssueUnits(units: Array<{ unit: string; flagged: number; of: number }>): string {
  return units
    .map((entry) => `${entry.flagged.toLocaleString()} of ${entry.of.toLocaleString()} ${pluralUnit(entry.unit, entry.of)}`)
    .join(' and ');
}

export interface RelatedArea {
  label: string;
  href: string;
  hint?: string;
}

export interface SubPillarAnalysis {
  slug: string;
  title: string;
  description?: string;
  /** Enables the reusable test-safe bulk-fix workflow on supported sub-pillars only. */
  supportsBulkFix?: boolean;
  /** Selects the validation adapter used by the shared workflow. */
  bulkFixMode?: 'title-tags' | 'generic';
  /**
   * Which engine fills the recommended values.
   *
   * 'ai' asks a model to write them from the resource's own copy. 'template' renders them from a
   * pattern the merchant saved in this sub-pillar's settings, with no model, no key and no cost —
   * right for a formulaic field like image alt text, where a model adds variance rather than
   * correctness. It also decides what the workflow CALLS the action: offering "Draft with AI" for
   * a field no model touches misnames the thing the merchant is about to do.
   */
  bulkFixGenerator?: 'ai' | 'template';
  /**
   * What the storefront theme appends to every rendered `<title>`, as the audit measured it.
   *
   * The bulk-fix editor validates against the merchant's FIELD, but the audit scores the rendered
   * title — field plus this. Without it the editor would accept a 58-character value on a store
   * whose theme renders 79, and the next audit would re-flag the page it had just "fixed".
   * Null when no crawl ran or no suffix was consistently observed.
   */
  titleSuffix?: { value: string; observedOn: number; comparedPages: number } | null;
  /** Sentence under the status, written per sub-pillar. */
  summary: string;
  /** Chip beside the status, e.g. "94.5% healthy". */
  healthChip: string;
  totals: SubPillarTotals;
  findings: SubPillarFinding[];
  evidence: EvidenceConfig;
  relatedAreas: RelatedArea[];
  lastAnalyzed: string;
  /**
   * 'unavailable' means the check ran but could not measure anything (no articles to score, a
   * resource the granted scopes cannot read). `totals.score` is a placeholder in that case and
   * must not be rendered as a result. Defaults to 'ok' for static config and seeded fixtures.
   */
  status?: 'ok' | 'unavailable';
  /**
   * Which audit produced these numbers. 'seed' is a development fixture, and the page must say
   * so rather than presenting it as a measurement of the merchant's store. The backend has
   * always sent it; nothing read it, so a seeded database looked identical to a real audit.
   */
  source?: 'engine' | 'seed';
  /** Plain-language reason shown instead of the score when status is 'unavailable'. */
  unavailableReason?: string | null;
  /**
   * The Shopify permission the check could not proceed without, when that is the reason it is
   * unavailable. The page then offers Shopify's re-approval flow, not just the sentence.
   */
  requiredScope?: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────
/**
 * True when a row represents a problem.
 *
 * `healthyStatus` is the sub-pillar's own word for a good row — 'Lean' theme assets, 'Optimized'
 * images, 'Unique' copy. It defaults to 'Healthy' for configs and older audits that used it.
 */
export const isIssueStatus = (status: RowStatus, healthyStatus: string = HEALTHY): boolean =>
  status !== healthyStatus && status !== HEALTHY;

/**
 * The finding a given evidence row belongs to.
 *
 * Matching on issue type alone is ambiguous: several findings in one sub-pillar can share a type
 * (many checks label every non-critical finding "Needs Work"), and a bare lookup then returns
 * whichever was raised first regardless of which row was clicked. So the row's own id is tried
 * against each finding's recorded rows first, and the type is only a fallback.
 */
export function findingForRow(
  row: EvidenceRow,
  findings: SubPillarFinding[],
  healthyStatus?: string,
): SubPillarFinding | undefined {
  if (!isIssueStatus(row.status, healthyStatus)) return undefined;
  const owner = findings.find((finding) => finding.evidenceRows?.some((candidate) => candidate.id === row.id));
  return owner ?? findings.find((finding) => finding.issueType === row.status);
}

/**
 * The evidence the investigation drawer should show for a finding.
 *
 * WHEN THE USER PICKED ITEMS, THOSE ARE THE ONLY ITEMS SHOWN. Investigating an item is a question
 * about that item, so padding the panel with other examples of the same issue answers a question
 * nobody asked and reads as though the selection was ignored. One selected row shows one row;
 * three show three.
 *
 * With no selection — the drawer was opened from the findings list, where an issue was chosen but
 * no item — there is nothing to narrow to, so a sample stands in. It is drawn from:
 *   1. the rows the check itself attributed to this finding — authoritative; or
 *   2. the sub-pillar sample filtered by issue type — lossy, because two findings can share a
 *      type, but the only option for checks that attach no rows.
 */
export function investigationEvidence(
  finding: SubPillarFinding,
  sample: EvidenceRow[],
  selectedRows: EvidenceRow[],
  limit: number,
): EvidenceRow[] {
  if (selectedRows.length > 0) return selectedRows;
  const scoped = finding.evidenceRows?.length
    ? finding.evidenceRows
    : sample.filter((row) => row.status === finding.issueType);
  return scoped.slice(0, limit);
}

/** Severity for a row, resolved through the findings list. */
export function severityForStatus(
  status: RowStatus,
  findings: SubPillarFinding[],
  healthyStatus?: string,
): Severity | 'healthy' {
  if (!isIssueStatus(status, healthyStatus)) return 'healthy';
  return findings.find((finding) => finding.issueType === status)?.severity ?? 'low';
}

/** Findings ordered most severe first. */
export const bySeverity = (findings: SubPillarFinding[]): SubPillarFinding[] =>
  [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

/** Standard sorts every sub-pillar gets. */
export const sortBySeverity = (findings: SubPillarFinding[], healthyStatus?: string): SortOption => ({
  key: 'severity',
  label: 'Sort: severity',
  compare: (a, b) => {
    const rank = (row: EvidenceRow) => {
      const severity = severityForStatus(row.status, findings, healthyStatus);
      return severity === 'healthy' ? 99 : severityRank[severity];
    };
    return rank(a) - rank(b);
  },
});

export const sortByCell = (key: string, label: string, direction: 'asc' | 'desc' = 'asc'): SortOption => ({
  key: `${key}-${direction}`,
  label,
  compare: (a, b) => {
    const av = a.cells[key];
    const bv = b.cells[key];
    if (typeof av === 'number' && typeof bv === 'number') return direction === 'asc' ? av - bv : bv - av;
    const as = String(av ?? '');
    const bs = String(bv ?? '');
    return direction === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
  },
});
