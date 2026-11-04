import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chunkForD1 } from '../db/limits.js';
import { updateReturning } from '../db/returning.js';
import { audits, findings, onboardingState } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { orderedPillars } from '../lib/pillarPriority.js';
import { PILLAR_KEYS } from '../schemas/onboarding.schema.js';
import { getCurrentStoreId } from './store.service.js';
import type { BulkFindingStatusInput, FindingListQuery, UpdateFindingStatusInput } from '../schemas/finding.schema.js';

function storeFindingCondition(storeId: number) {
  return eq(audits.storeId, storeId);
}

/**
 * Findings belong to ONE audit, and every re-run writes a fresh set. Scoping reads to the newest
 * audit is what stops the Fix Center showing the same issue once per historical run — three
 * audits of this store were rendering 48 rows for 16 real problems, and "10 open" on the
 * dashboard was counting the same handful of issues repeatedly.
 *
 * Correlated subquery rather than a second round trip, so the list and its COUNT(*) can never
 * disagree about which audit they are describing.
 *
 * ENGINE AUDITS ONLY. A 'seed' audit is a development fixture (see audits.source in schema.ts);
 * if one ever sits in a database with a higher id than the store's real audits, an unfiltered
 * MAX(id) would hand its invented findings to the dashboard and the Fix Center as this store's.
 */
export function latestAuditCondition(storeId: number) {
  return eq(
    findings.auditId,
    sql`(SELECT MAX(${audits.id}) FROM ${audits} WHERE ${audits.storeId} = ${storeId} AND ${audits.source} = 'engine')`,
  );
}

/**
 * Severity is a varchar, so ORDER BY severity DESC sorted it ALPHABETICALLY —
 * medium > low > high > critical — which pushed critical findings to the very bottom of the
 * "priority" list. In practice /findings/priority returned ten mediums and never surfaced a
 * critical or high at all. This CASE imposes the real severity ladder instead — the same ranks
 * MySQL's FIELD() gave, which SQLite does not have: 1 for critical up to 4 for low.
 */
const severityRank = sql`CASE ${findings.severity} WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 0 END`;

function optionalConditions(query: FindingListQuery) {
  const conditions = [];
  if (query.pillar) conditions.push(eq(findings.pillar, query.pillar));
  if (query.subPillar) conditions.push(eq(findings.subPillar, query.subPillar));
  if (query.status) conditions.push(eq(findings.status, query.status));
  if (query.severity) conditions.push(eq(findings.severity, query.severity));
  if (query.search) {
    // instr(), not LIKE. D1 refuses a LIKE pattern over 50 bytes, and a search box takes longer
    // phrases than that; with '%' on both ends of the phrase the pattern is 2 bytes longer still.
    // instr() takes any length, and it reads '%' and '_' as the characters they are, where LIKE
    // read them as wildcards. Case is folded on both sides by SQLite's lower(), which handles
    // ASCII letters only — exactly what LIKE did here.
    const has = (column: typeof findings.title | typeof findings.subPillar | typeof findings.recommendation) =>
      sql`instr(lower(${column}), lower(${query.search})) > 0`;
    conditions.push(or(has(findings.title), has(findings.subPillar), has(findings.recommendation)));
  }
  return conditions;
}

export async function listFindings(userId: number, query: FindingListQuery, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const pillarOrder = await pillarPriorityOrder(resolvedStoreId);
  const offset = (query.page - 1) * query.limit;
  const conditions = [storeFindingCondition(resolvedStoreId), latestAuditCondition(resolvedStoreId), ...optionalConditions(query)];
  const where = and(...conditions);
  const [items, [{ total }]] = await Promise.all([
    db.select({ finding: findings }).from(findings).innerJoin(audits, eq(findings.auditId, audits.id)).where(where).orderBy(...(pillarOrder ? [severityRank, pillarOrder] : [severityRank]), desc(findings.affectedCount), desc(findings.id)).limit(query.limit).offset(offset),
    db.select({ total: count() }).from(findings).innerJoin(audits, eq(findings.auditId, audits.id)).where(where),
  ]);

  return {
    items: items.map(({ finding }) => finding),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  };
}

