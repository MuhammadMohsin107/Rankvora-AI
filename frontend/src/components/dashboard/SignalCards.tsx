import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import { isPillarVisible } from '../../config/modules';
import { formatLastUpdated, routeFor } from '../../data/dashboard/dashboard.repository';
import type { PillarKey } from '../../data/dashboard/dashboard.types';
import {
  fetchDashboardSignals,
  type AiMentionSignal,
  type ApprovalSignal,
  type DashboardSignals,
  type MobileSpeedSignal,
  type SearchTrafficSignal,
  type Signal,
  type SignalReason,
  type VitalRating,
} from '../../data/dashboard/signals.repository';
import { pillarMeta } from '../../data/pillarMeta';
import { cardClass, statusTone } from './scoreTone';

interface Props {
  /** Changes whenever the store is analysed again, so the drafts count follows the new audit. */
  refreshKey: string;
}

type State = { phase: 'loading' } | { phase: 'ready'; signals: DashboardSignals } | { phase: 'error' };

const neutralBadge = 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-200';
const badgeBase = 'inline-flex flex-shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[9.5px] font-semibold tabular-nums';

/**
 * The four outcome cards under the pillars: what Google sent, how fast real visitors got the page,
 * how often an assistant named the store, and what is waiting on the merchant.
 *
 * The pillar cards above say how well the store is PREPARED; these say what is HAPPENING. Every
 * number is read by the backend from a real source (see data/dashboard/signals.repository.ts) and a
 * card with nothing to read says why and where to fix it — it never shows a 0 or a placeholder in
 * the place of a measurement. The four are read together but fail apart: one card's "could not be
 * read" never blanks the others.
 */
export default function SignalCards({ refreshKey }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetchDashboardSignals()
      .then((signals) => { if (live) setState({ phase: 'ready', signals }); })
      // A refresh that fails keeps the figures already on screen; only a first load may end in the
      // error state.
      .catch(() => { if (live) setState((current) => (current.phase === 'ready' ? current : { phase: 'error' })); });
    return () => { live = false; };
  }, [refreshKey, attempt]);

  if (state.phase === 'loading') return <SignalSkeleton />;

  if (state.phase === 'error') {
    return (
      <section aria-label="Search, speed, AI answers and drafts" className={`${cardClass} flex flex-wrap items-center justify-between gap-2 px-3 py-2.5`}>
        <p className="text-[12px] text-surface-600">These figures could not be loaded right now.</p>
        <button
          type="button"
          onClick={() => { setState({ phase: 'loading' }); setAttempt((value) => value + 1); }}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-brand-700 hover:bg-brand-50"
        >
          <RefreshCw size={12} aria-hidden="true" /> Try again
        </button>
      </section>
    );
  }

  const { searchTraffic, mobileSpeed, aiMentions, approvals } = state.signals;
  return (
    <section aria-label="Search, speed, AI answers and drafts" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <SearchTrafficCard signal={searchTraffic} />
      <MobileSpeedCard signal={mobileSpeed} />
      <AiMentionCard signal={aiMentions} />
      <ApprovalsCard signal={approvals} />
    </section>
  );
}

// ─── The shell every card shares ─────────────────────────────────────

function SignalShell({ label, badge, value, caption, title }: { label: string; badge?: ReactNode; value: ReactNode; caption: ReactNode; title?: string }) {
  return (
    <div className={`${cardClass} flex flex-col px-3 pb-2.5 pt-3`} title={title}>
      <div className="flex min-h-[20px] items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-surface-600">{label}</span>
        {badge}
      </div>
      <div className="mt-2 flex items-end gap-1">{value}</div>
      <div className="mt-1.5 text-[10.5px] leading-snug text-surface-500">{caption}</div>
    </div>
  );
}

const Figure = ({ children }: { children: ReactNode }) => (
  <span className="text-[24px] font-semibold leading-none tracking-[-0.03em] text-surface-950 tabular-nums">{children}</span>
);
const Unit = ({ children }: { children: ReactNode }) => (
  <span className="pb-px text-[10.5px] font-medium text-surface-400">{children}</span>
);

/**
 * A card with nothing to read. An em dash where the number would be — a zero would claim a
 * measurement that was never taken — and the reason as a sentence, with the way to fix it when the
 * merchant can.
 */
function UnavailableCard({ label, reason, message, action }: { label: string; reason: SignalReason; message: string; action: { label: string; to: string } | null }) {
  return (
    <SignalShell
      label={label}
      value={<span className="text-[24px] font-semibold leading-none tracking-tight text-surface-300 tabular-nums">—</span>}
      caption={
        <>
          <span data-reason={reason}>{message}</span>
          {action && (
            <>
              {' '}
              <Link to={action.to} className="font-medium text-brand-700 hover:underline">{action.label}</Link>
            </>
          )}
        </>
      }
    />
  );
}

/** Where the merchant can fix a card that has nothing to read — nowhere for what only the operator can. */
function actionFor(card: 'search' | 'speed' | 'ai', reason: SignalReason): { label: string; to: string } | null {
  if (card === 'search') {
    if (reason === 'not_connected') return { label: 'Connect', to: '/integrations' };
    if (reason === 'no_property' || reason === 'error') return { label: 'Open Integrations', to: '/integrations' };
  }
  if (card === 'speed' && reason === 'not_measured') return { label: 'Open Integrations', to: '/integrations' };
  if (card === 'ai' && (reason === 'no_queries' || reason === 'no_data')) return { label: 'Open AI Discovery', to: '/ai-discovery' };
  return null;
}

