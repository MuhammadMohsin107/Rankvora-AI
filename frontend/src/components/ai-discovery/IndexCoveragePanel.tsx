import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Search, XCircle } from 'lucide-react';
import { fetchIndexCoverage, type IndexCoverage, type InspectedUrl } from '../../data/aiDiscovery.repository';
import { ApiError } from '../../lib/api';
import { cardClass } from '../dashboard/scoreTone';
import { Button, MetricTile, StatusBadge } from '../workflows/WorkflowPrimitives';

/**
 * ─── Google index coverage ───────────────────────────────────────────
 *
 * What Google ACTUALLY HAS, page by page, from its own index — not what the store publishes about
 * itself. A sitemap listing 189 URLs is a claim; this is Google's answer to it.
 *
 * ─── Why this panel insists on the word "sample" ─────────────────────
 * Each inspection spends one unit of the merchant's own Search Console quota (~2,000/day), so a
 * whole catalogue is never walked. Every figure here therefore describes A SAMPLE, and the panel
 * labels it as one in the metric tile itself rather than in small print — a merchant told
 * "92% indexed" will act on it as a census, reprice their expectations, and be wrong.
 *
 * ─── Not run automatically ───────────────────────────────────────────
 * The merchant presses the button. An inspection costs them quota they may want for something else,
 * and a panel that silently spent 10 units every time the page mounted would exhaust a day's
 * allowance through ordinary navigation.
 */

const DEFAULT_SAMPLE = 10;

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function describeFailure(error: unknown): { message: string; actionable: boolean } {
  if (!(error instanceof ApiError)) {
    return { message: 'Could not reach the Rankvora AI API. Check that the backend is running.', actionable: false };
  }
  switch (error.code) {
    case 'GOOGLE_NOT_CONNECTED':
      return { message: 'Connect Google Search Console on the Integrations page to read what Google has indexed.', actionable: true };
    case 'GSC_SITE_NOT_SELECTED':
      return { message: 'Choose which Search Console property this store reports on, on the Integrations page.', actionable: true };
    case 'GSC_INSPECTION_QUOTA':
    case 'GSC_ACCESS_DENIED':
    case 'SITEMAP_EMPTY':
    case 'STORE_URL_MISSING':
    case 'STORE_URL_INVALID':
      return { message: error.message, actionable: false };
    default:
      break;
  }
  if (error.status === 404) {
    return { message: 'This server has no index-coverage endpoint. The API is running an older build — redeploy and restart it.', actionable: false };
  }
  if (error.status === 401) return { message: 'Your session has expired. Sign in again, then reopen this page.', actionable: false };
  return { message: error.message, actionable: false };
}

