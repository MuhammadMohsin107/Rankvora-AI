import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  HEALTHY,
  describeIssueUnits,
  findingForRow,
  isIssueStatus,
  pluralUnit,
  severityForStatus,
  type EvidenceColumn,
  type EvidenceConfig,
  type EvidenceRow,
  type RowStatus,
  type SubPillarFinding,
} from '../../../data/seo/subpillar.model';
import SeverityBadge from './SeverityBadge';
import BulkFixWorkflow from './BulkFixWorkflow';
import { card, cardHeader, cardHeadingRow, cardTitle, eyebrow } from './tone';
import { scrollChaining } from '../../../lib/scrollChaining';
import Button from '../../../components/polaris/Button';
import { SearchField, SelectField } from '../../polaris/fields';

interface Props {
  evidence: EvidenceConfig;
  totalIssues: number;
  /** Flagged-of-total per kind, from a check that counts more than one kind of thing. */
  issueUnits?: Array<{ unit: string; flagged: number; of: number }> | null;
  statusFilter: RowStatus | 'All';
  onStatusFilterChange: (next: RowStatus | 'All') => void;
  findings: SubPillarFinding[];
  /** The items the drawer should show: the ticked rows, or just the row that was pressed. */
  onInvestigate: (finding: SubPillarFinding, rows: EvidenceRow[]) => void;
  supportsBulkFix?: boolean;
  bulkFixMode?: 'title-tags' | 'generic';
  /** Model-drafted values, or ones rendered from the merchant's own template. */
  bulkFixGenerator?: 'ai' | 'template';
  /** Characters the theme appends to every rendered title, measured by the audit. */
  titleSuffixLength?: number;
  /**
   * Values saved to the store from outside the table — the investigation drawer — in the order they
   * were confirmed. Shown on their rows exactly as a bulk save is, until the next analysis replaces
   * the rows. Only ever a value Shopify accepted.
   */
  externalUpdates?: Array<{ id: string; value: string }>;
}

const alignClass = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

/** Rows the table shows before it scrolls inside itself. */
const VISIBLE_ROWS = 17;

