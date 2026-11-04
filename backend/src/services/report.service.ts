import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditScores, audits, findings, stores } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import { auditedShopOf, engineAuditsOf, isMeasuredAudit } from './audit.service.js';
import { pillarLabel, pillarRank, scoreStatus, severityRank, subPillarLabel } from '../lib/report-labels.js';
import type { ReportExportQuery, ReportTrendQuery } from '../schemas/report.schema.js';

/**
 * The overall score over the store's recent audits, oldest first — the dashboard's trend line.
 *
 * Only points that ARE scores of this store:
 *   · engine audits — a 'seed' fixture never is;
 *   · measured audits — one that measured nothing stores a placeholder 0 (runner.ts), which the
 *     chart would plot as a real collapse to zero;
 *   · the shop the newest audit read — after a different shop is connected to the same store, the
 *     older audits describe another store and must not be drawn on the same line.
 *
 * Filtered after the read because the flags live in the JSON metadata column; the read is widened
 * so a run that measured nothing does not cost the chart a point.
 */
export async function getReportTrend(userId: number, { limit }: ReportTrendQuery, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const candidates = await db
    .select()
    .from(audits)
    .where(engineAuditsOf(resolvedStoreId))
    .orderBy(desc(audits.runAt), desc(audits.id))
    .limit(limit * 3);
  const newestShop = candidates[0] ? auditedShopOf(candidates[0]) : null;
  const points = candidates
    .filter((audit) => isMeasuredAudit(audit) && (newestShop === null || auditedShopOf(audit) === newestShop))
    .slice(0, limit);
  return points.reverse().map((audit) => ({ id: audit.id, runAt: audit.runAt, overallScore: audit.overallScore }));
}

export async function getReportComparison(userId: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const auditRows = await db.select().from(audits).where(engineAuditsOf(resolvedStoreId)).orderBy(desc(audits.runAt), desc(audits.id)).limit(2);
  if (auditRows.length === 0) throw new ApiError(404, 'No completed audits found', 'AUDITS_NOT_FOUND');

  const current = auditRows[0];
  const previous = auditRows[1] ?? null;
  const currentScores = await db.select().from(auditScores).where(eq(auditScores.auditId, current.id));
  const previousScores = previous ? await db.select().from(auditScores).where(eq(auditScores.auditId, previous.id)) : [];
  return { current, previous, currentScores, previousScores };
}

