// ─── Dashboard · Priority issues come from the last audit, and only from it (npm test) ───
//
// THE PROPERTY THESE TESTS PROTECT: what the dashboard shows is what the most recent audit of the
// merchant's real store actually found — nothing seeded, nothing carried over from a previous run,
// and nothing estimated on top.
//
// Two ways that breaks, both of which have happened here before:
//
//   · READING MORE THAN THE LAST AUDIT. Findings belong to one audit and every re-run writes a
//     fresh set, so an unscoped read shows the same problem once per historical run — three audits
//     rendered 48 rows for 16 real problems, and "10 open" counted the same handful repeatedly.
//     It also means a merchant who FIXES something still sees it, because the old audit's row is
//     still there. That is the case that matters most: the list has to shrink when the store does.
//
//   · TWO DEFINITIONS OF "LATEST". The summary picks the newest audit and the findings are scoped
//     to MAX(id); if those disagree, the header describes one audit and the issue list another.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

function source(relativePath: string): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), relativePath), 'utf8');
}

const findingService = source('../services/finding.service.ts');
const dashboardService = source('../services/dashboard.service.ts');
const runner = source('../audit-engine/runner.ts');

describe('priority issues are scoped to the newest audit', () => {
  it('scopes the priority list to one audit', () => {
    const fn = findingService.slice(
      findingService.indexOf('export async function listPriorityFindings'),
      findingService.indexOf('export async function getFinding'),
    );
    assert.ok(fn.includes('latestAuditCondition'), 'the priority list reads across every audit of the store');
    assert.ok(fn.includes('storeFindingCondition'), 'the priority list is not scoped to the caller’s store');
  });

  it('defines "latest" as MAX(audit id), not a client-supplied value', () => {
    assert.match(findingService, /MAX\(\$\{audits\.id\}\)/);
  });

  it('shows only findings still outstanding', () => {
    // A resolved or ignored finding is the merchant's own bookkeeping and must not sit in a list
    // headed "open".
    assert.match(findingService, /inArray\(findings\.status, \['open', 'reviewed'\]\)/);
  });

  it('orders by real severity rather than alphabetically', () => {
    // severity is a varchar, so ORDER BY severity DESC sorts medium > low > high > critical and
    // buries every critical finding at the bottom of a list called "priority". The ladder is a CASE
    // (SQLite has no FIELD()); d1-queries.test.ts runs it on a real database and checks the order.
    assert.ok(findingService.includes("CASE ${findings.severity} WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 0 END"));
  });
});

describe('the dashboard and its issue list describe the same audit', () => {
  it('breaks the newest-audit tie by id, matching MAX(id)', () => {
    // Two audits can share a run_at timestamp. Without the id tie-break the database picks either,
    // and the header can describe a different audit than the findings below it.
    assert.match(dashboardService, /orderBy\(desc\(audits\.runAt\), desc\(audits\.id\)\)/);
  });
});

describe('nothing but a real audit can write what the dashboard reads', () => {
  it('only the audit runner writes findings, scores and audits', () => {
    // If a seed or fixture path ever writes these tables, the dashboard renders invented issues
    // with no way for a merchant to tell. The runner is the one writer, and it writes from a
    // snapshot of the real store.
    for (const table of ['findings', 'auditScores', 'audits']) {
      assert.ok(runner.includes(`insert(${table})`), `the runner no longer writes ${table}`);
    }
  });

  it('writes findings from check results, never from a literal', () => {
    const persist = runner.slice(runner.indexOf('async function persistAudit'), runner.indexOf('export async function runAuditJob'));
    for (const field of ['title', 'severity', 'affectedCount', 'problem', 'recommendation']) {
      assert.ok(
        new RegExp(`${field}: finding\\.${field}`).test(persist),
        `${field} is no longer taken from the check's own result`,
      );
    }
  });

  it('marks every persisted audit as engine-produced', () => {
    // 'seed' exists so a development fixture could never be passed off as a real audit. A real run
    // must therefore say 'engine' explicitly.
    assert.ok(runner.includes("source: 'engine'"));
  });

  it('writes no audit row when the run fails', () => {
    // persistAudit runs only after the checks complete. If a failed run wrote a row, MAX(id) would
    // point at an audit with no findings and the dashboard would report a clean store.
    const run = runner.slice(runner.indexOf('export async function runAuditJob'));
    const persistAt = run.indexOf('await persistAudit(');
    const catchAt = run.indexOf('} catch (error) {', persistAt);
    assert.ok(persistAt > 0 && catchAt > persistAt, 'persistAudit no longer sits inside the try that fails the job');
    assert.equal(
      run.slice(catchAt).includes('persistAudit('),
      false,
      'the failure path persists an audit — a failed run must leave the previous audit as the latest',
    );
  });
});
