import { useEffect, useMemo, useRef } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { affectedPhrase, investigationEvidence, type EvidenceRow, type SubPillarFinding } from '../../../data/seo/subpillar.model';
import AiRecommendationPanel from '../../workflows/AiRecommendationPanel';
import InvestigationFix, { useFixCapability } from './InvestigationFix';
import SeverityBadge from './SeverityBadge';
import { eyebrow, toneStyles } from './tone';
import Button from '../../../components/polaris/Button';

interface Props {
  finding: SubPillarFinding | null;
  evidence: EvidenceRow[];
  /**
   * The items the user opened this drawer for — the row whose Investigate button was pressed, or
   * every ticked row when the pressed row was part of a tick selection. Empty when the drawer was
   * opened from the findings list, where an issue was chosen but no item.
   */
  selectedRows?: EvidenceRow[];
  onClose: () => void;
  /** Filter the evidence table to this issue and close the drawer. */
  onReviewAffected: (finding: SubPillarFinding) => void;
  /**
   * The sub-pillar's slug ("meta-descriptions"). When Rankvora AI can write this sub-pillar's field,
   * the drawer drafts the fix itself for the items it shows and can save it to the store.
   */
  subPillar?: string;
  /** Characters the theme appends to every rendered title, as the audit measured them. */
  titleSuffixLength?: number;
  /** Told about a value Shopify confirmed, so the page can show it in its table. */
  onApplied?: (rowId: string, value: string) => void;
  /** Opens the Missing images panel. Offered only where the page has one and the issue is "no image". */
  onAddImages?: () => void;
}

const EVIDENCE_PREVIEW = 4;

/**
 * Investigation panel. Opens beside the findings list so the user can
 * read the evidence without losing their place on the page.
 *
 * WHICH ROWS THIS SHOWS. When the user selected items, exactly those items — investigating an
 * item is a question about that item, and padding the list with other examples reads as though
 * the selection was ignored. Only when nothing was selected (opened from the findings list) does
 * a sample stand in, preferring the rows the check itself attributed to the finding over the
 * sub-pillar sample, which is shared between findings of the same issue type.
 */
