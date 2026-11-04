import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bot, ExternalLink, Loader2, TrendingUp } from 'lucide-react';
import { fetchAiReferrals, type AiReferralPerformance } from '../../data/aiDiscovery.repository';
import { useReportDays } from '../../data/reportWindow';
import { ApiError } from '../../lib/api';
import { cardClass } from '../dashboard/scoreTone';
import { ReportWindowPicker } from '../workflows/ReportWindowPicker';
import { Button, MetricTile, StatusBadge } from '../workflows/WorkflowPrimitives';

/**
 * ─── AI referral traffic ─────────────────────────────────────────────
 *
 * The only OUTCOME measure in the AI Discovery pillar. Every other panel reports readiness — is the
 * file published, is the crawler admitted. This reports a person who read an assistant's answer and
 * arrived.
 *
 * EVERY NUMBER IS READ FROM THE STORE'S OWN GA4 PROPERTY in the request that renders it. There is no
 * sample platform, no placeholder session count, and nothing at all is displayed for a store that
 * has not connected Analytics — the panel says what is missing and what to do about it.
 *
 * ─── The floor disclaimer is not decoration ──────────────────────────
 * GA4 cannot see an assistant that answered without linking, an in-app browser that arrives as
 * direct, or a shopper who read an answer and then searched the brand name. So this is a FLOOR on
 * AI-driven traffic and the panel says so on screen, permanently, not in a tooltip. A merchant
 * reading zero here must not conclude AI discovery failed — it may simply be uncredited.
 */

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction > 0 && fraction < 0.001 ? 3 : 2)}%`;
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * What the merchant should do about a failure, in words that point at the fix.
 *
 * The three 409s are the interesting ones: they are not errors so much as unfinished setup, and
 * each needs a different action. Collapsing them into "could not load" would leave a merchant
 * clicking Retry on a panel that will never load until they choose a property.
 */
function describeFailure(error: unknown): { message: string; actionable: boolean } {
  if (!(error instanceof ApiError)) {
    return { message: 'Could not reach the Rankvora AI API. Check that the backend is running.', actionable: false };
  }
  switch (error.code) {
    case 'GOOGLE_NOT_CONNECTED':
      return { message: 'Connect Google on the Integrations page to see which AI assistants send you traffic.', actionable: true };
    case 'GA4_SCOPE_MISSING':
      return { message: 'This Google connection was made before Analytics access was added. Reconnect Google on the Integrations page.', actionable: true };
    case 'GA4_PROPERTY_NOT_SELECTED':
      return { message: 'Choose which Analytics property this store reports on, on the Integrations page.', actionable: true };
    case 'GA4_ACCESS_DENIED':
      return { message: error.message, actionable: true };
    default:
      break;
  }
  if (error.status === 404) {
    return { message: 'This server has no AI referrals endpoint. The API is running an older build — redeploy and restart it.', actionable: false };
  }
  if (error.status === 401) return { message: 'Your session has expired. Sign in again, then reopen this page.', actionable: false };
  return { message: error.message, actionable: false };
}

export default function AiReferralsPanel() {
  const [data, setData] = useState<AiReferralPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<{ message: string; actionable: boolean } | null>(null);
  /** Shared with the two Google cards on Integrations — see data/reportWindow.ts. */
  const days = useReportDays();

  // Re-created when the period changes, so the effect below re-reads Google for the new window.
  // Nothing on screen is relabelled: the tiles are replaced by what the next read returns.
  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setData(await fetchAiReferrals(days));
    } catch (error) {
      setData(null);
      setFailure(describeFailure(error));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className={cardClass} aria-labelledby="ai-referrals-title">
      <div className="flex flex-wrap items-start justify-between gap-2.5 border-b border-surface-100 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-surface-500">Outcome</p>
          <h2 id="ai-referrals-title" className="mt-1 flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-surface-950">
            <TrendingUp size={15} className="text-brand-500" />
            AI referral traffic
          </h2>
          <p className="mt-1 text-[12px] leading-[1.45] text-surface-500">
            Visits that arrived from an AI assistant, read from your own Google Analytics property.
          </p>
        </div>
        {/* The picker survives a failed read that was not a setup problem, so a period the property
            cannot answer for is never a dead end — otherwise a merchant who picked 90d and hit a
            transient error would have no control left to pick 28d again. A missing connection or an
            unchosen property hides it: the period is not what is wrong, and offering it would
            suggest it is. */}
        {(data || (failure && !failure.actionable)) && (
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <ReportWindowPicker value={days} disabled={loading} />
            {data && (
              // The dates Google actually answered for — not the ones the picker asked about.
              <StatusBadge
                label={`${formatDate(data.startDate)} – ${formatDate(data.endDate)}`}
                tone="neutral"
              />
            )}
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-surface-500">
          <Loader2 size={14} className="animate-spin" />
          Reading Analytics…
        </div>
      )}

      {!loading && failure && (
        <div className="px-3 py-3.5">
          <div className="flex items-start gap-2">
            <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-warning-600" />
            <div className="min-w-0">
              <p className="text-[12.5px] leading-[1.5] text-surface-700">{failure.message}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button variant="secondary" onClick={() => void load()}>Retry</Button>
                {failure.actionable && (
                  <a
                    href="/integrations"
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-600 hover:text-brand-700"
                  >
                    Open Integrations <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {!loading && !failure && data && (
        <>
          <div className="grid grid-cols-2 gap-2.5 px-3 py-2.5 lg:grid-cols-4">
            <MetricTile label="AI sessions" value={data.totals.sessions.toLocaleString()} detail={`of ${data.allSessions.toLocaleString()} total`} tone={data.totals.sessions > 0 ? 'info' : 'neutral'} />
            {/* No sessions at all is not a 0% share — there was nothing to take a share of. */}
            <MetricTile
              label="Share of all traffic"
              value={data.totals.shareOfAllSessions === null ? '—' : formatPercent(data.totals.shareOfAllSessions)}
              detail={data.totals.shareOfAllSessions === null ? 'no sessions recorded' : `${days}-day window`}
            />
            <MetricTile label="Engaged sessions" value={data.totals.engagedSessions.toLocaleString()} detail="AI referrals only" />
            <MetricTile label="Conversions" value={data.totals.conversions.toLocaleString()} detail="AI referrals only" tone={data.totals.conversions > 0 ? 'success' : 'neutral'} />
          </div>

          {data.platforms.length > 0 ? (
            <div className="border-t border-surface-100">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-surface-100 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">
                    <th className="px-3 py-1.5">Assistant</th>
                    <th className="px-3 py-1.5 text-right">Sessions</th>
                    <th className="px-3 py-1.5 text-right">Engaged</th>
                    <th className="px-3 py-1.5 text-right">Conversions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.platforms.map((platform) => (
                    <tr key={platform.id} className="border-b border-surface-50 last:border-0">
                      <td className="px-3 py-1.5">
                        <span className="text-[12.5px] font-medium text-surface-900">{platform.label}</span>
                        <span className="ml-1.5 text-[11px] text-surface-400">{platform.vendor}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-[12.5px] tabular-nums text-surface-800">{platform.sessions.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right text-[12.5px] tabular-nums text-surface-600">{platform.engagedSessions.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right text-[12.5px] tabular-nums text-surface-600">{platform.conversions.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            // NOT an error, and never dressed as one. Zero AI referrals in the window is a real
            // measurement of a real property — and the commonest honest result for a store that has
            // only just started publishing for assistants.
            <div className="flex items-start gap-2 border-t border-surface-100 px-3 py-3.5">
              <Bot size={15} className="mt-0.5 flex-shrink-0 text-surface-400" />
              <p className="text-[12.5px] leading-[1.5] text-surface-600">
                No sessions from any of the {data.platformsChecked} AI assistants Rankvora AI recognises arrived in this window.
                Analytics answered — this is a real zero, not a missing reading.
              </p>
            </div>
          )}

          {/* Permanent, not a tooltip. See the header. */}
          <p className="border-t border-surface-100 px-3 py-1.5 text-[11px] leading-[1.5] text-surface-500">
            These are a <span className="font-medium text-surface-700">floor</span>, not a total. An assistant that
            answers from your content without linking sends no referral, an in-app browser often arrives as direct, and a
            shopper who searches your brand after reading an answer is counted as organic search.
          </p>
        </>
      )}
    </section>
  );
}
