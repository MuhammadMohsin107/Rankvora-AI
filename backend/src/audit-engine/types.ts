import type { StoreSnapshot } from './store-data/types.js';

export type PillarKey = 'seo' | 'content' | 'speed' | 'cro' | 'ai-discovery';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * A check's outcome status. `unavailable` MUST stay distinguishable from a passing score:
 * "we could not measure this" is never presented as "this is fine" (master prompt: DATA HONESTY).
 */
export type CheckStatus = 'ok' | 'unavailable';

export interface SubPillarEvidenceRow {
  id: string;
  status: string;
  facet?: string;
  cells: Record<string, unknown>;
  current?: { label: string; value: string; meta?: string };
  suggested?: { label: string; value: string; meta?: string };
  /** Extra context line shown under the current value in the investigation drawer. */
  note?: string;
  /**
   * What ONE row is, as a singular noun ('product', 'page'), when a check's table mixes kinds.
   * Lets the table count its sample per kind instead of calling twenty rendered pages "products".
   * Omitted by checks whose rows are all one kind.
   */
  unit?: string;
}

/**
 * NO `impact`, AND NO `effort`.
 *
 * Every finding used to carry both, typed in by hand: "Impact High · Effort Medium" for the same
 * issue in every store, whatever was found. Nothing measured either one, yet the pages, the Fix
 * Center, the dashboard, the CSV export and the AI prompt all presented them as properties of the
 * merchant's result. What a check DOES decide by rule is `severity` — and that is what is shown.
 */
export interface SubPillarFindingResult {
  title: string;
  severity: Severity;
  affectedCount: number;
  affectedLabel: string;
  scoreLift: number;
  resolutionType?: string | null;
  problem: string;
  why: string;
  recommendation: string;
  /** Human-readable evidence bullets shown in the Fix Center / investigation drawer. */
  evidence: string[];
  /** Structured rows naming the exact affected resources, so a customer can always answer
   * "which of my products caused this?" (master prompt: EVIDENCE). */
  evidenceRows?: SubPillarEvidenceRow[];
  details: {
    issueType: string;
    /**
     * How many items `affectedCount` is OUT OF — the population this finding was measured over
     * ("3 of 20 pages"). Set when a check's findings count different kinds of thing, so a share is
     * taken of the right whole instead of a total that mixes products and pages.
     */
    population?: number;
    /**
     * True when this "finding" records that something could NOT be read or is not settled yet
     * ("the agent-readable files could not be checked", "questions still gathering answers").
     * It is persisted so its evidence rows have an owner, but it is not a problem found in the
     * store: issue counts and issue lists leave it out, and it never moves a score.
     */
    notChecked?: boolean;
  };
}

export interface SubPillarResult {
  subPillar: string;
  status: CheckStatus;
  score: number;
  analyzedCount: number;
  healthyCount: number;
  details: {
    status: CheckStatus;
    /** Present when status is 'unavailable' — states plainly why it could not be measured. */
    unavailableReason?: string;
    summary: string;
    healthChip: string;
    contextLabel: string;
    contextValue: string;
    /**
     * The row status this check uses to mean "nothing wrong here".
     *
     * Each sub-pillar names its own healthy state — 'Lean' theme assets, 'Optimized' images,
     * 'Unique' copy — so a consumer cannot tell a good row from a bad one by looking for the
     * literal word 'Healthy'. Omit only when this check genuinely uses 'Healthy'.
     */
    healthyStatus?: string;
    /**
     * Set with status 'unavailable' when the missing piece is a Shopify permission — the exact
     * scope — so the page can offer the store's re-approval flow instead of only a sentence.
     */
    requiredScope?: string;
    /**
     * Items with an issue, in the unit `analyzedCount` counts — the check's own figure.
     *
     * Without it the API derives "Issues" by summing every finding's affected count, which is only
     * right when all findings count the same kind of thing. A check whose findings count products
     * AND pages sets this, so "Issues" never adds pages to products.
     */
    issueCount?: number;
    /**
     * Flagged-of-total per kind of thing, for a check whose findings span more than one:
     * [{ unit: 'product', flagged: 5, of: 48 }, { unit: 'page', flagged: 3, of: 20 }].
     */
    issueUnits?: Array<{ unit: string; flagged: number; of: number }>;
    evidenceRows: SubPillarEvidenceRow[];
    /**
     * The text the storefront theme appends to every rendered `<title>`, measured from the crawl
     * by the title-tags check (see deriveTitleSuffix there). Null when no crawl ran or no suffix
     * was consistently observed.
     *
     * It lives on the RESULT rather than only in the summary because the length budget it implies
     * has to reach everything that later writes a title — the AI fix planner and the bulk-fix
     * editor — so they aim at the same rendered result the audit scored.
     */
    titleSuffix?: { value: string; observedOn: number; comparedPages: number } | null;
  };
  findings: SubPillarFindingResult[];
}

/**
 * The single contract every audit check implements (master prompt: CHECK CONTRACT).
 * Checks are pure functions of a normalized snapshot — no Shopify calls, no DB access,
 * no React coupling — which is what makes them unit-testable in isolation.
 */
export interface AuditCheck {
  /** Stable identifier, e.g. 'seo.title-tags'. */
  id: string;
  pillar: PillarKey;
  /** Route slug matching pillarMeta.ts, e.g. 'title-tags'. */
  subPillar: string;
  execute(snapshot: StoreSnapshot): Promise<SubPillarResult> | SubPillarResult;
}

/** Builds the standard result for a check that genuinely could not measure anything. */
export function unavailableResult(subPillar: string, reason: string): SubPillarResult {
  return {
    subPillar,
    status: 'unavailable',
    // Score is meaningless here; the UI must render the status, not this number.
    score: 0,
    analyzedCount: 0,
    healthyCount: 0,
    details: {
      status: 'unavailable',
      unavailableReason: reason,
      summary: reason,
      healthChip: 'Unavailable',
      contextLabel: '',
      contextValue: '',
      evidenceRows: [],
    },
    findings: [],
  };
}
