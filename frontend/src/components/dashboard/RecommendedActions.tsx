import { CheckCircle2, ScanSearch } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { RecommendedAction } from '../../data/dashboard/dashboard.types';
import PillarTag from './PillarTag';
import { cardClass, hairline, severityTone } from './scoreTone';
import Button from '../../components/polaris/Button';

interface Props {
  actions: RecommendedAction[];
}

/**
 * Ranked next steps, each linking into the pillar that owns the fix, drawn as a numbered sequence.
 *
 * On a wide screen this card's own content sets the height of its grid row, and Priority issues
 * beside it is sized to match (see Dashboard.tsx) — so nothing here stretches, and there is no
 * block of empty card under the last step.
 *
 * NO TIME TOTAL, NO IMPACT/EFFORT, NO "POTENTIAL PTS". The header used to carry a "~75 min total"
 * chip summed from a minute figure looked up on severity; the "impact" and "effort" words after it
 * were typed into each check by hand; and the "+100 potential pts" beside every step was not a
 * number of points at all — most checks store the share of one area's items a finding touches,
 * and a few type a constant in. Each step now shows only what this audit determined: the severity
 * its rules set, how many items it counted, and the first piece of evidence it recorded in this
 * store. The order is the audit's own: most severe first, then the most items affected.
 */
export default function RecommendedActions({ actions }: Props) {
  const navigate = useNavigate();

  return (
    <section className={`${cardClass} flex h-full flex-col`} aria-labelledby="recommended-actions-title">
      {/* One line. The "Next steps" eyebrow restated the title. */}
      <div className={`flex items-center justify-between gap-3 border-b ${hairline} px-3.5 py-2`}>
        <h2 id="recommended-actions-title" className="text-[13px] font-semibold tracking-tight text-surface-950">Recommended actions</h2>
        {actions.length > 0 && (
          // A real count of what is listed, not an estimate of anything.
          <span className="inline-flex flex-shrink-0 items-center rounded-full bg-surface-100 px-1.5 py-px text-[10.5px] font-medium tabular-nums text-surface-700 ring-1 ring-inset ring-surface-200">
            Top {actions.length} by severity
          </span>
        )}
      </div>

      {actions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-50 text-success-700 ring-1 ring-inset ring-success-100">
            <CheckCircle2 size={20} aria-hidden="true" />
          </span>
          <p className="text-[12.5px] font-semibold text-surface-900">Nothing to recommend</p>
        </div>
      ) : (
        <ol className="px-3.5 py-0.5">
          {actions.map((action, index) => {
            const isLast = index === actions.length - 1;
            return (
              <li key={action.id} className="group relative flex gap-2.5 py-2">
                {/* The rail joining one step to the next. It runs from under this badge (8px row
                    padding + 24px badge) to the top of the next one; the badge's ring cuts it
                    cleanly at each end. */}
                {!isLast && <span className="absolute -bottom-2 left-[11.5px] top-8 w-px bg-surface-200" aria-hidden="true" />}
                <span
                  className={`relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold tabular-nums ring-[3px] ring-surface-0 ${
                    index === 0 ? 'bg-brand-600 text-surface-0' : 'bg-surface-900 text-surface-0'
                  }`}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="pt-0.5 text-[12.5px] font-semibold leading-snug text-surface-900">{action.title}</p>
                    <Button variant="secondary" onClick={() => navigate(action.route)} accessibilityLabel={`Review ${action.title}`}>
                      Review
                      
                    </Button>
                  </div>
                  {/* Clamped to two lines; the whole text is on the sub-pillar page Review opens. */}
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-[1.45] text-surface-500" title={action.description}>{action.description}</p>
                  {/* What the audit recorded in THIS store — the line that makes the step about
                      these products and pages rather than generic advice. */}
                  {action.evidence && (
                    <p className="mt-1 flex min-w-0 items-center gap-1 text-[10.5px] text-surface-600" title={action.evidence}>
                      <ScanSearch size={11} className="flex-shrink-0 text-surface-400" aria-hidden="true" />
                      <span className="truncate">
                        <span className="font-semibold text-surface-700">Found: </span>
                        {action.evidence}
                      </span>
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <span className={`inline-flex items-center rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide ${severityTone[action.severity].chip}`}>
                      {severityTone[action.severity].label}
                    </span>
                    <PillarTag pillar={action.pillar} label={action.pillarLabel} />
                    {action.affectedCount > 0 && (
                      <span className="text-[10.5px] font-medium tabular-nums text-surface-500">
                        {action.affectedCount.toLocaleString()} {action.affectedLabel} affected
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
