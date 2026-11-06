// ─── Generic sub-pillar config types ─────────────────────────────────
// Shared by the pillar catalogs (pages/pillarCatalogs/*Catalog.ts), the
// detail tables (*Tables.ts), NonSeoSubPillarPage, and the seed-data
// export script — kept free of React imports so node scripts can load it.

export interface GenericIssue {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  affected: number;
  recommendation: string;
}

export interface GenericSubPillarConfig {
  pillar: string;
  pillarLabel: string;
  key: string;
  title: string;
  score: number;
  statusLabel: string;
  analyzedLabel: string;
  analyzed: number;
  healthy: number;
  metrics: Array<{ label: string; value: number | string; description: string; footnote?: string; filter?: string }>;
  breakdown: Array<{ label: string; value: number; color: string }>;
  issues: GenericIssue[];
}

export type TableCellValue = string | number | boolean | null;

export interface GenericTableColumn {
  key: string;
  header: string;
  align?: 'left' | 'center' | 'right';
  /**
   * text   → regular cell
   * mono   → monospace, muted (URLs, handles, filenames)
   * muted  → small muted text (long descriptions / recommendations)
   * number → tabular numerals
   * bool   → check / dash icon
   * status → badge driven by row.status (column key is ignored)
   */
  variant?: 'text' | 'mono' | 'muted' | 'number' | 'bool' | 'status';
}

export interface GenericTableRow {
  id: string;
  /** Must be one of table.filters (other than "All"). */
  status: string;
  cells: Record<string, TableCellValue>;
}

export interface GenericTable {
  title: string;
  subtitle: string;
  searchPlaceholder: string;
  filters: string[];
  statusClass: Record<string, string>;
  columns: GenericTableColumn[];
  rows: GenericTableRow[];
  /** Column keys searched by the search box. Defaults to all string cells. */
  searchKeys?: string[];
}

export interface GenericOpportunity {
  id: string;
  title: string;
  description: string;
  ctaLabel: string;
  /** Table filter to apply when selected. */
  filter?: string;
}

export interface GenericSubPillarDetails {
  table: GenericTable;
  opportunities: GenericOpportunity[];
}
