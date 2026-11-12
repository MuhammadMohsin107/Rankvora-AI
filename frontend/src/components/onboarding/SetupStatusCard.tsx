import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ChevronDown } from 'lucide-react';
import CapabilityList from './CapabilityList';
import { fetchOnboardingShared, type OnboardingSnapshot } from '../../data/onboarding.repository';

/**
 * What is still to set up, and when the next scan is — on the dashboard, for a store whose guided
 * setup is finished.
 *
 * Setup ends on the dashboard, not on a "congratulations" screen, so the first thing a merchant
 * sees next to their results is the short list of things that would make those results better: the
 * measurement sources they skipped, the AI questions they have not added. Each row is read from live
 * records and carries the one action that fixes it.
 *
 * THIS IS NOT A WARNING. A source the merchant chose not to connect is an invitation, shown in the
 * brand colour — never a red mark against their store.
 *
 * Renders nothing when there is nothing true to say: setup unfinished (the resume card owns that),
 * nothing left to do and no schedule to report, or the read failed. A card that cannot say something
 * true stays off the page.
 */
export default function SetupStatusCard() {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await fetchOnboardingShared();
        if (!cancelled) setSnapshot(state);
      } catch {
        // Silent: an aid, and failing to load one is not worth an error on a merchant's dashboard.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!snapshot || !snapshot.connected || !snapshot.completedAt) return null;

  const todo = snapshot.capabilities.filter((capability) => capability.status === 'action_required');
  const { schedule } = snapshot;

  let nextScan: string | null = null;
  if (schedule.enabled && schedule.nextScanAt) {
    const date = new Date(schedule.nextScanAt);
    if (!Number.isNaN(date.getTime())) {
      try {
        nextScan = date.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
          ...(schedule.timeZone ? { timeZone: schedule.timeZone } : {}),
        });
      } catch {
        nextScan = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      }
    }
  }

  const scheduleLine = schedule.enabled
    ? nextScan
      ? `Next scheduled scan: ${nextScan}${schedule.timeZone ? ` (${schedule.timeZone})` : ''}`
      : 'Scheduled scans are on.'
    : 'Scheduled scans are off.';

  if (todo.length === 0 && !schedule.enabled) return null;

  return (
    <section className="rounded-2xl bg-surface-0 ring-1 ring-inset ring-surface-200">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2.5">
        <p className="flex items-center gap-2 text-[12px] text-surface-600">
          <CalendarClock size={14} className="flex-shrink-0 text-surface-400" aria-hidden="true" />
          {scheduleLine}
          <Link to="/onboarding" className="font-semibold text-brand-700 hover:underline">
            Change
          </Link>
        </p>
        {todo.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((previous) => !previous)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-semibold text-surface-700 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {todo.length} more thing{todo.length === 1 ? '' : 's'} to set up
            <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && todo.length > 0 && (
        <div className="border-t border-surface-100 px-4 py-3">
          <CapabilityList capabilities={snapshot.capabilities} onlyAttention compact />
        </div>
      )}
    </section>
  );
}
