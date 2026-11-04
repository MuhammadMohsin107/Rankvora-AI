import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ExternalLink, Gauge, Loader2, Smartphone, Monitor } from 'lucide-react';
import {
  describePageSpeedFailure,
  fetchPageSpeedStatus,
  formatCls,
  formatMeasuredAt,
  formatMilliseconds,
  runPageSpeedMeasurement,
  type PageSpeedFieldMetric,
  type PageSpeedReport,
  type PageSpeedStatus,
} from '../../data/pagespeed.repository';
import { pagespeedHealth } from '../../data/pagespeedHealth';
import { Button, StatusBadge } from '../workflows/WorkflowPrimitives';

/**
 * ─── PageSpeed Insights connector ────────────────────────────────────
 *
 * Every number shown here was produced by Google's PageSpeed Insights API in a run this store
 * asked for. There is no sample report and no placeholder metric: a store that has never been
 * measured shows no numbers at all, and a metric Google did not return is left out rather than
 * rendered as a zero.
 *
 * FOUR STATES, because each needs something different:
 *
 *   no storefront     No Shopify store connected, so there is nothing public to measure. No Run
 *                     button is offered — there is nothing behind it.
 *   never measured    Ready, but nothing has been run. Shows what a run will do and how long.
 *   failed            Google refused or could not finish. Shows its reason, keeps any older
 *                     measurement visible, and offers a retry.
 *   measured          Real field and lab numbers.
 *
 * ─── Field and lab are shown as two different things ─────────────────
 * FIELD is what real visitors experienced over Google's trailing 28-day window — this is what
 * Core Web Vitals are and what Search ranks on. LAB is one Lighthouse run on an emulated phone,
 * deliberately pessimistic, and describes nobody's actual visit. A new or quiet store has no field
 * data at all, which is a fact about sample size and is said in those words rather than shown as a
 * zero or quietly replaced with the lab number.
 *
 * INP IS NEVER SHOWN FROM A LAB RUN. It cannot be measured without a real person interacting, so
 * where there is no field data there is no INP — Lighthouse's Total Blocking Time appears under
 * its own name, never as INP.
 */

/** Google loads the page in a real browser on its own hardware. This is the honest expectation. */
const EXPECTED_RUN_SECONDS = 60;

const RATING_TONE: Record<PageSpeedFieldMetric['rating'], string> = {
  good: 'text-success-700',
  'needs-improvement': 'text-warning-700',
  poor: 'text-critical-700',
};

const RATING_LABEL: Record<PageSpeedFieldMetric['rating'], string> = {
  good: 'Good',
  'needs-improvement': 'Needs work',
  poor: 'Poor',
};

const DEVICE = {
  mobile: { label: 'Mobile', Icon: Smartphone },
  desktop: { label: 'Desktop', Icon: Monitor },
} as const;

/** A performance score band, using Google's own published cut-offs (90+ good, 50–89 average). */
function scoreTone(score: number): string {
  if (score >= 90) return 'text-success-700';
  if (score >= 50) return 'text-warning-700';
  return 'text-critical-700';
}

function MetricTile({ label, value, rating, note }: { label: string; value: string; rating?: PageSpeedFieldMetric['rating']; note?: string }) {
  return (
    <div className="rounded-md bg-surface-50 px-2 py-1">
      <p className="truncate text-[9.5px] font-bold uppercase tracking-[0.1em] text-surface-500" title={label}>{label}</p>
      <p className={`mt-0.5 text-[13px] font-semibold tabular-nums ${rating ? RATING_TONE[rating] : 'text-surface-900'}`}>{value}</p>
      {(rating || note) && (
        <p className="truncate text-[9.5px] leading-[1.3] text-surface-500">{rating ? RATING_LABEL[rating] : note}</p>
      )}
    </div>
  );
}

/**
 * One device's measurement.
 *
 * `showFieldNotice` is false when the CALLER has already said, once and above both panels, that
 * Google has no real-visitor data. The sentence is identical for mobile and desktop, and printed
 * twice it was two of the tallest rows on the card saying the same thing.
 */
