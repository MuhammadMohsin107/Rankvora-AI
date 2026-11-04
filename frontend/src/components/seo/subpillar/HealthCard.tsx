import { affectedPhrase, describeIssueUnits, type SubPillarFinding, type SubPillarTotals } from '../../../data/seo/subpillar.model';
import { card, cardHeader, cardHeadingRow, cardTitle, eyebrow, toneStyles } from './tone';

interface Props {
  totals: SubPillarTotals;
  findings: SubPillarFinding[];
  /** Filter the evidence table to one issue type. */
  onSelectIssue: (issueType: string) => void;
}

/**
 * What the remaining problem is actually made of, ranked by severity.
 * No decorative chart — the bars are the comparison.
 */
export default function HealthCard({ totals, findings, onSelectIssue }: Props) {
  const open = findings.filter((finding) => finding.affected > 0);
  const maxAffected = Math.max(...open.map((finding) => finding.affected), 1);
  // A check that counts products AND pages says so; its header then states each population
  // instead of one total that adds pages to products.
  const units = totals.issueUnits && totals.issueUnits.length > 0 ? totals.issueUnits : null;
  /**
   * A finding's share of ITS OWN population when the check recorded one ("3 of 20 pages" is 15%),
   * otherwise of the issue total — which is right only when every finding counts the same thing,
   * the case for every check that does not record a population.
   */
  const shareOf = (finding: SubPillarFinding) =>
    typeof finding.population === 'number' && finding.population > 0
      ? (finding.affected / finding.population) * 100
      : totals.issues > 0 ? (finding.affected / totals.issues) * 100 : 0;

  return (
    <section className={`${card} flex h-full flex-col overflow-hidden`} aria-labelledby="sp-health-title">
      <div className={cardHeader}>
        <div className={cardHeadingRow}>
          <p className={eyebrow}>Breakdown</p>
          <h2 id="sp-health-title" className={cardTitle}>Where the issues are</h2>
        </div>
      </div>

      <div className="px-3.5 py-2.5">
        {open.length === 0 ? (
          <p className="py-3 text-center text-[12px] text-surface-500">Nothing flagged in the latest analysis.</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11.5px] font-medium text-surface-600">
                {units ? `${describeIssueUnits(units)} flagged` : `What the ${totals.issues.toLocaleString()} issues are`}
              </span>
              <span className="text-[11px] text-surface-400">by severity</span>
            </div>

            <ul className="mt-2 space-y-1.5">
              {open.map((finding) => {
                const tone = toneStyles[finding.severity];
                const share = shareOf(finding);
                return (
                  <li key={finding.id}>
                    <button
                      type="button"
                      onClick={() => onSelectIssue(finding.issueType)}
                      className="group w-full cursor-pointer rounded-md px-1 py-0.5 text-left transition-colors hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      aria-label={`Filter evidence to ${finding.issueType}: ${finding.affected} affected`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 truncate text-[12px] font-medium text-surface-700 group-hover:text-surface-900">
                          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
                          {/* The finding's own title when the check counts more than one kind of
                              thing: its issue types are the row statuses ("Critical", "Needs Work"),
                              and two findings both labelled "Needs Work" said nothing. */}
                          {units ? finding.title : finding.issueType}
                        </span>
                        <span className="flex-shrink-0 text-[11.5px] tabular-nums text-surface-500">
                          <span className="font-semibold text-surface-900">{units ? affectedPhrase(finding) : finding.affected.toLocaleString()}</span>
                          <span className="ml-1 text-surface-400">{share.toFixed(0)}%</span>
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-100">
                        <div
                          className={`h-full rounded-full ${tone.bar} transition-[width] duration-700 ease-out motion-reduce:transition-none`}
                          style={{ width: `${(finding.affected / maxAffected) * 100}%` }}
                        />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