export default function EvidenceTable({
  evidence,
  totalIssues,
  issueUnits = null,
  statusFilter,
  onStatusFilterChange,
  findings,
  onInvestigate,
  supportsBulkFix = false,
  bulkFixMode = 'generic',
  bulkFixGenerator = 'ai',
  titleSuffixLength = 0,
  externalUpdates,
}: Props) {
  const [search, setSearch] = useState('');
  const [facet, setFacet] = useState('All');
  const [sortKey, setSortKey] = useState(evidence.sorts[0]?.key ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBulkFixOpen, setIsBulkFixOpen] = useState(false);
  const [workingRows, setWorkingRows] = useState(evidence.rows);

  /**
   * Follows a NEW set of rows — the page re-loaded after Re-analyze.
   *
   * useState reads its argument once, so the table kept the rows it mounted with: after a
   * re-analysis the score, findings and counts above it moved to the new audit while the table
   * went on showing the old one, and "Review evidence" filtered those stale rows by the new
   * finding's issue type. Bulk-fix edits live only until real rows replace them, which is right.
   */
  useEffect(() => {
    setWorkingRows(evidence.rows);
    setSelectedIds([]);
  }, [evidence.rows]);

  // Once each: several findings can share an issue type (two "Needs Work" findings), and a filter
  // button per finding repeated the same filter.
  const statusFilters: (RowStatus | 'All')[] = useMemo(
    () => [...new Set(['All', ...findings.filter((finding) => finding.affected > 0).map((finding) => finding.issueType), evidence.healthyStatus ?? HEALTHY])],
    [findings, evidence.healthyStatus],
  );

  /**
   * "Sample of 10 products and 20 pages" when the rows say what they are — a check whose table
   * mixes kinds used to have every row called by one noun, so twenty rendered pages were counted
   * as products. Rows that name no kind keep the table's own noun, as before.
   */
  const sampleDescription = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of workingRows) {
      if (!row.unit) return `${workingRows.length.toLocaleString()} ${evidence.sampleNoun}`;
      counts.set(row.unit, (counts.get(row.unit) ?? 0) + 1);
    }
    if (counts.size === 0) return `0 ${evidence.sampleNoun}`;
    return [...counts.entries()].map(([unit, count]) => `${count.toLocaleString()} ${pluralUnit(unit, count)}`).join(' and ');
  }, [workingRows, evidence.sampleNoun]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = workingRows.filter((row) => {
      if (statusFilter !== 'All' && row.status !== statusFilter) return false;
      if (evidence.facet && facet !== 'All' && row.facet !== facet) return false;
      if (!query) return true;
      return evidence.searchKeys.some((key) => String(row.cells[key] ?? '').toLowerCase().includes(query));
    });
    const sort = evidence.sorts.find((option) => option.key === sortKey) ?? evidence.sorts[0];
    return sort ? [...filtered].sort(sort.compare) : filtered;
  }, [evidence, facet, search, sortKey, statusFilter, workingRows]);

  /**
   * ─── Columns with nothing in them are dropped ──────────────────────
   *
   * On a sub-pillar where every row is healthy, three of this table's columns render an em dash on
   * every single row: Status (blank unless a row is an issue), Action (no finding to investigate),
   * and Recommendation (nothing to recommend). By the time the merchant reaches the table the page
   * has already said "nothing flagged" three times — in the score ring, in the breakdown card and
   * in the verdict line — and answering that with a grid of dashes is the opposite of evidence.
   *
   * Computed from ALL rows rather than the visible ones, so typing in the search box cannot make
   * columns appear and disappear under the cursor. The first column always stays: it is what names
   * the row, and a table with no identifying column is unreadable whatever else it holds.
   */
  const columns = useMemo(() => {
    if (workingRows.length === 0) return evidence.columns;
    return evidence.columns.filter((column, index) => {
      if (index === 0) return true;
      // Always a badge, never blank.
      if (column.variant === 'severity') return true;
      if (column.variant === 'status') return workingRows.some((row) => isIssueStatus(row.status, evidence.healthyStatus));
      if (column.variant === 'action') return workingRows.some((row) => findingForRow(row, findings, evidence.healthyStatus));
      return workingRows.some((row) => {
        const value = row.cells[column.key] ?? (column.fallbackKey ? row.cells[column.fallbackKey] : undefined);
        // '—' counts as empty: a check that writes the dash itself is saying the same "nothing
        // here" the renderer would have said for an absent cell.
        return value !== undefined && value !== null && value !== '' && value !== '—';
      });
    });
  }, [evidence.columns, evidence.healthyStatus, findings, workingRows]);

  const selectedRows = workingRows.filter((row) => selectedIds.includes(row.id));
  // Only rows the audit flagged can be fixed: a healthy row has no finding, so nothing can be drafted
  // or saved for it. Ticking "select all" used to send them too, and they came back as empty boxes.
  const fixableRows = selectedRows.filter((row) => findingForRow(row, findings, evidence.healthyStatus));
  const selectedVisible = visible.filter((row) => selectedIds.includes(row.id));
  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const someVisibleSelected = selectedVisible.length > 0 && !allVisibleSelected;

  const toggleVisibleSelection = () => {
    setSelectedIds((current) =>
      allVisibleSelected
        ? current.filter((id) => !visible.some((row) => row.id === id))
        : [...new Set([...current, ...visible.map((row) => row.id)])],
    );
  };

  const toggleRowSelection = (id: string) => {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const applyUpdates = (updates: { id: string; before: string; after: string; status: RowStatus }[]) => {
    setWorkingRows((current) =>
      current.map((row) => {
        const update = updates.find((item) => item.id === row.id);
        if (!update) return row;
        const matchingCell = Object.keys(row.cells).find((key) => String(row.cells[key] ?? '') === (row.current?.value ?? ''));
        const cells = { ...row.cells, ...(matchingCell ? { [matchingCell]: update.after } : {}) };
        if ('title' in row.cells) cells.title = update.after;
        if ('length' in row.cells) cells.length = update.after.length;
        return {
          ...row,
          status: update.status,
          cells,
          current: { label: 'Current', value: update.after, meta: String(row.cells.url ?? '') },
          suggested: undefined,
        };
      }),
    );
  };

  // Applied once each: the list only grows while the rows are the same, and it is emptied (and the
  // count with it) when the page loads a new analysis.
  const externalApplied = useRef(0);
  useEffect(() => {
    if (!externalUpdates) return;
    if (externalUpdates.length < externalApplied.current) externalApplied.current = 0;
    const fresh = externalUpdates.slice(externalApplied.current);
    if (fresh.length === 0) return;
    externalApplied.current = externalUpdates.length;
    applyUpdates(fresh.map((update) => ({ id: update.id, before: '', after: update.value, status: evidence.healthyStatus ?? HEALTHY })));
  }, [externalUpdates]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── The first rows show, the rest scroll inside the table ──────────
  // Measured, not guessed: a row is one line on some sub-pillars and two on others, so the height
  // that shows exactly VISIBLE_ROWS rows is read from the rendered rows — below the column headings,
  // which stay put above them. With fewer rows than that the table is simply as tall as its rows.
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const setTableScroll = useCallback((node: HTMLDivElement | null) => {
    tableScrollRef.current = node;
    // Scrolling the rows hands over to the page at their first and last row (lib/scrollChaining.ts).
    return scrollChaining(node);
  }, []);
  const [tableMaxHeight, setTableMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = tableScrollRef.current;
    if (!node) { setTableMaxHeight(null); return undefined; }
    const measure = () => {
      const bodyRows = node.querySelectorAll<HTMLTableRowElement>('tbody > tr');
      if (bodyRows.length <= VISIBLE_ROWS) { setTableMaxHeight(null); return; }
      const last = bodyRows[VISIBLE_ROWS - 1].getBoundingClientRect();
      const top = node.getBoundingClientRect().top;
      setTableMaxHeight(Math.ceil(last.bottom - top + node.scrollTop));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [visible, columns]);

  const renderCell = (row: EvidenceRow, column: EvidenceColumn) => {
    const primary = row.cells[column.key];
    const value = (primary === undefined || primary === null || primary === '') && column.fallbackKey
      ? row.cells[column.fallbackKey]
      : primary;
    const sub = column.subKey ? row.cells[column.subKey] : undefined;

    if (column.variant === 'severity') return <SeverityBadge severity={severityForStatus(row.status, findings, evidence.healthyStatus)} />;
    if (column.variant === 'status') {
      const issue = isIssueStatus(row.status, evidence.healthyStatus);
      return <span className={`text-[12px] ${issue ? 'font-medium text-surface-800' : 'text-surface-400'}`}>{issue ? row.status : '—'}</span>;
    }
    if (column.variant === 'action') {
      const finding = findingForRow(row, findings, evidence.healthyStatus);
      // The items travel with the finding: this button is per item, so the drawer opens on what
      // was actually chosen rather than on a generic sample of the issue type. Pressing Investigate
      // on a row that is part of a tick selection investigates that whole selection; pressing it on
      // any other row is a question about that row alone, whatever else happens to be ticked.
      const investigating = selectedIds.includes(row.id) ? selectedRows : [row];
      return finding ? (
        <Button variant="ghost" onClick={() => onInvestigate(finding, investigating)} accessibilityLabel={`Investigate ${row.status} issue`}>
          Investigate 
        </Button>
      ) : <span className="text-[12px] text-surface-300">—</span>;
    }

    const isEmpty = value === '' || value === null || value === undefined;
    const text = isEmpty ? (column.emptyText ?? '—') : String(value);
    const clamp = column.clamp ?? 'max-w-[18rem]';
    const body = column.variant === 'mono' ? (
      <p className={`${clamp} truncate font-mono text-[11.5px] text-surface-600`} title={text}>{text}</p>
    ) : column.variant === 'number' ? (
      <span className="text-[12px] font-medium tabular-nums text-surface-700">{text}</span>
    ) : column.variant === 'muted' ? (
      <p className={`${clamp} truncate text-[12px] text-surface-500`} title={text}>{text}</p>
    ) : (
      <p className={`${clamp} truncate text-[12px] ${isEmpty ? 'italic text-surface-400' : 'text-surface-900'}`} title={isEmpty ? undefined : text}>{text}</p>
    );
    if (sub === undefined || sub === null || sub === '') return body;
    return <>{body}<p className={`${clamp} truncate text-[10.5px] leading-[1.35] text-surface-400`}>{String(sub)}</p></>;
  };

  return (
    <section className={`${card} overflow-hidden`} aria-labelledby="sp-evidence-title">
      <div className={cardHeader}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={cardHeadingRow}><p className={eyebrow}>Evidence</p><h2 id="sp-evidence-title" className={cardTitle}>{evidence.title}</h2></div>
          <p className="text-[11px] text-surface-500">
            Sample of <span className="font-semibold tabular-nums text-surface-700">{sampleDescription}</span> ·{' '}
            {issueUnits && issueUnits.length > 0
              ? <><span className="font-semibold tabular-nums text-surface-700">{describeIssueUnits(issueUnits)}</span> flagged</>
              : <><span className="font-semibold tabular-nums text-surface-700">{totalIssues.toLocaleString()}</span> flagged store-wide</>}
          </p>
        </div>
        {/* Search, facet, sort and the issue filters share one row from `lg` up: four controls that
            each fit in 28px have no reason to occupy three stacked bands above the data. */}
        <div className="mt-2 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
          <div className="lg:w-56">
            <SearchField label="Search evidence" placeholder={evidence.searchPlaceholder} value={search} onChange={setSearch} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {evidence.facet && (
              <SelectField
                label={evidence.facet.label}
                labelHidden
                value={facet}
                options={['All', ...evidence.facet.values]}
                optionLabel={(option) => (option === 'All' ? evidence.facet!.allLabel : option)}
                onChange={setFacet}
              />
            )}
            {evidence.sorts.length > 0 && (
              <SelectField
                label="Sort"
                labelHidden
                value={sortKey}
                options={evidence.sorts.map((option) => option.key)}
                optionLabel={(key) => evidence.sorts.find((option) => option.key === key)?.label ?? key}
                onChange={setSortKey}
              />
            )}
          </div>
          <div className="inline-flex flex-wrap gap-0.5 rounded-md border border-surface-200 bg-surface-100/70 p-0.5" role="group" aria-label="Filter by issue">
            {statusFilters.map((status) => {
              const active = statusFilter === status;
              const count = status === 'All' ? workingRows.length : workingRows.filter((row) => row.status === status).length;
              return <button key={status} type="button" onClick={() => onStatusFilterChange(status)} aria-pressed={active} className={`inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${active ? 'bg-surface-0 text-surface-950 shadow-[0_1px_2px_var(--c-shadow-md)]' : 'text-surface-500 hover:text-surface-800'}`}>{status}<span className="tabular-nums text-surface-400">{count}</span></button>;
            })}
          </div>
        </div>
        {supportsBulkFix && selectedIds.length > 0 && <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-brand-100 bg-brand-50/60 px-2.5 py-1.5 sm:flex-row sm:items-center sm:justify-between"><span className="text-[11.5px] font-semibold text-brand-800">{selectedIds.length} selected</span><div className="flex flex-wrap gap-1.5"><Button variant="primary" onClick={() => setIsBulkFixOpen(true)} disabled={fixableRows.length === 0}>Generate fixes{fixableRows.length !== selectedIds.length ? ` (${fixableRows.length})` : ''}</Button><Button variant="ghost" onClick={() => setSelectedIds([])}>Deselect all</Button></div></div>}
      </div>

      {visible.length === 0 ? <div className="px-4 py-8 text-center"><p className="text-[13px] font-semibold text-surface-900">No matches</p><p className="mt-0.5 text-[11.5px] text-surface-500">Clear the search or pick another issue.</p></div> : <div ref={setTableScroll} style={tableMaxHeight ? { maxHeight: tableMaxHeight } : undefined} className="overflow-auto [scrollbar-color:var(--c-surface-300)_transparent] [scrollbar-width:thin]"><table className="table-compact w-full"><caption className="sr-only">{evidence.caption}</caption><thead className="border-b border-surface-200 bg-surface-0 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-surface-0 [&_th]:shadow-[inset_0_-1px_0_var(--c-surface-200)]"><tr>{supportsBulkFix && <th scope="col" className="w-9"><input type="checkbox" checked={allVisibleSelected} ref={(element) => { if (element) element.indeterminate = someVisibleSelected; }} onChange={toggleVisibleSelection} aria-label="Select visible rows" className="h-3.5 w-3.5 cursor-pointer rounded border-surface-300 text-brand-600 focus:ring-brand-500" /></th>}{columns.map((column) => <th key={column.key} scope="col" className={alignClass[column.align ?? 'left']}>{column.header}</th>)}</tr></thead><tbody className="divide-y divide-surface-200">{visible.map((row) => <tr key={row.id} className="transition-colors hover:bg-surface-50">{supportsBulkFix && <td><input type="checkbox" checked={selectedIds.includes(row.id)} onChange={() => toggleRowSelection(row.id)} aria-label={`Select ${String(row.cells.url ?? row.id)}`} className="h-3.5 w-3.5 cursor-pointer rounded border-surface-300 text-brand-600 focus:ring-brand-500" /></td>}{columns.map((column) => <td key={column.key} className={alignClass[column.align ?? 'left']}>{renderCell(row, column)}</td>)}</tr>)}</tbody></table></div>}
      {supportsBulkFix && isBulkFixOpen && (
        <BulkFixWorkflow
          rows={fixableRows}
          leftOutCount={selectedRows.length - fixableRows.length}
          mode={bulkFixMode}
          generator={bulkFixGenerator}
          titleSuffixLength={titleSuffixLength}
          // Resolved here rather than inside the workflow: this component already owns the
          // row→finding mapping (it is what the Investigate button uses), and AI planning is
          // scoped to a finding, so the selection has to carry which finding each row came from.
          findingIdByRowId={Object.fromEntries(
            fixableRows
              .map((row) => [row.id, findingForRow(row, findings, evidence.healthyStatus)?.id])
              .filter((entry): entry is [string, string] => Boolean(entry[1])),
          )}
          onClose={() => setIsBulkFixOpen(false)}
          onApply={applyUpdates}
        />
      )}
    </section>
  );
}