function ChangeChip({ delta, text }: { delta: number; text: string }) {
  if (delta === 0) return <span className={`${badgeBase} ${neutralBadge}`}>No change</span>;
  const up = delta > 0;
  const tone = up ? statusTone.excellent.badge : statusTone.critical.badge;
  return (
    <span className={`${badgeBase} ${tone}`} aria-label={`${up ? 'Up' : 'Down'} ${text} since the previous period`}>
      {up ? <ArrowUp size={10} strokeWidth={2.5} aria-hidden="true" /> : <ArrowDown size={10} strokeWidth={2.5} aria-hidden="true" />}
      {text}
    </span>
  );
}

// ─── Organic search clicks ───────────────────────────────────────────

function SearchTrafficCard({ signal }: { signal: Signal<SearchTrafficSignal> }) {
  const label = 'Organic search clicks';
  if (signal.status === 'unavailable') {
    return <UnavailableCard label={label} reason={signal.reason} message={signal.message} action={actionFor('search', signal.reason)} />;
  }
  const { clicks, changePercent, days, startDate, endDate, previousClicks } = signal.data;
  return (
    <SignalShell
      label={label}
      title={`${startDate} to ${endDate} · ${previousClicks.toLocaleString('en-US')} clicks in the ${days} days before`}
      badge={changePercent !== null ? <ChangeChip delta={changePercent} text={`${Math.abs(changePercent).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`} /> : undefined}
      value={<Figure>{clicks.toLocaleString('en-US')}</Figure>}
      caption={`Last ${days} days · Search Console`}
    />
  );
}

// ─── Mobile LCP ──────────────────────────────────────────────────────

const ratingBadge: Record<VitalRating, { text: string; tone: string }> = {
  good: { text: 'Good', tone: statusTone.excellent.badge },
  'needs-improvement': { text: 'Needs work', tone: statusTone['needs-work'].badge },
  poor: { text: 'Poor', tone: statusTone.critical.badge },
};

function MobileSpeedCard({ signal }: { signal: Signal<MobileSpeedSignal> }) {
  const label = 'Mobile LCP';
  if (signal.status === 'unavailable') {
    return <UnavailableCard label={label} reason={signal.reason} message={signal.message} action={actionFor('speed', signal.reason)} />;
  }
  const { source, lcpMs, rating, scope, measuredAt } = signal.data;
  const badge = ratingBadge[rating];
  return (
    <SignalShell
      label={label}
      title={`Measured ${formatLastUpdated(measuredAt)}`}
      badge={<span className={`${badgeBase} ${badge.tone}`}>{badge.text}</span>}
      value={<><Figure>{(lcpMs / 1000).toFixed(1)}</Figure><Unit>s</Unit></>}
      caption={
        source === 'lab'
          ? 'Lab test · no visitor data yet'
          : `Field · p75 · ${scope === 'origin' ? 'whole site' : 'rolling 28 days'}`
      }
    />
  );
}

// ─── AI mention rate ─────────────────────────────────────────────────

function AiMentionCard({ signal }: { signal: Signal<AiMentionSignal> }) {
  const label = 'AI mention rate';
  if (signal.status === 'unavailable') {
    return <UnavailableCard label={label} reason={signal.reason} message={signal.message} action={actionFor('ai', signal.reason)} />;
  }
  const { rate, mentions, samples, provisional, minSamples, changePoints } = signal.data;
  return (
    <SignalShell
      label={label}
      title={provisional ? `Fewer than ${minSamples} answers sampled — treat this as an early read` : undefined}
      badge={
        provisional
          ? <span className={`${badgeBase} ${neutralBadge}`}>Early read</span>
          : changePoints !== null
            ? <ChangeChip delta={changePoints} text={`${Math.abs(changePoints)} pp`} />
            : undefined
      }
      value={<><Figure>{Math.round(rate * 100)}</Figure><Unit>%</Unit></>}
      caption={`${mentions.toLocaleString('en-US')} ${mentions === 1 ? 'mention' : 'mentions'} / ${samples.toLocaleString('en-US')} sampled ${samples === 1 ? 'answer' : 'answers'}`}
    />
  );
}

// ─── Awaiting your approval ──────────────────────────────────────────

function ApprovalsCard({ signal }: { signal: Signal<ApprovalSignal> }) {
  const navigate = useNavigate();
  const label = 'Awaiting your approval';
  if (signal.status === 'unavailable') {
    return <UnavailableCard label={label} reason={signal.reason} message={signal.message} action={null} />;
  }

  // A draft on a pillar this customer cannot see has no page to review it on, and is not counted.
  const areas = signal.data.areas.filter((area) => isPillarVisible(area.pillar) && area.pillar in pillarMeta);
  const total = areas.reduce((sum, area) => sum + area.count, 0);
  // The area holding the most drafts — the list is already largest first.
  const first = areas[0];
  const reviewRoute = first ? routeFor(first.pillar as PillarKey, first.subPillar) : null;

  return (
    <SignalShell
      label={label}
      badge={
        reviewRoute ? (
          <button
            type="button"
            onClick={() => navigate(reviewRoute)}
            aria-label={`Review ${total} ${total === 1 ? 'draft' : 'drafts'} awaiting your approval`}
            className={`${badgeBase} cursor-pointer bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100 transition-colors hover:bg-brand-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}
          >
            Review
          </button>
        ) : undefined
      }
      value={<Figure>{total.toLocaleString('en-US')}</Figure>}
      caption={total > 0 ? 'Drafts have not been published' : 'Nothing is waiting for your approval'}
    />
  );
}

// ─── Loading ─────────────────────────────────────────────────────────

function SignalSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading search, speed, AI answers and drafts">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className={`${cardClass} space-y-2 px-3 pb-2.5 pt-3`}>
          <div className="skeleton h-3.5 w-28" />
          <div className="skeleton h-6 w-14" />
          <div className="skeleton h-2.5 w-36" />
        </div>
      ))}
    </div>
  );
}
