import type { SubPillarEvidenceRow, SubPillarFindingResult } from '../../types.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import type { FetchedResource } from '../../storefront/types.js';
import { NEEDS_WORK } from '../shared/status.js';

/**
 * Why a requested file could not be interpreted at all, or null when the server gave a real answer.
 *
 * ─── A STATUS OF 0 IS NOT AN HTTP ANSWER ─────────────────────────────
 * The crawler records 0 for every request that produced no response it could use: a timeout, a
 * refused connection, a redirect loop, a body too large to read, and a redirect to ANOTHER HOST,
 * which it refuses to follow so a merchant's storefront can never point it at somebody else's
 * server. The checks used to push those through their status-code branches, where 0 fell below 200
 * and was reported as "The server answered with HTTP 0" — a response no server ever sent.
 *
 * The off-host redirect is the case that mattered most, because it is the usual way a Shopify
 * merchant publishes a root file: upload it under Content → Files, then add a URL redirect from the
 * root path to the file on Shopify's CDN. Rankvora AI does not follow that hop, so it did not read the
 * file — and says so, naming where the redirect points, rather than reporting a failure it never
 * observed.
 *
 * The password gate is not handled here: its response is a real 200 carrying the wrong page, and
 * each caller reports it in its own words.
 */
export function unreadableReason(resource: FetchedResource | null): string | null {
  if (!resource) return 'Not requested on this run';

  switch (resource.reason) {
    case 'timeout':
      return 'No response before the time limit';
    case 'dns':
    case 'connection':
    case 'ssl':
      return 'Rankvora AI could not reach this URL';
    case 'blocked':
      return `Redirects to ${hostOf(resource.finalUrl)}, outside your storefront — Rankvora AI only reads files served from your store’s own domain, so the contents were not checked`;
    case 'redirect_loop':
      return 'The URL redirects in a loop and never returns a file';
    case 'too_large':
      return 'The response was too large to read';
    case 'aborted':
      return 'The request was cancelled before it finished';
    default:
      break;
  }

  if (resource.status === 0) return 'No HTTP response was received';
  return null;
}

/** True when the file was not read because it redirects to a different host. */
export function redirectsOffHost(resource: FetchedResource | null): boolean {
  return resource?.reason === 'blocked';
}

/**
 * Why the rendered half of a check was not measured, and what — if anything — the merchant can do.
 *
 * Three different causes, and only one of them is the merchant's to fix: crawling switched off is
 * an operator setting, and a run that rendered no page is usually transient. Telling every store to
 * "remove the password" would be advice for a problem most of them do not have.
 */
export function renderedNotMeasured(snapshot: StoreSnapshot, noun: string): { detail: string; recommendation: string } {
  if (!snapshot.crawl) {
    return {
      detail: 'storefront crawling is switched off on this Rankvora AI server',
      recommendation: 'Nothing to change in your store. Rendered pages are read only when the server’s storefront crawl is switched on.',
    };
  }
  if (snapshot.crawl.passwordGated) {
    return {
      detail: 'the storefront is password protected',
      recommendation: 'Remove the storefront password under Online Store → Preferences in Shopify, then run the audit again.',
    };
  }
  return {
    detail: `no ${noun} was rendered on this run`,
    recommendation: `Run the audit again. If this repeats, check that your ${noun}s load for visitors.`,
  };
}

/**
 * The finding that owns rows Rankvora AI could not measure.
 *
 * Without one, such a row is an orphan: it carries NEEDS_WORK — the vocabulary's only word for a
 * row wanting attention — while no finding claims it, so the table offers a filter the issue total
 * says is empty, and Investigate falls back to whichever unrelated finding shares the status. (The
 * agents-md check established this; the other checks now follow it.)
 *
 * IT NEVER MOVES THE SCORE. Severity 'low' caps at 100 and scoreLift is 0: reading the thing
 * changes what is known, not what is passing.
 */
export function notCheckedFinding(input: {
  title: string;
  rows: SubPillarEvidenceRow[];
  affectedLabel: string;
  problem: string;
  why: string;
  recommendation: string;
  evidence: string[];
  /** How many things were not measured, when `rows` is only a sample of them. Defaults to the rows. */
  affectedCount?: number;
  /** What that count is out of, when the check reports shares per population. */
  population?: number;
}): SubPillarFindingResult {
  return {
    title: input.title,
    severity: 'low',
    affectedCount: input.affectedCount ?? input.rows.length,
    affectedLabel: input.affectedLabel,
    scoreLift: 0,
    resolutionType: 'settings',
    problem: input.problem,
    why: input.why,
    recommendation: input.recommendation,
    evidence: input.evidence,
    evidenceRows: input.rows,
    details: { issueType: NEEDS_WORK, notChecked: true, ...(input.population !== undefined ? { population: input.population } : {}) },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'another host';
  }
}