/**
 * A tie-break by the merchant's own order of pillars, or null when they never chose one.
 *
 * Applied AFTER severity and BEFORE the affected count: a critical issue still outranks a medium
 * one in any pillar — choosing "AI discovery first" decides what leads among issues of equal
 * severity, it does not bury a critical SEO problem under a medium one elsewhere. Built from the
 * product's own pillar keys and bound as parameters, never from text the merchant typed.
 */
async function pillarPriorityOrder(storeId: number) {
  const [row] = await db
    .select({ priorityPillars: onboardingState.priorityPillars })
    .from(onboardingState)
    .where(eq(onboardingState.storeId, storeId))
    .limit(1);

  const order = orderedPillars(row?.priorityPillars, PILLAR_KEYS);
  if (!order) return null;
  const whens = order.map((pillar, index) => sql`WHEN ${pillar} THEN ${index}`);
  return sql`CASE ${findings.pillar} ${sql.join(whens, sql` `)} ELSE ${order.length} END`;
}

export async function listPriorityFindings(userId: number, storeId?: number, limit = 10) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const pillarOrder = await pillarPriorityOrder(resolvedStoreId);
  const rows = await db
    .select({ finding: findings })
    .from(findings)
    .innerJoin(audits, eq(findings.auditId, audits.id))
    .where(and(
      storeFindingCondition(resolvedStoreId),
      latestAuditCondition(resolvedStoreId),
      inArray(findings.status, ['open', 'reviewed']),
    ))
    .orderBy(...(pillarOrder ? [severityRank, pillarOrder] : [severityRank]), desc(findings.affectedCount))
    .limit(limit);
  // Unwrapped here rather than by each caller: GET /findings/priority was returning the raw
  // join shape [{ finding: {...} }], so every consumer had to know about the wrapper.
  return rows.map(({ finding }) => finding);
}

export async function getFinding(userId: number, id: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const [result] = await db.select({ finding: findings }).from(findings).innerJoin(audits, eq(findings.auditId, audits.id)).where(and(eq(findings.id, id), storeFindingCondition(resolvedStoreId))).limit(1);
  if (!result) throw new ApiError(404, 'Finding not found', 'FINDING_NOT_FOUND');
  return result.finding;
}

export async function updateFindingStatus(userId: number, id: number, input: UpdateFindingStatusInput, storeId?: number) {
  return updateFindingStatusInStore(await getCurrentStoreId(userId, storeId), id, input);
}

/**
 * The same change for a caller that has already worked out which store it is acting for. A request
 * that changes many findings looks the store up once rather than once per finding — every query counts
 * toward D1's 1,000 per request.
 */
export async function updateFindingStatusInStore(resolvedStoreId: number, id: number, input: UpdateFindingStatusInput) {
  // The store's audits as a sub-query, not a list of their ids: a store gains an audit every run, and
  // D1 refuses a statement that binds more than 100 values.
  const storeAudits = db.select({ id: audits.id }).from(audits).where(eq(audits.storeId, resolvedStoreId));
  const [updated] = await updateReturning(findings, { status: input.status, statusChangedAt: new Date() }, and(eq(findings.id, id), inArray(findings.auditId, storeAudits)));
  if (!updated) throw new ApiError(404, 'Finding not found', 'FINDING_NOT_FOUND');
  return updated;
}

export async function bulkUpdateFindingStatus(userId: number, input: BulkFindingStatusInput, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  // A request may name 100 findings; D1 takes at most 100 bound values in a statement, and the store
  // sits beside the ids. So the ids go in pieces — checked first, then changed together in one batch.
  const pieces = chunkForD1(input.ids);
  const eligibleIds: number[] = [];
  for (const ids of pieces) {
    const eligible = await db.select({ id: findings.id }).from(findings).innerJoin(audits, eq(findings.auditId, audits.id)).where(and(storeFindingCondition(resolvedStoreId), inArray(findings.id, ids)));
    eligibleIds.push(...eligible.map(({ id }) => id));
  }
  if (eligibleIds.length !== input.ids.length) throw new ApiError(404, 'One or more findings were not found', 'FINDINGS_NOT_FOUND');

  const statusChangedAt = new Date();
  const updates = chunkForD1(eligibleIds).map((ids) => db.update(findings).set({ status: input.status, statusChangedAt }).where(inArray(findings.id, ids)).returning());
  const changed = await db.batch(updates as unknown as [(typeof updates)[number], ...typeof updates]);
  return (changed as Array<Array<typeof findings.$inferSelect>>).flat();
}