export function escapeCsv(value: string | number | Date | null) {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// ─── CSV export ───────────────────────────────────────────────────────
//
// The old export was five columns of `audit_scores` in whatever order the database returned them, with
// sub-pillar rows and pillar rows interleaved and no way to tell which was which. What follows is
// a report: a summary of the run, the pillar comparison the Reports page shows, the sub-pillar
// breakdown behind it, and the prioritised issue list — each a clean table, in the order a person
// reads an audit.

type ScoreRow = typeof auditScores.$inferSelect;
type AuditRow = typeof audits.$inferSelect;

/** `details.status === 'unavailable'` means the stored score is a placeholder, not a result. */
function isMeasured(score: ScoreRow): boolean {
  const details = (score.details ?? {}) as { status?: string };
  return details.status !== 'unavailable';
}

function scoreCell(score: ScoreRow): string {
  return isMeasured(score) ? String(score.score) : 'Not measured';
}

/** UTC, spelled out. A bare ISO string in a spreadsheet cell is read as text and sorts wrong. */
function reportDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** 'critical' / 'open' are storage values. A column a person reads says "Critical" and "Open". */
function sentence(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

function row(cells: (string | number | null)[]): string {
  return cells.map(escapeCsv).join(',');
}

async function resolveExportAudit(storeId: number, auditId?: number): Promise<{ current: AuditRow; previous: AuditRow | null }> {
  const where = auditId ? and(engineAuditsOf(storeId), eq(audits.id, auditId)) : engineAuditsOf(storeId);
  const [current] = await db.select().from(audits).where(where).orderBy(desc(audits.runAt), desc(audits.id)).limit(1);
  // A missing audit and an audit belonging to someone else are the same 404 — the store filter
  // above is what makes an id from another merchant's account unreachable, not a later check.
  if (!current) {
    throw new ApiError(404, auditId ? 'Report not found' : 'No completed audits found', auditId ? 'REPORT_NOT_FOUND' : 'AUDITS_NOT_FOUND');
  }

  // The previous MEASURED audit: one that measured nothing stores a placeholder 0 as its score,
  // and the export would print that 0 as "previous overall" and a "Change" computed against it.
  const earlier = await db
    .select()
    .from(audits)
    .where(and(engineAuditsOf(storeId), lt(audits.runAt, current.runAt)))
    .orderBy(desc(audits.runAt), desc(audits.id))
    .limit(10);

  return { current, previous: earlier.find(isMeasuredAudit) ?? null };
}

export interface ReportCsvResult {
  csv: string;
  filename: string;
}

export async function getReportCsv(userId: number, query: ReportExportQuery = {}): Promise<ReportCsvResult> {
  const resolvedStoreId = await getCurrentStoreId(userId, query.storeId);
  const [store] = await db.select().from(stores).where(eq(stores.id, resolvedStoreId)).limit(1);
  const { current, previous } = await resolveExportAudit(resolvedStoreId, query.auditId);

  const [currentScores, previousScores, issueRows] = await Promise.all([
    db.select().from(auditScores).where(eq(auditScores.auditId, current.id)),
    previous ? db.select().from(auditScores).where(eq(auditScores.auditId, previous.id)) : Promise.resolve([] as ScoreRow[]),
    db.select().from(findings).where(eq(findings.auditId, current.id)),
  ]);

  const previousByKey = new Map(previousScores.map((score) => [`${score.pillar}:${score.subPillar ?? ''}`, score]));
  const overallMeasured = (current.metadata as { overallAvailable?: boolean } | null)?.overallAvailable !== false;
  const lines: string[] = [];

  // ── 1. Report summary ──────────────────────────────────────────────
  lines.push(row(['Rankvora AI report']));
  lines.push(row(['Store', store?.name ?? '']));
  lines.push(row(['Store URL', store?.url ?? '']));
  lines.push(row(['Report date', reportDate(current.runAt)]));
  lines.push(row(['Compared with', previous ? reportDate(previous.runAt) : 'No earlier audit']));
  lines.push(row(['Overall score', overallMeasured ? String(current.overallScore) : 'Not measured']));
  lines.push(row(['Previous overall score', previous ? String(previous.overallScore) : '']));
  lines.push(row(['Change', previous && overallMeasured ? signed(current.overallScore - previous.overallScore) : '']));
  lines.push(row(['Issues found', String(issueRows.length)]));
  // A seeded fixture must never leave the building looking like a real audit of the store.
  if (current.source !== 'engine') lines.push(row(['Data source', `${current.source} (not a live audit of this store)`]));
  lines.push('');

  // ── 2. Pillar performance ──────────────────────────────────────────
  const pillarRows = currentScores
    .filter((score) => score.subPillar === null)
    .sort((a, b) => pillarRank(a.pillar) - pillarRank(b.pillar));

  lines.push(row(['Pillar performance']));
  lines.push(row(['Pillar', 'Current score', 'Previous score', 'Change', 'Status', 'Checks passed', 'Checks total']));
  for (const score of pillarRows) {
    const before = previousByKey.get(`${score.pillar}:`);
    const measured = isMeasured(score);
    lines.push(row([
      pillarLabel(score.pillar),
      scoreCell(score),
      before && isMeasured(before) ? String(before.score) : '',
      before && isMeasured(before) && measured ? signed(score.score - before.score) : '',
      measured ? scoreStatus(score.score) : 'Not measured',
      score.checksPassed ?? '',
      score.checksTotal ?? '',
    ]));
  }
  lines.push('');

  // ── 3. Sub-pillar breakdown ────────────────────────────────────────
  // Sorted by the LABEL, not the slug: the reader sees "Canonicals & duplicates" before
  // "Image alt text", so ordering by 'canonicals' vs 'image-alt-text' would look arbitrary.
  const subPillarRows = currentScores
    .filter((score) => score.subPillar !== null)
    .sort((a, b) =>
      pillarRank(a.pillar) - pillarRank(b.pillar)
      || subPillarLabel(a.subPillar ?? '').localeCompare(subPillarLabel(b.subPillar ?? '')));

  lines.push(row(['Sub-pillar breakdown']));
  lines.push(row(['Pillar', 'Sub-pillar', 'Score', 'Status', 'Items analyzed', 'Items healthy', 'Items with issues', 'Notes']));
  for (const score of subPillarRows) {
    const details = (score.details ?? {}) as { status?: string; unavailableReason?: string; summary?: string };
    const measured = isMeasured(score);
    const analyzed = score.analyzedCount ?? 0;
    const healthy = score.healthyCount ?? 0;
    lines.push(row([
      pillarLabel(score.pillar),
      subPillarLabel(score.subPillar ?? ''),
      scoreCell(score),
      measured ? scoreStatus(score.score) : 'Not measured',
      measured ? analyzed : '',
      measured ? healthy : '',
      measured ? Math.max(analyzed - healthy, 0) : '',
      // The reason a check could not measure is the most useful thing on an unmeasured row.
      measured ? details.summary ?? '' : details.unavailableReason ?? '',
    ]));
  }
  lines.push('');

  // ── 4. Issues, most severe first ───────────────────────────────────
  lines.push(row(['Issues']));
  lines.push(row(['Priority', 'Severity', 'Pillar', 'Sub-pillar', 'Issue', 'Status', 'Affected items', 'Affected unit', 'Share of sub-pillar affected (%)', 'Recommendation']));
  if (issueRows.length === 0) {
    // Padded to the header's width so the block stays a rectangle a spreadsheet can read.
    lines.push(row(['', '', '', '', 'No issues found in this audit', '', '', '', '', '']));
  } else {
    const ordered = [...issueRows].sort((a, b) =>
      severityRank(a.severity) - severityRank(b.severity)
      || pillarRank(a.pillar) - pillarRank(b.pillar)
      || b.affectedCount - a.affectedCount
      || a.title.localeCompare(b.title));

    ordered.forEach((finding, index) => {
      lines.push(row([
        index + 1,
        sentence(finding.severity),
        pillarLabel(finding.pillar),
        subPillarLabel(finding.subPillar),
        finding.title,
        sentence(finding.status),
        finding.affectedCount,
        finding.affectedLabel,
        // The share of the sub-pillar's analyzed items this finding covers — not score points,
        // which is what the old "Potential score lift" heading and its "+" sign implied.
        finding.scoreLift > 0 ? finding.scoreLift : '',
        finding.recommendation,
      ]));
    });
  }

  const slug = (store?.name ?? 'store').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'store';
  const stamp = reportDate(current.runAt).slice(0, 10);
  // \r\n: Excel treats a lone \n inside a quoted cell as a row break on some platforms.
  return { csv: lines.join('\r\n'), filename: `rankvora-ai-report-${slug}-${stamp}.csv` };
}
