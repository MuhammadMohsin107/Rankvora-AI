import type { Severity } from '../../data/dashboard/dashboard.types';
import { severityOrder, severityTone } from '../dashboard/scoreTone';

/**
 * ─── Issues by severity, as one proportional bar ─────────────────────
 *
 * Each severity is a segment as wide as its share of the open issues, in the same colours the issue
 * lists use (`severityTone`), so the bar and the rows under it cannot disagree. A severity with no
 * issues takes no width. With nothing open the track is left empty rather than drawn as a full bar.
 *
 * Ported from the Replica mockup's `SeverityBar`.
 */
export default function SeverityBar({ counts, showLegend = true, className = '' }: { counts: Record<Severity, number>; showLegend?: boolean; className?: string }) {
  const total = severityOrder.reduce((sum, severity) => sum + counts[severity], 0);
  const summary = severityOrder.map((severity) => `${counts[severity]} ${severityTone[severity].label.toLowerCase()}`).join(', ');

  return (
    <div className={`space-y-1.5 ${className}`.trim()}>
      <div
        className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-surface-100"
        role="img"
        aria-label={total === 0 ? 'No open issues' : `Open issues by severity: ${summary}`}
      >
        {total > 0 && severityOrder.map((severity) => (
          counts[severity] > 0
            ? <span key={severity} className={`h-full ${severityTone[severity].dot}`} style={{ width: `${(counts[severity] / total) * 100}%` }} />
            : null
        ))}
      </div>
      {showLegend && (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-surface-600">
          {severityOrder.map((severity) => (
            <li key={severity} className="inline-flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${severityTone[severity].dot}`} aria-hidden="true" />
              {severityTone[severity].label}
              <span className="font-semibold tabular-nums text-surface-900">{counts[severity].toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