/** One inspected URL. Google's own coverage sentence is the payload — the icon is just a lead. */
function ResultRow({ result }: { result: InspectedUrl }) {
  const Icon = result.error ? AlertCircle : result.indexed ? CheckCircle2 : XCircle;
  const tone = result.error ? 'text-surface-400' : result.indexed ? 'text-success-600' : 'text-warning-600';

  return (
    <tr className="border-b border-surface-50 last:border-0 align-top">
      <td className="px-3 py-1.5">
        <div className="flex items-start gap-1.5">
          <Icon size={13} className={`mt-0.5 flex-shrink-0 ${tone}`} />
          <span className="min-w-0 break-all text-[12px] text-surface-800">{shortPath(result.url)}</span>
        </div>
      </td>
      <td className="px-3 py-1.5">
        {/* Google's wording, verbatim. "Crawled — currently not indexed" is the single most useful
            sentence this feature surfaces, and paraphrasing it would lose the distinction. */}
        <span className="text-[12px] text-surface-600">
          {result.error ?? result.coverageState ?? 'Google returned no coverage state.'}
        </span>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap text-[11.5px] tabular-nums text-surface-500">
        {result.lastCrawlTime ? new Date(result.lastCrawlTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
      </td>
    </tr>
  );
}

export default function IndexCoveragePanel() {
  const [data, setData] = useState<IndexCoverage | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<{ message: string; actionable: boolean } | null>(null);
  // Distinguishes "never run in this session" from "ran and found nothing", which the panel
  // renders differently — the first is an invitation, the second a result.
  const [hasRun, setHasRun] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setFailure(null);
    try {
      setData(await fetchIndexCoverage(DEFAULT_SAMPLE));
    } catch (error) {
      setData(null);
      setFailure(describeFailure(error));
    } finally {
      setRunning(false);
      setHasRun(true);
    }
  }, []);

  // Deliberately NOT run on mount. See the header: each inspection spends the merchant's quota.
  useEffect(() => { /* no auto-run */ }, []);

  return (
    <section className={cardClass} aria-labelledby="index-coverage-title">
      <div className="flex flex-wrap items-start justify-between gap-2.5 border-b border-surface-100 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-surface-500">Google</p>
          <h2 id="index-coverage-title" className="mt-1 flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-surface-950">
            <Search size={15} className="text-brand-500" />
            Index coverage
          </h2>
          <p className="mt-1 text-[12px] leading-[1.45] text-surface-500">
            Asks Google, URL by URL, whether it has actually indexed pages from your sitemap.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && <StatusBadge label={data.siteUrl} tone="neutral" />}
          <Button variant="secondary" onClick={() => void run()} disabled={running}>
            {running ? 'Inspecting…' : hasRun ? 'Run again' : `Inspect ${DEFAULT_SAMPLE} URLs`}
          </Button>
        </div>
      </div>

      {running && (
        <div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-surface-500">
          <Loader2 size={14} className="animate-spin" />
          Asking Google about {DEFAULT_SAMPLE} of your URLs…
        </div>
      )}

      {!running && failure && (
        <div className="px-3 py-3.5">
          <div className="flex items-start gap-2">
            <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-warning-600" />
            <div className="min-w-0">
              <p className="text-[12.5px] leading-[1.5] text-surface-700">{failure.message}</p>
              {failure.actionable && (
                <a
                  href="/integrations"
                  className="mt-2.5 inline-flex items-center gap-1 text-[12px] font-medium text-brand-600 hover:text-brand-700"
                >
                  Open Integrations <ExternalLink size={12} />
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {!running && !failure && !data && (
        <p className="px-3 py-3.5 text-[12.5px] leading-[1.5] text-surface-600">
          Nothing has been inspected yet. Each URL costs one unit of your own Search Console quota
          (Google allows roughly 2,000 a day), so Rankvora AI only asks when you press the button.
        </p>
      )}

      {!running && !failure && data && (
        <>
          <div className="grid grid-cols-2 gap-2.5 px-3 py-2.5 lg:grid-cols-4">
            {/* Null when Google answered for none of the sample: no rate, and no red "0%" verdict
                drawn from zero answers. */}
            <MetricTile
              label="Indexed in sample"
              value={data.sampledIndexRate === null ? '—' : formatPercent(data.sampledIndexRate)}
              detail={data.sampledIndexRate === null ? 'no inspection succeeded' : `${data.indexedCount} of ${data.inspectedCount - data.errorCount} answered`}
              tone={data.sampledIndexRate === null ? 'neutral' : data.sampledIndexRate >= 0.8 ? 'success' : data.sampledIndexRate >= 0.5 ? 'warning' : 'critical'}
            />
            <MetricTile label="Not indexed" value={String(data.notIndexedCount)} detail="of the inspected sample" tone={data.notIndexedCount > 0 ? 'warning' : 'neutral'} />
            <MetricTile label="URLs in sitemap" value={data.sitemapUrlCount.toLocaleString()} detail="the population sampled" />
            <MetricTile label="Could not inspect" value={String(data.errorCount)} detail="excluded from the rate" tone={data.errorCount > 0 ? 'warning' : 'neutral'} />
          </div>

          <div className="border-t border-surface-100 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-surface-100 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">
                  <th className="px-3 py-1.5">URL</th>
                  <th className="px-3 py-1.5">Google’s coverage state</th>
                  <th className="px-3 py-1.5">Last crawled</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((result) => <ResultRow key={result.url} result={result} />)}
              </tbody>
            </table>
          </div>

          {data.isSample && (
            <p className="border-t border-surface-100 px-3 py-1.5 text-[11px] leading-[1.5] text-surface-500">
              This is a <span className="font-medium text-surface-700">sample</span> of{' '}
              {data.inspectedCount} URLs spread across all {data.sitemapUrlCount.toLocaleString()} in your sitemap — not a
              whole-catalogue figure. Inspecting every URL would exhaust your daily Search Console quota.
            </p>
          )}
        </>
      )}
    </section>
  );
}
