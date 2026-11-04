import { hiddenPillarKeys } from '../config/modules';
import { pillarMeta } from './pillarMeta';

/**
 * ─── The report CSV, without the pillars the customer cannot see ─────────────────────────────
 *
 * GET /reports/export builds the whole report on the server, for every pillar the audit measured.
 * A pillar switched off in config/modules.ts must not leave the building in that file, and the
 * server is not touched to prevent it — so the file is read here, the hidden pillar's rows are
 * taken out, and what is left is saved. The server's file is unchanged and still complete; only the
 * copy handed to the customer is narrowed.
 *
 * The file is a stack of small tables, each introduced by a one-cell title row. Rows are matched by
 * their Pillar cell, which holds the pillar's display name exactly. Two figures that the rows
 * produce are kept consistent with what remains: "Issues found" in the summary, and the Priority
 * numbers down the Issues table. The overall score is the server's and is not recomputed.
 */

type Section = 'summary' | 'pillars' | 'subPillars' | 'issues';

/** The one-cell row that opens each table, and the table it opens. */
const TABLE_TITLES: Record<string, Section> = {
  'Pillar performance': 'pillars',
  'Sub-pillar breakdown': 'subPillars',
  Issues: 'issues',
};
const ISSUES_TITLE = 'Issues';
const NO_ISSUES_TEXT = 'No issues found in this audit';

/** RFC 4180: quoted cells may hold commas, doubled quotes and line breaks. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

const escapeCell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** The CSV with every row of a hidden pillar removed. Unchanged when no pillar is hidden. */
export function withoutHiddenPillarRows(csv: string): string {
  const hidden = new Set(hiddenPillarKeys().map((key) => pillarMeta[key].label));
  if (hidden.size === 0) return csv;

  const kept: string[][] = [];
  let section: Section = 'summary';
  let headerNext = false;
  let issueRows = 0;
  let issuesFoundRow = -1;

  for (const record of parseCsv(csv)) {
    const opens = record.length === 1 ? TABLE_TITLES[record[0]] : undefined;
    if (opens) {
      section = opens;
      headerNext = true; // the next row is the table's column headings
      kept.push(record);
      continue;
    }
    if (headerNext) {
      headerNext = false;
      kept.push(record);
      continue;
    }
    if (record.length === 1 && record[0] === '') {
      section = 'summary'; // a blank row closes a table
      kept.push(record);
      continue;
    }

    if (section !== 'summary' && record.some((cell) => hidden.has(cell))) continue;

    if (section === 'issues') {
      // A row of the Issues table: numbered in order, so the numbers are renumbered below. The
      // server's own "No issues found" placeholder has an empty Pillar cell and a text cell.
      if (record[0] !== '' && /^\d+$/.test(record[0])) {
        issueRows += 1;
        kept.push([String(issueRows), ...record.slice(1)]);
        continue;
      }
    }
    if (section === 'summary' && record[0] === 'Issues found') issuesFoundRow = kept.length;
    kept.push(record);
  }

  // The summary's issue count, then — if every issue was the hidden pillar's — the same
  // "no issues" row the server writes for an audit with none.
  if (issuesFoundRow >= 0) kept[issuesFoundRow] = [kept[issuesFoundRow][0], String(issueRows)];
  if (issueRows === 0) {
    const headingAt = kept.findIndex((record) => record.length === 1 && record[0] === ISSUES_TITLE);
    if (headingAt >= 0) {
      const width = kept[headingAt + 1]?.length ?? 10;
      const placeholder = Array.from({ length: width }, () => '');
      placeholder[Math.min(4, width - 1)] = NO_ISSUES_TEXT;
      const insertAt = headingAt + 2;
      if (!kept.slice(insertAt).some((record) => record.includes(NO_ISSUES_TEXT))) kept.splice(insertAt, 0, placeholder);
    }
  }

  return kept.map((record) => record.map(escapeCell).join(',')).join('\r\n');
}