export default function InvestigationDrawer({ finding, evidence, selectedRows = [], onClose, onReviewAffected, subPillar, titleSuffixLength = 0, onApplied, onAddImages }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const isOpen = finding !== null;
  // The page hands over a new onClose on every render, and renders on every poll of a running
  // analysis. Read through a ref, so the effect below runs once per opening — not once per render,
  // which moved focus to Close from whatever the merchant was typing into.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Whether this sub-pillar's field is one Rankvora AI writes — asked of the server, once.
  const capability = useFixCapability(subPillar);

  // Escape to close, focus the panel on open, lock background scroll.
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Escape inside a fix being written leaves the box rather than throwing the words away
        // with the whole drawer; a second Escape closes it.
        if (event.target instanceof HTMLTextAreaElement) {
          event.target.blur();
          return;
        }
        onCloseRef.current();
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  // The items are the ones the drawer was opened on. They are fixed for the opening: when the
  // analysis a save started finishes and the page loads the new audit, the cards being written in
  // must not be swapped for the new audit's rows underneath the merchant.
  const preview = useMemo(
    () => (finding ? investigationEvidence(finding, evidence, selectedRows, EVIDENCE_PREVIEW) : []),
    // `evidence` is deliberately not a dependency: see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finding, selectedRows],
  );

  if (!finding) return null;

  const isSelection = selectedRows.length > 0;
  // "and N more" belongs to a sample, not to a selection — the user is looking at everything they
  // picked, so telling them items are hidden would be wrong.
  const notShown = isSelection ? 0 : finding.affected - preview.length;
  const tone = toneStyles[finding.severity];
  // A fix needs a real finding row: the server anchors drafts and saves on its id and its evidence.
  const fixable = Boolean(capability) && /^\d+$/.test(finding.id) && preview.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <div className="absolute inset-0 bg-surface-950/25 motion-safe:animate-fade-in" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sp-drawer-title"
        className="relative flex h-full w-full max-w-lg flex-col bg-surface-0 shadow-2xl motion-safe:animate-scale-in"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-surface-200 px-4 py-3">
          <div className="min-w-0">
            <p className={eyebrow}>Issue detail</p>
            <h2 id="sp-drawer-title" className="mt-0.5 text-[15px] font-semibold tracking-tight text-surface-950">
              {finding.title}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <SeverityBadge severity={finding.severity} />
              <span className="text-[11px] text-surface-500">
                <span className="font-semibold tabular-nums text-surface-800">{finding.affected.toLocaleString()}</span>{' '}
                affected
              </span>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-surface-500 transition-colors hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Close issue detail"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-surface-500">What is wrong</h3>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-surface-700">{finding.whatIsWrong}</p>
          </section>

          <section className="mt-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-surface-500">Why it matters</h3>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-surface-700">{finding.whyItMatters}</p>
          </section>

          <section className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-surface-500">
                {isSelection ? (preview.length === 1 ? 'Selected item' : 'Selected items') : 'Evidence'}
              </h3>
              <span className="text-[11px] text-surface-400">
                {isSelection
                  ? `${preview.length} of ${finding.affected.toLocaleString()} affected`
                  : `${preview.length} of ${finding.affected.toLocaleString()}`}
              </span>
            </div>

            {fixable && capability ? (
              // The fix itself: current value beside a drafted one, and the actions that save it.
              // Keyed by the items, so opening the drawer on other items starts a fresh panel.
              <div className="mt-1.5">
                <InvestigationFix
                  key={`${finding.id}:${preview.map((row) => row.id).join(',')}`}
                  finding={finding}
                  rows={preview}
                  capability={capability}
                  autoGenerate={isSelection}
                  titleSuffixLength={titleSuffixLength}
                  onApplied={onApplied}
                />
              </div>
            ) : preview.length === 0 ? (
              <p className="mt-1.5 rounded-md bg-surface-50 px-2.5 py-2 text-[11.5px] text-surface-500">
                No sampled items.
              </p>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {preview.map((row) => (
                  <li
                    key={row.id}
                    className={`rounded-md border p-2.5 ${isSelection ? 'border-brand-300 bg-brand-50/60 ring-1 ring-brand-200' : 'border-surface-200 bg-surface-50/60'}`}
                  >
                    {row.current?.meta && (
                      <p className="truncate font-mono text-[10.5px] text-surface-600">{row.current.meta}</p>
                    )}

                    <div className="mt-1.5 space-y-1">
                      {row.current && (
                        <div className="flex items-start gap-1.5">
                          <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
                          <div className="min-w-0">
                            <p className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-surface-400">
                              {row.current.label}
                            </p>
                            <p className={`text-[12px] leading-[1.4] ${row.current.value ? 'text-surface-800' : 'italic text-surface-400'}`}>
                              {row.current.value || 'not present'}
                            </p>
                            {row.note && <p className="text-[10.5px] text-surface-500">{row.note}</p>}
                          </div>
                        </div>
                      )}

                      {row.suggested && (
                        <div className="flex items-start gap-1.5">
                          <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success-500" aria-hidden="true" />
                          <div className="min-w-0">
                            <p className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-surface-400">
                              {row.suggested.label}
                            </p>
                            <p className="text-[12px] leading-[1.4] text-surface-800">{row.suggested.value}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {notShown > 0 && (
              <p className="mt-1.5 text-[10.5px] text-surface-500">
                and {notShown.toLocaleString()} more in the full crawl.
              </p>
            )}
          </section>

          <section className="mt-3 rounded-md border border-brand-100 bg-brand-50/60 p-3">
            <h3 className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-700">
              <Lightbulb size={12} aria-hidden="true" />
              Recommendation
            </h3>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-surface-700">{finding.recommendation}</p>
            {/* What this recommendation covers, as measured. "Impact" and "Effort" stood here —
                words each check typed in by hand, the same for every store. The severity badge in
                the header is the rating the audit's rules set. */}
            <p className="mt-2 text-[11px] text-surface-600">
              Covers <span className="font-semibold tabular-nums text-surface-800">{affectedPhrase(finding)}</span>
            </p>
            {/* Advice rewritten by AI is for issues Rankvora AI cannot fix itself. Where it can, the fix
                above IS the AI's answer — written for the item, not described. */}
            {!fixable && <AiRecommendationPanel findingId={finding.id} />}
          </section>
        </div>

        {/* Footer */}
        <div className="space-y-2 border-t border-surface-200 px-4 py-2.5">
          {onAddImages && finding.issueType === 'Missing Media' && (
            <Button variant="primary" onClick={onAddImages} fullWidth>
              
              Add images to these products
            </Button>
          )}
          <Button
            variant={onAddImages && finding.issueType === 'Missing Media' ? 'secondary' : 'primary'}
            onClick={() => onReviewAffected(finding)}
            fullWidth
          >
            Review affected items
          </Button>
        </div>
      </div>
    </div>
  );
}
