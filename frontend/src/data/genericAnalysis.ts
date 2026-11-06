// ─── Generic sub-pillar analysis builder ─────────────────────────────
// Converts a GenericSubPillarConfig + detail table into the shared SubPillarAnalysis contract.
// Moved out of NonSeoSubPillarPage so the export script (a node script, no React) can reuse
// exactly the same conversion the page performs.
//
// ─── THIS BUILDS PRESENTATION CONFIG ONLY ────────────────────────────
// Everything it returns that looks like a measurement — score, analyzed, healthy, issues,
// critical, findings, evidence rows, summary, healthChip, lastAnalyzed — is a placeholder that
// `fetchSubPillarAnalysis` REPLACES with what the backend actually measured, before the page
// renders anything (the page shows a skeleton until that resolves).
//
// So every one of those fields is written here as 0, an empty array or null. It used to take them
// from per-pillar mock files, which meant a realistic-looking score and a list of invented
// findings sat one render away from the screen at all times. They were never displayed, but
// "never displayed" is a property of code that can change; a zero cannot be mistaken for a
// measurement, and a fabricated number can.
//
// What this DOES legitimately carry is the static presentation config: titles,
// column definitions, search keys and the LABELS beside each total ("Products", "Healthy",
// "Issues"). Those describe what a sub-pillar measures, not what it found.

import type { CellValue, EvidenceConfig, EvidenceRow, SubPillarAnalysis, SubPillarFinding } from './seo/subpillar.model';
import type { GenericSubPillarConfig, GenericSubPillarDetails, GenericTableColumn, GenericTableRow, TableCellValue } from '../pages/pillarCatalogs/genericTypes';

function genericColumnToEvidence(column: GenericTableColumn): EvidenceConfig['columns'][number] {
  const variant = column.variant === 'mono' ? 'mono' : column.variant === 'muted' ? 'muted' : column.variant === 'number' ? 'number' : column.variant === 'status' ? 'status' : 'text';
  return { key: column.key, header: column.header, align: column.align, variant };
}

// Evidence cells don't render a bool icon variant (see genericColumnToEvidence's 'text' fallback for 'bool' columns),
// so booleans are normalized to the same Yes/No wording used by the generic table's check/dash icon labels.
function normalizeCellValue(value: TableCellValue): CellValue {
  return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
}

function normalizeCells(cells: Record<string, TableCellValue>): Record<string, CellValue> {
  return Object.fromEntries(
    Object.entries(cells).map(([key, value]): [key: string, value: CellValue] => [key, normalizeCellValue(value)]),
  );
}

/**
 * Column config for a sub-pillar whose catalog entry declares no table.
 *
 * Rows are empty rather than generated. The previous version invented one row per mock finding,
 * named `<key>-sample-1`, `<key>-sample-2` — resource identifiers for resources that do not
 * exist. Those were replaced by real rows on load like everything else, but a table of invented
 * resource names is exactly the artefact that gets mistaken for evidence.
 */
function emptyEvidence(config: GenericSubPillarConfig): EvidenceConfig {
  return {
    title: `${config.title} Evidence`,
    caption: '',
    searchPlaceholder: 'Search evidence…',
    searchKeys: ['item', 'issue'],
    columns: [
      { key: 'item', header: 'Resource', variant: 'mono' },
      { key: 'issue', header: 'Finding', variant: 'text' },
      { key: 'affected', header: 'Affected', variant: 'number', align: 'right' },
      { key: 'status', header: 'Issue', variant: 'status' },
      { key: 'action', header: 'Action', variant: 'action', align: 'right' },
    ],
    rows: [],
    sorts: [],
    sampleNoun: config.analyzedLabel.toLowerCase(),
  };
}

export function buildAnalysis(routeKey: string, config: GenericSubPillarConfig, details?: GenericSubPillarDetails): SubPillarAnalysis {
  // Always empty: the repository replaces this wholesale with the audit's real findings.
  const findings: SubPillarFinding[] = [];
  const table = details?.table;

  const evidence: EvidenceConfig = table
    ? {
      title: table.title,
      caption: table.subtitle,
      searchPlaceholder: table.searchPlaceholder,
      searchKeys: table.searchKeys ?? table.columns.map((column) => column.key),
      columns: [...table.columns.map(genericColumnToEvidence), { key: 'action', header: 'Action', variant: 'action', align: 'right' }],
      // Any rows a catalog still declares are structural examples of the column shape, and are
      // replaced on load. They are carried through rather than dropped so an entry that has not
      // been migrated yet keeps rendering, but nothing should add more.
      rows: table.rows.map((row: GenericTableRow): EvidenceRow => ({
        id: row.id,
        status: row.status,
        facet: row.status,
        cells: normalizeCells(row.cells),
        current: { label: 'Detected', value: String(row.cells[table.columns[0]?.key] ?? row.id), meta: String(row.cells[table.columns[1]?.key] ?? '') },
        suggested: { label: 'Recommendation', value: String(row.cells.recommendation ?? row.cells[table.columns[table.columns.length - 1]?.key] ?? 'Review this item') },
      })),
      sorts: [],
      sampleNoun: config.analyzedLabel.toLowerCase(),
    }
    : emptyEvidence(config);

  return {
    slug: routeKey,
    title: config.title,
    supportsBulkFix: true,
    bulkFixMode: 'generic',
    // Replaced by the API before render. Empty rather than a sentence describing numbers that
    // were never measured.
    summary: '',
    healthChip: '',
    totals: {
      // Every NUMBER here is replaced by the audit's own. Only the labels survive, and a label
      // is a description of what is counted, not a count.
      score: 0,
      analyzed: 0,
      healthy: 0,
      issues: 0,
      critical: 0,
      analyzedLabel: config.analyzedLabel,
      healthyLabel: 'Healthy',
      issuesLabel: 'Issues',
      criticalLabel: 'Critical',
      contextLabel: '',
      contextValue: '',
    },
    findings,
    evidence,
    relatedAreas: [],
    // Replaced by the audit's real timestamp. Previously a hardcoded "Today, 10:42 AM".
    lastAnalyzed: '',
  };
}
