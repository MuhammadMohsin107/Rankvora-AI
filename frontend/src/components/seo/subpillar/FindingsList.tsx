import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { affectedPhrase, type SubPillarFinding } from '../../../data/seo/subpillar.model';
import SeverityBadge from './SeverityBadge';
import { card, cardHeader, cardHeadingRow, cardTitle, toneStyles } from './tone';

interface Props {
  findings: SubPillarFinding[];
  onInvestigate: (finding: SubPillarFinding) => void;
  /** Sub-pillar-specific empty-state copy. */
  emptyTitle: string;
  /** No longer shown: the title alone says it. Kept so existing callers still type-check. */
  emptyBody?: string;
}

/**
 * Prioritized findings — severity first, each one stating what it costs
 * and opening the investigation drawer.
 */
export default function FindingsList({ findings, onInvestigate, emptyTitle }: Props) {
  const open = findings.filter((finding) => finding.affected > 0);

  if (open.length === 0) {
    return (
      /* A single centred ROW, not a stacked block.
         The "no issues" state used to be an icon, a heading and a line of body copy stacked
         vertically inside a padded card — roughly 130px of screen to say that there is nothing
         to look at. It is good news, so it should take the least space on the page, not a
         quarter of the fold. */
      <section className={`${card} flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-3.5 py-2.5 text-center`} aria-labelledby="sp-findings-title">
        <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${toneStyles.healthy.tile}`}>
          <CheckCircle2 size={12} strokeWidth={2.4} aria-hidden="true" />
        </span>
        <h2 id="sp-findings-title" className="text-[12.5px] font-semibold text-surface-900">
          {emptyTitle}
        </h2>
      </section>
    );
  }

  return (
    <section className={`${card} overflow-hidden`} aria-labelledby="sp-findings-title">
      <div className={`${cardHeader} flex flex-wrap items-center justify-between gap-2`}>
        <div className={cardHeadingRow}>
          <h2 id="sp-findings-title" className={cardTitle}>Findings</h2>
        </div>
        <span className="rounded border border-surface-200 bg-surface-0 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-surface-600">
          {open.length} issue {open.length === 1 ? 'type' : 'types'}
        </span>
      </div>

      <ul className="divide-y divide-surface-200">
        {open.map((finding) => {
          const tone = toneStyles[finding.severity];
          return (
            <li key={finding.id}>
              <button
                type="button"
                onClick={() => onInvestigate(finding)}
                className="group flex w-full cursor-pointer items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                aria-label={`Investigate ${finding.title}, ${finding.affected} affected`}
              >
                <span className={`mt-0.5 h-7 w-[3px] flex-shrink-0 rounded-full ${tone.rail}`} aria-hidden="true" />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SeverityBadge severity={finding.severity} />
                    <h3 className="text-[13px] font-semibold text-surface-900">{finding.title}</h3>
                  </div>
                  {/* The count and what it is out of — nothing else. "Impact" and "Effort" stood
                      here: words each check typed in by hand, the same for every store. The
                      severity badge above is the rating the audit's rules actually set. */}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-surface-500">
                    <span>
                      <span className="font-semibold tabular-nums text-surface-800">{affectedPhrase(finding)}</span>{' '}
                      affected
                    </span>
                  </div>
                </div>

                <span className="mt-0.5 hidden flex-shrink-0 items-center gap-1 text-[11.5px] font-semibold text-brand-700 sm:inline-flex">
                  Investigate
                  <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
