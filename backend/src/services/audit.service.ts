import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditScores, audits, findings, shopifyConnections } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import { fixabilityFor, getFixContext } from './fixability.service.js';
import type { AuditListQuery, LatestAuditQuery } from '../schemas/audit.schema.js';

/**
 * Every read of a store's audits goes through this condition: the store's own rows, and only those
 * the engine produced from the live store. A 'seed' audit is a development fixture (audits.source
 * in schema.ts) and is never a result to show a merchant, labelled or not.
 */
export function engineAuditsOf(storeId: number) {
  return and(eq(audits.storeId, storeId), eq(audits.source, 'engine'));
}

export async function listAudits(userId: number, { page, limit }: AuditListQuery, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const offset = (page - 1) * limit;
  const [items, [{ total }]] = await Promise.all([
    db.select().from(audits).where(engineAuditsOf(resolvedStoreId)).orderBy(desc(audits.runAt), desc(audits.id)).limit(limit).offset(offset),
    db.select({ total: count() }).from(audits).where(engineAuditsOf(resolvedStoreId)),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getLatestAudit(userId: number, { pillar }: LatestAuditQuery, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const [audit] = await db.select().from(audits).where(engineAuditsOf(resolvedStoreId)).orderBy(desc(audits.runAt), desc(audits.id)).limit(1);
  if (!audit) throw new ApiError(404, 'Latest audit not found', 'AUDIT_NOT_FOUND');
  // The pillar dashboards read this. After a different shop is connected, the latest audit is the
  // previous shop's, and its scores must not appear under the new shop's name.
  await assertAuditOfConnectedShop(resolvedStoreId, audit);

  const conditions = [eq(auditScores.auditId, audit.id)];
  if (pillar) conditions.push(eq(auditScores.pillar, pillar));
  const scores = await db.select().from(auditScores).where(and(...conditions));
  return { audit, scores };
}

export async function getAuditScores(userId: number, id: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const [audit] = await db.select().from(audits).where(and(eq(audits.id, id), engineAuditsOf(resolvedStoreId))).limit(1);
  if (!audit) throw new ApiError(404, 'Audit not found', 'AUDIT_NOT_FOUND');

  const scores = await db.select().from(auditScores).where(eq(auditScores.auditId, id));
  return { audit, scores };
}

interface SubPillarScoreDetails {
  /** 'unavailable' means the check could not measure this — the UI must render that state
   * rather than the numeric score, which is meaningless in that case. */
  status?: 'ok' | 'unavailable';
  unavailableReason?: string;
  summary?: string;
  healthChip?: string;
  contextLabel?: string;
  contextValue?: string;
  healthyStatus?: string;
  evidenceRows?: unknown[];
  /** Measured by the title-tags check from the crawl; see audit-engine/types.ts. */
  titleSuffix?: { value: string; observedOn: number; comparedPages: number } | null;
  /** The Shopify permission an 'unavailable' result is waiting on, when that is the reason. */
  requiredScope?: string;
  /** The check's own count of items with an issue, in the unit `analyzedCount` counts. */
  issueCount?: number;
  /** Flagged-of-total per kind of thing, for a check whose findings count more than one kind. */
  issueUnits?: Array<{ unit: string; flagged: number; of: number }>;
}

/** The shop an engine audit read, as it recorded it. Null for audits that predate the field. */
export function auditedShopOf(audit: typeof audits.$inferSelect): string | null {
  const shop = (audit.metadata as { shopDomain?: unknown } | null)?.shopDomain;
  return typeof shop === 'string' && shop ? shop.toLowerCase() : null;
}

/**
 * False only when the engine recorded that it measured nothing (`overallAvailable: false`). Its
 * overall_score is then a NOT-NULL placeholder zero (runner.ts), not a score — so it must never be
 * plotted on a trend or used as the "previous" value a change is measured against.
 */
export function isMeasuredAudit(audit: typeof audits.$inferSelect): boolean {
  return (audit.metadata as { overallAvailable?: unknown } | null)?.overallAvailable !== false;
}

/**
 * Refuses an audit of a DIFFERENT shop than the one this store is connected to now.
 *
 * A store row keeps its audit history across Disconnect, and a different shop can then be
 * connected to it. Until that shop is audited, the latest audit describes the previous shop — its
 * redirects, its handles, its products — and showing it would present another store's data as
 * this one's. Each engine audit records the shop it read (metadata.shopDomain); when that is not
 * the shop connected now, the page is told there is no audit for this store yet, which is true.
 *
 * With no live connection the store's own history is still its own, so it is shown as it was.
 * Seeded audits carry no shop domain and are labelled as demo data by the UI.
 */
export async function assertAuditOfConnectedShop(storeId: number, audit: typeof audits.$inferSelect) {
  const auditedShop = auditedShopOf(audit);
  if (typeof auditedShop !== 'string' || !auditedShop) return;
  const [connection] = await db
    .select({ shopDomain: shopifyConnections.shopDomain })
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  if (connection && connection.shopDomain.toLowerCase() !== auditedShop.toLowerCase()) {
    throw new ApiError(
      404,
      `The latest audit was of ${auditedShop}, not ${connection.shopDomain}, the Shopify store connected now. Run an audit to see results for this store.`,
      'AUDIT_STALE_STORE',
    );
  }
}

interface FindingDetails {
  issueType?: string;
  /** What `affectedCount` is out of, when the check recorded it — see audit-engine/types.ts. */
  population?: number;
}

/**
 * Data-only slice of the frontend's SubPillarAnalysis contract (no columns/sorts/facet —
 * those are presentation config that stays in the frontend catalog, see backend-plan.md §3.1).
 */
export async function getSubPillarAnalysis(userId: number, pillar: string, subPillar: string, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const [audit] = await db.select().from(audits).where(engineAuditsOf(resolvedStoreId)).orderBy(desc(audits.runAt), desc(audits.id)).limit(1);
  if (!audit) throw new ApiError(404, 'Latest audit not found', 'AUDIT_NOT_FOUND');
  await assertAuditOfConnectedShop(resolvedStoreId, audit);

  const [scoreRow] = await db
    .select()
    .from(auditScores)
    .where(and(eq(auditScores.auditId, audit.id), eq(auditScores.pillar, pillar), eq(auditScores.subPillar, subPillar)))
    .limit(1);
  if (!scoreRow) throw new ApiError(404, 'Sub-pillar analysis not found', 'SUB_PILLAR_NOT_FOUND');

  const findingRows = await db
    .select()
    .from(findings)
    .where(and(eq(findings.auditId, audit.id), eq(findings.pillar, pillar), eq(findings.subPillar, subPillar)));

  const details = (scoreRow.details ?? {}) as SubPillarScoreDetails;
  // One read for the whole page, not one per finding: the answer depends on the store's granted
  // scopes and the server's AI configuration, neither of which varies between findings.
  const fixContext = await getFixContext(resolvedStoreId);

  return {
    slug: subPillar,
    // Seeded demo rows predate the status field; they are genuine measured fixtures, so
    // absence of an explicit status means 'ok' rather than 'unavailable'.
    status: details.status ?? 'ok',
    unavailableReason: details.unavailableReason ?? null,
    requiredScope: details.requiredScope ?? null,
    /** 'seed' marks development/demo fixtures so the UI can never present them as a real audit. */
    source: audit.source,
    summary: details.summary ?? '',
    healthChip: details.healthChip ?? '',
    // Sent so the bulk-fix editor validates against the same budget the audit scored: the theme's
    // suffix counts against the rendered title, so the merchant's field has less room than the
    // raw 30-60 range suggests. Null leaves the editor on that raw range, as before.
    titleSuffix: details.titleSuffix ?? null,
    totals: {
      score: scoreRow.score,
      analyzed: scoreRow.analyzedCount ?? 0,
      healthy: scoreRow.healthyCount ?? 0,
      // The check's own count when it recorded one: a check whose findings count products AND
      // pages must not have them added together into one "Issues" figure. Otherwise the sum of
      // affected items across findings (not a count of finding rows), floored at analyzed -
      // healthy — right when every finding counts the same kind of thing.
      issues: typeof details.issueCount === 'number'
        ? details.issueCount
        : Math.max(
          findingRows.reduce((sum, finding) => sum + finding.affectedCount, 0),
          (scoreRow.analyzedCount ?? 0) - (scoreRow.healthyCount ?? 0),
        ),
      issueUnits: Array.isArray(details.issueUnits) ? details.issueUnits : null,
      critical: findingRows.filter((finding) => finding.severity === 'critical').reduce((sum, finding) => sum + finding.affectedCount, 0),
      contextLabel: details.contextLabel ?? '',
      contextValue: details.contextValue ?? '',
    },
    findings: findingRows.map((finding) => {
      const findingDetails = (finding.details ?? {}) as FindingDetails;
      return {
        id: String(finding.id),
        issueType: findingDetails.issueType ?? finding.title,
        title: finding.title,
        severity: finding.severity,
        affected: finding.affectedCount,
        // Singular or plural noun of what `affected` counts, and what it is out of when known —
        // so a share is taken of its own population, not of a total mixing products and pages.
        affectedLabel: finding.affectedLabel,
        population: typeof findingDetails.population === 'number' ? findingDetails.population : null,
        // NO impact and NO effort. Both were words each check typed in by hand, the same for every
        // store; effort even defaulted to 'Medium' when a check had not typed one. `severity`, set
        // by the audit's rules, is what the page shows.
        whatIsWrong: finding.problem ?? '',
        whyItMatters: finding.why,
        recommendation: finding.recommendation,
        // What Rankvora AI can DO about this finding — auto / ai / needs_access / manual, with a
        // merchant-readable reason. Sent with the finding so the UI can advertise the capability
        // up front instead of hiding it behind a button nobody knows to look for.
        fix: fixabilityFor(finding, fixContext),
        // The rows THIS finding flagged, as recorded by the check that raised it. Without this the
        // UI can only re-derive a finding's evidence by matching issue type against the sub-pillar
        // sample, which returns the same handful of rows for every finding sharing that type.
        // Null for checks that raise a finding without attaching rows — the caller falls back.
        evidenceRows: (finding.evidenceRows as unknown[] | null) ?? undefined,
      };
    }),
    evidenceRows: details.evidenceRows ?? [],
    // Each sub-pillar names its own healthy state ('Lean', 'Optimized', 'Unique'…). Without this
    // the UI can only look for the literal word 'Healthy' and marks every good row as an issue.
    // Audits recorded before this field existed fall back to 'Healthy', which is what they used.
    healthyStatus: details.healthyStatus ?? 'Healthy',
    lastAnalyzed: audit.runAt,
  };
}
