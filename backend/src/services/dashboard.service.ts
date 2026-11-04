import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditScores, audits } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import { listPriorityFindings } from './finding.service.js';
import { assertAuditOfConnectedShop, auditedShopOf, isMeasuredAudit } from './audit.service.js';

/** How far back to look for a measured audit to compare against. The one before the latest is
 * almost always it; the window only matters after a run that measured nothing. */
const PREVIOUS_WINDOW = 10;

export async function getDashboardSummary(userId: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  // Ordered by runAt AND id, because the priority findings below are scoped to MAX(audits.id)
  // (see latestAuditCondition in finding.service.ts) and the two have to name the same audit.
  // `run_at` has millisecond precision here (it was whole seconds on MySQL, and rows copied from there
  // still are), so two audits can still share a timestamp, and without a tie-break the database picks
  // either — the header could describe one audit while the issue list described the other. Breaking
  // the tie by id makes "latest" one definition.
  //
  // Engine audits only, as the findings are: a 'seed' fixture is never this store's result.
  const auditRows = await db
    .select()
    .from(audits)
    .where(and(eq(audits.storeId, resolvedStoreId), eq(audits.source, 'engine')))
    .orderBy(desc(audits.runAt), desc(audits.id))
    .limit(PREVIOUS_WINDOW);
  const latest = auditRows[0];
  if (!latest) throw new ApiError(404, 'No audits found', 'AUDITS_NOT_FOUND');

  // The latest audit must be of the shop connected NOW. After a Disconnect and a different shop
  // connecting to the same store, the history still describes the old shop — its score, its
  // issues — and the dashboard would present them under the new shop's name. The sub-pillar pages
  // already refuse this; the dashboard answered with the old shop's data.
  await assertAuditOfConnectedShop(resolvedStoreId, latest);

  // The change chip compares against the previous MEASURED audit of the SAME shop. An audit that
  // measured nothing stores a placeholder 0, and "+49 since last analysis" measured against that
  // zero would be a change nobody observed.
  const latestShop = auditedShopOf(latest);
  const previous = auditRows
    .slice(1)
    .find((audit) => isMeasuredAudit(audit) && (latestShop === null || auditedShopOf(audit) === latestShop)) ?? null;

  const scores = await db.select().from(auditScores).where(eq(auditScores.auditId, latest.id));
  const priorityFindings = await listPriorityFindings(userId, resolvedStoreId);
  return { latest, previous, scores, priorityFindings };
}