function ReportPanel({ report, showFieldNotice }: { report: PageSpeedReport; showFieldNotice: boolean }) {
  const { label, Icon } = DEVICE[report.strategy];
  const field = report.field;
  const lab = report.lab;

  return (
    <div className="rounded-md border border-surface-200 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-surface-800">
          <Icon size={12} aria-hidden="true" />
          {label}
        </p>
        {report.performanceScore !== null && (
          <p className="text-[10.5px] text-surface-500">
            Performance{' '}
            <span className={`text-[12.5px] font-semibold tabular-nums ${scoreTone(report.performanceScore)}`}>
              {report.performanceScore}
            </span>
            <span className="text-surface-400">/100</span>
          </p>
        )}
      </div>

      {/* ── Real visitors, when Google has enough of them ─────────── */}
      {field ? (
        <div className="mt-1.5">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-surface-500">
            Real visitors · last 28 days
            {/* Origin-level data describes every page on the domain, not this one. Saying so is the
                difference between a measurement and a misattribution. */}
            {field.scope === 'origin' && <span className="ml-1 font-medium normal-case tracking-normal text-surface-400">— whole domain</span>}
          </p>
          <div className="mt-1 grid grid-cols-3 gap-1.5">
            {field.lcp
              ? <MetricTile label="LCP" value={formatMilliseconds(field.lcp.p75)} rating={field.lcp.rating} />
              : <MetricTile label="LCP" value="—" note="Not reported" />}
            {field.inp
              ? <MetricTile label="INP" value={formatMilliseconds(field.inp.p75)} rating={field.inp.rating} />
              : <MetricTile label="INP" value="—" note="Not reported" />}
            {field.cls
              ? <MetricTile label="CLS" value={formatCls(field.cls.p75)} rating={field.cls.rating} />
              : <MetricTile label="CLS" value="—" note="Not reported" />}
          </div>
        </div>
      ) : showFieldNotice ? (
        <p className="mt-1.5 rounded-md bg-surface-50 px-2 py-1 text-[10.5px] leading-[1.4] text-surface-600">
          {/* A real absence, said plainly. Not an error, and not filled in from the lab run below. */}
          No real-visitor data for this device yet — INP cannot be shown until it exists.
        </p>
      ) : null}

      {/* ── Lighthouse lab run, always available ──────────────────── */}
      <div className="mt-1.5">
        <p className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-surface-500">Lab test · emulated {label.toLowerCase()}</p>
        {/* Two by two, not four across: each panel is half the card now, and four tiles on one row
            clipped "Blocking time" to an ellipsis at every width below a desktop monitor. */}
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          <MetricTile label="LCP" value={lab.lcpMs !== null ? formatMilliseconds(lab.lcpMs) : '—'} note="Lab" />
          <MetricTile label="CLS" value={lab.cls !== null ? formatCls(lab.cls) : '—'} note="Lab" />
          {/* Named as itself. TBT is Lighthouse's lab proxy for responsiveness and is NOT INP. */}
          <MetricTile label="Blocking time" value={lab.tbtMs !== null ? formatMilliseconds(lab.tbtMs) : '—'} note="Proxy for INP" />
          <MetricTile label="Speed Index" value={lab.speedIndexMs !== null ? formatMilliseconds(lab.speedIndexMs) : '—'} note="Lab" />
        </div>
      </div>

      {report.opportunities.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-surface-500">Biggest savings Google costed</p>
          <ul className="mt-0.5 divide-y divide-surface-100">
            {report.opportunities.slice(0, 3).map((opportunity) => (
              <li key={opportunity.id} className="flex items-center justify-between gap-2 py-[3px]">
                <span className="min-w-0 truncate text-[11px] text-surface-800">{opportunity.title}</span>
                <span className="flex-shrink-0 text-[10.5px] tabular-nums text-surface-500">
                  {formatMilliseconds(opportunity.savingsMs)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface PageSpeedCardProps {
  /**
   * Called whenever this card has changed what is known about the connector — a measurement, a
   * failure. The Integrations page re-reads its verdict on it, so this card and the catalogue card
   * below it never describe the same connector differently.
   */
  onHealthChange?: () => void;
}

export default function PageSpeedCard({ onHealthChange }: PageSpeedCardProps = {}) {
  const [status, setStatus] = useState<PageSpeedStatus | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  /** Why the status read failed. Separate from `error`, which is about a run the merchant started. */
  const [loadError, setLoadError] = useState('');

  // A ref, so `load` keeps a stable identity and a parent passing a new function never re-reads.
  const onHealthChangeRef = useRef(onHealthChange);
  useEffect(() => {
    onHealthChangeRef.current = onHealthChange;
  });

  const load = useCallback(async () => {
    try {
      setState('loading');
      setLoadError('');
      setStatus(await fetchPageSpeedStatus());
      setState('ready');
    } catch (err) {
      setLoadError(describePageSpeedFailure(err));
      setState('error');
    } finally {
      onHealthChangeRef.current?.();
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRun() {
    setRunning(true);
    setError('');
    try {
      setStatus(await runPageSpeedMeasurement());
    } catch (err) {
      setError(describePageSpeedFailure(err));
      // The run recorded its own failure server-side, so re-reading is what puts that on the
      // badge. A failed run must not leave the card claiming the state it had before.
      try {
        setStatus(await fetchPageSpeedStatus());
      } catch {
        // The error above is already on screen and the next load will correct the rest.
      }
    } finally {
      setRunning(false);
      onHealthChangeRef.current?.();
    }
  }

  // The same verdict the Integrations catalogue and the drawer show, derived from the status
  // already on screen, so this badge cannot disagree with them.
  const health = status ? pagespeedHealth(status) : null;

  if (state === 'loading' && !status) {
    return (
      <article className="rounded-lg border border-surface-200 bg-surface-0 p-3">
        <div className="flex items-center gap-2 text-[12px] text-surface-500">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
          Checking PageSpeed Insights…
        </div>
      </article>
    );
  }

  return (
    <article className="rounded-lg border border-surface-200 bg-surface-0 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 gap-2.5">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-100 text-surface-700">
            <Gauge size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[12.5px] font-bold text-surface-950">PageSpeed Insights</h3>
            <p className="mt-0.5 text-[11.5px] leading-[1.4] text-surface-500">
              How fast your storefront actually is — Core Web Vitals from real Chrome visitors, and
              a Lighthouse lab test that says what to fix first.
            </p>
          </div>
        </div>

        {health && <StatusBadge label={health.badge.label} tone={health.badge.tone} />}
      </div>

      {state === 'error' && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-md border border-critical-200 bg-critical-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-critical-800">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            {loadError}{' '}
            <button type="button" onClick={() => void load()} className="cursor-pointer font-semibold underline underline-offset-2">Retry</button>
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-md border border-critical-200 bg-critical-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-critical-800">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {/* The recorded reason the last run failed. Shown even when an older measurement is still
          on file below, because otherwise the card would present stale numbers as current. */}
      {status?.lastError && status.lastError !== error && (
        <p className="mt-2 rounded-md border border-warning-100 bg-warning-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-warning-800">
          {status.lastError}
        </p>
      )}

      {/* ── Nothing to measure ───────────────────────────────────── */}
      {status && !status.storefrontUrl && (
        <p className="mt-2 rounded-md bg-surface-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-surface-600">
          There is no storefront to measure yet. PageSpeed Insights measures your live public store,
          so connect your Shopify store in the panel above first. Nothing needs to be set up for
          PageSpeed itself — it asks for no account and no permissions.
        </p>
      )}

      {status?.storefrontUrl && (
        <div className="mt-2.5 border-t border-surface-100 pt-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="min-w-0 truncate font-mono text-[11.5px] text-surface-700">{status.storefrontUrl}</p>
            <p className="text-[10.5px] text-surface-500">
              {status.lastMeasuredAt ? `Measured ${formatMeasuredAt(status.lastMeasuredAt)}` : 'Never measured'}
            </p>
          </div>

          {status.reports.length === 0 ? (
            <p className="mt-2 text-[11.5px] leading-[1.4] text-surface-500">
              No measurement has been taken yet, so nothing is known about this store's speed —
              and nothing is estimated in its place. A run asks Google to load your storefront on an
              emulated phone and on desktop; it usually takes under a minute.
            </p>
          ) : (
            <>
              {/* Said ONCE, above both devices, when neither has real-visitor data — which is the
                  normal case for a new or quiet store, and was printing the same four-line
                  paragraph twice. Per-device only when the two genuinely differ. */}
              {status.reports.every((report) => !report.field) && (
                <p className="mt-2 rounded-md bg-surface-50 px-2.5 py-1.5 text-[11px] leading-[1.4] text-surface-600">
                  Google has no real-visitor data for this page yet — that needs enough Chrome
                  visits to report anonymously, so a new or quiet store has none. It is not a
                  measurement of zero, and INP cannot be shown at all until it exists. The lab test
                  below always runs.
                </p>
              )}

              {/* Side by side from `lg`: mobile and desktop are two readings of the same moment and
                  are read by comparing them, which stacking made impossible without scrolling. */}
              <div className="mt-2 grid gap-2 lg:grid-cols-2">
                {/* Mobile first — it is the measurement Google ranks on. */}
                {[...status.reports]
                  .sort((a, b) => (a.strategy === b.strategy ? 0 : a.strategy === 'mobile' ? -1 : 1))
                  .map((report) => (
                    <ReportPanel
                      key={report.strategy}
                      report={report}
                      showFieldNotice={!status.reports.every((entry) => !entry.field)}
                    />
                  ))}
              </div>
            </>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-surface-100 pt-2">
            <Button onClick={() => void handleRun()} disabled={running}>
              {running
                ? <><Loader2 size={15} className="animate-spin motion-reduce:animate-none" />Measuring…</>
                : status.reports.length === 0 ? 'Run first measurement' : 'Measure again'}
            </Button>
            {running && (
              // Said before the wait, not discovered during it. Google is loading the storefront
              // in a real browser; a spinner with no explanation reads as a hang.
              <p className="text-[11px] leading-[1.4] text-surface-500">
                Google is loading your storefront in a real browser. This usually takes up to {EXPECTED_RUN_SECONDS} seconds.
              </p>
            )}
            {!running && (
              <a
                href={`https://pagespeed.web.dev/analysis?url=${encodeURIComponent(status.storefrontUrl)}`}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-600 underline-offset-2 hover:underline"
              >
                Open in PageSpeed Insights <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>

          {!status.keyed && (
            // An operator note, kept quiet and kept honest: the connector works without a key, and
            // this explains the rate-limiting that a shared anonymous quota can cause.
            <p className="mt-1.5 text-[10.5px] leading-[1.4] text-surface-400">
              This server calls PageSpeed Insights without an API key, on Google's shared anonymous
              quota. Set PAGESPEED_API_KEY to give it a quota of its own.
            </p>
          )}

          {status.lastMeasuredAt && !status.lastError && (
            <p className="mt-1.5 flex items-center gap-1 text-[10.5px] text-surface-400">
              <Check size={11} aria-hidden="true" />
              Last measured {formatMeasuredAt(status.lastMeasuredAt)}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
