import { useEffect, useMemo, useRef, useState } from 'react';
import { scrollChaining } from '../../lib/scrollChaining';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { PriorityIssue, Severity } from '../../data/dashboard/dashboard.types';
import PillarTag from './PillarTag';
import { catalogKindOfMove, catalogLinkForMove } from '../../data/catalog.repository';
import { CATALOG_KINDS } from '../../data/catalogKinds';
import { cardClass, countBySeverity, hairline, severityOrder, severityTone } from './scoreTone';

interface Props {
  issues: PriorityIssue[];
  /** The card's heading. */
  heading?: string;
  /**
   * 'fill' (the dashboard): the list scrolls inside whatever height the grid row gives the card.
   * 'panel' (a side panel, which is itself the height of the window): no cap of its own.
   */
  height?: 'fill' | 'panel';
  /** Set by a figure elsewhere on the page — see IssuesFocusRequest. Omitted, the card only
   * responds to its own chips, as before. */
  focusRequest?: IssuesFocusRequest | null;
}

export type Filter = 'all' | Severity;

/** A request from outside this card to show one severity and scroll it into view. `token` makes
 * every request distinct, even a repeat of the same severity, so each click is acted on. */
export interface IssuesFocusRequest {
  filter: Filter;
  token: number;
}

/**
 * Open issues across every pillar, most severe first, with a severity filter so the list can be
 * narrowed without leaving the dashboard.
 *
 * The card fills whatever height its grid row gives it and the LIST scrolls inside it. On a wide
 * screen the row is sized by Recommended actions beside it (see Dashboard.tsx), so the two cards
 * always end on the same line — ten issue rows used to run twice the height of four actions and
 * leave a block of empty card on the right. Below that breakpoint the cards stack, and the list is
 * capped instead so it cannot push the rest of the page out of reach.
 */
export default function PriorityIssues({ issues, heading = 'Priority issues', height = 'fill', focusRequest }: Props) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const sectionRef = useRef<HTMLElement>(null);

  // A KPI card elsewhere on the page asked to see one severity: pick it and scroll here, without
  // fighting a chip the merchant then clicks themselves (this only runs when the request changes).
  useEffect(() => {
    if (!focusRequest) return;
    setFilter(focusRequest.filter);
    sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.token]);

  const counts = useMemo(() => countBySeverity(issues), [issues]);

  const visible = useMemo(() => { 
    const sorted = [...issues].sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));
    return filter === 'all' ? sorted : sorted.filter((issue) => issue.severity === filter);
  }, [issues, filter]);

  const chips: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: issues.length },
    ...severityOrder.map((s) => ({ key: s as Filter, label: severityTone[s].label, count: counts[s] })),
  ];

  return (
    <section ref={sectionRef} className={`${cardClass} scroll-mt-3 flex h-full min-h-0 flex-col overflow-hidden`} aria-labelledby="priority-issues-title">
      {/* One header row where it fits — title and count, then the filter — wrapping to two only on
          narrow cards. The "Issues" eyebrow repeated the title. */}
      <div className={`flex flex-shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b ${hairline} px-3.5 py-2`}>
        <div className="flex min-w-0 items-center gap-2">
          <h2 id="priority-issues-title" className="text-[13px] font-semibold tracking-tight text-surface-950">{heading}</h2>
          <span className="rounded-full bg-surface-100 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-surface-700 ring-1 ring-inset ring-surface-200">
            {issues.length} open
          </span>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {/* Segmented filter: one inset track, the chosen segment raised onto it. */}
          <div
            className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-surface-200/70 bg-surface-50 p-0.5"
            role="tablist"
            aria-label="Filter issues by severity"
          >
            {chips.map((chip) => {
              const isActive = filter === chip.key;
              const isEmpty = chip.count === 0;
              return (
                <button
                  key={chip.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setFilter(chip.key)}
                  className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    isActive
                      ? 'bg-surface-0 text-surface-950 shadow-[0_1px_2px_var(--c-shadow-md)] ring-1 ring-surface-200'
                      : isEmpty
                        ? 'text-surface-400 hover:text-surface-600'
                        : 'text-surface-600 hover:text-surface-900'
                  }`}
                >
                  {chip.key !== 'all' && (
                    <span className={`h-1.5 w-1.5 rounded-full ${severityTone[chip.key as Severity].dot} ${isEmpty ? 'opacity-40' : ''}`} aria-hidden="true" />
                  )}
                  {chip.label}
                  <span className={`tabular-nums ${isActive ? 'text-surface-500' : 'text-surface-400'}`}>{chip.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* The scrolling region. `min-h-0` is what lets a flex child shrink below its content and
          scroll, instead of stretching the card. */}
      <div
        className={`${height === 'panel' ? '' : 'max-h-[420px] xl:max-h-none'} min-h-0 flex-1 overflow-y-auto [scrollbar-color:var(--c-surface-300)_transparent] [scrollbar-width:thin] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500`}
        ref={scrollChaining}
        role="region"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be focusable so a keyboard can scroll it
        tabIndex={0}
        aria-label="Priority issues list"
      >
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-50 text-success-700 ring-1 ring-inset ring-success-100">
              <CheckCircle2 size={20} aria-hidden="true" />
            </span>
            <p className="text-[12.5px] font-semibold text-surface-900">
              {filter === 'all' ? 'No open issues' : `No ${severityTone[filter].label.toLowerCase()} issues`}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-surface-200/60">
            {visible.map((issue) => {
              const tone = severityTone[issue.severity];
              const Icon = tone.icon;
              // A fix about products, collections or blog articles opens that list filtered to them
              // ("View 12 products"); any other fix opens the page where it is made.
              const moveKind = catalogKindOfMove(issue);
              const kindNouns = moveKind ? CATALOG_KINDS[moveKind] : null;
              return (
                <li key={issue.id} className="group relative flex items-center gap-2.5 px-3.5 py-2 transition-colors duration-150 hover:bg-surface-50">
                  {/* Severity edge: the row's rank is readable from the left margin alone. */}
                  <span className={`absolute inset-y-2 left-0 w-[3px] rounded-r-full ${tone.dot}`} aria-hidden="true" />
                  <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md ${tone.tile}`} aria-label={tone.label} title={tone.label}>
                    <Icon size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[12.5px] font-semibold text-surface-900">{issue.title}</span>
                      {issue.reviewed && (
                        <span className="flex-shrink-0 rounded-md bg-surface-100 px-1.5 py-0.5 text-[10px] font-semibold text-surface-600 ring-1 ring-inset ring-surface-200">
                          Reviewed
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-surface-500">
                      <PillarTag pillar={issue.pillar} label={issue.pillarLabel} />
                      <span className="truncate">{issue.description}</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(moveKind ? catalogLinkForMove(moveKind, issue) : issue.route)}
                    className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-brand-700 ring-1 ring-inset ring-transparent transition-colors hover:bg-brand-50 hover:ring-brand-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    aria-label={kindNouns ? `View the ${kindNouns.nouns} for: ${issue.title}` : `${issue.actionLabel}: ${issue.title}`}
                  >
                    {kindNouns ? `View ${issue.affectedCount > 0 ? `${issue.affectedCount.toLocaleString()} ` : ''}${issue.affectedCount === 1 ? kindNouns.noun : kindNouns.nouns}` : issue.actionLabel}
                    <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
