import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, ExternalLink, Loader2, PackageSearch } from 'lucide-react';
import {
  fetchProductReadiness,
  type ProductReadiness,
  type ProductReadinessResult,
  type ProductRowStatus,
} from '../../data/aiDiscovery.repository';
import { ApiError } from '../../lib/api';
import { cardClass } from '../dashboard/scoreTone';
import { Button, MetricTile, StatusBadge } from '../workflows/WorkflowPrimitives';

/**
 * ─── Per-product AI readiness ────────────────────────────────────────
 *
 * The AI Discovery sub-pillars answer "what share of products pass". This answers the question a
 * merchant asks half a second later — WHICH ONES — and is the only surface in the pillar they can
 * work through top to bottom.
 *
 * ─── NOTHING HERE IS MEASURED BY THIS PANEL ──────────────────────────
 * Every verdict, every issue sentence and every recommendation comes from the same `assess()`
 * function the corresponding audit check calls. This is a different view of real measurements, not
 * a second opinion. A product marked Critical here is Critical on its sub-pillar page, worded
 * identically, because it is literally the same string.
 *
 * ─── The score is a count and the panel says so ──────────────────────
 * `readinessScore` is checks-passed ÷ checks-applicable. Three checks apply to every product, so
 * the only values that exist are 0, 33, 67 and 100. The row shows "2 of 3" beside the percentage
 * rather than the percentage alone, because a bare 67% invites the reader to imagine a model
 * behind it. There is none, deliberately.
 *
 * ─── Coverage is stated, never implied ───────────────────────────────
 * When Shopify reports a catalogue total, the panel says how many of how many were assessed. When
 * it does not, it says the total is unknown — it never treats "unknown" as "all of them".
 */

const STATUS_TONE: Record<ProductRowStatus, 'success' | 'warning' | 'critical'> = {
  Healthy: 'success',
  'Needs Work': 'warning',
  Critical: 'critical',
};

type Filter = 'All' | ProductRowStatus;
const FILTERS: Filter[] = ['All', 'Critical', 'Needs Work', 'Healthy'];

/** Rows rendered before the "show more" control. A catalogue can be thousands long. */
const PAGE_SIZE = 25;

function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not reach the Rankvora AI API. Check that the backend is running.';
  if (error.status === 404 && error.code !== 'STORE_NOT_FOUND') {
    return 'This server has no product-readiness endpoint. The API is running an older build — redeploy and restart it.';
  }
  if (error.status === 401) return 'Your session has expired. Sign in again, then reopen this page.';
  if (error.code === 'SHOPIFY_NOT_CONNECTED') {
    return 'Connect your Shopify store on the Integrations page — this reads your live catalogue.';
  }
  return error.message;
}

/** One product, expandable to its three signal verdicts. */
function ProductRow({ product }: { product: ProductReadiness }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <>
      <tr className="border-b border-surface-50 last:border-0 hover:bg-surface-50">
        <td className="px-3 py-1.5">
          <button
            onClick={() => setOpen((value) => !value)}
            className="flex w-full items-start gap-1.5 text-left"
            aria-expanded={open}
          >
            <Chevron size={13} className="mt-0.5 flex-shrink-0 text-surface-400" />
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] font-medium text-surface-900">{product.title}</span>
              {(product.vendor || product.productType) && (
                <span className="block truncate text-[11px] text-surface-400">
                  {[product.vendor, product.productType].filter(Boolean).join(' · ')}
                </span>
              )}
            </span>
          </button>
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap">
          <StatusBadge label={product.status} tone={STATUS_TONE[product.status]} />
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap text-right text-[12.5px] tabular-nums text-surface-800">
          {product.readinessScore}%
          {/* The raw count, so the percentage cannot be mistaken for a weighted model. */}
          <span className="ml-1.5 text-[11px] text-surface-400">{product.passed} of {product.applicable}</span>
        </td>
        <td className="px-3 py-1.5 text-right">
          {product.url && (
            <a
              href={product.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-600 hover:text-brand-700"
            >
              View <ExternalLink size={11} />
            </a>
          )}
        </td>
      </tr>

      {open && (
        <tr className="border-b border-surface-50 bg-surface-50/60">
          <td colSpan={4} className="px-3 py-2">
            <div className="space-y-2">
              {product.signals.map((signal) => (
                <div key={signal.subPillar} className="flex items-start gap-2">
                  {/* No verdict, no status colour: a product whose variants were not all read is
                      neither passing nor failing, and the server left it out of the score. */}
                  {signal.measured === false
                    ? <StatusBadge label="Not measured" tone="neutral" />
                    : <StatusBadge label={signal.status} tone={STATUS_TONE[signal.status]} />}
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-surface-900">{signal.label}</p>
                    {/* The check's own wording, verbatim. Rephrasing it here would let this panel
                        and the sub-pillar page describe the same fact differently. */}
                    <p className="text-[11.5px] leading-[1.45] text-surface-600">
                      {signal.issue ? `${signal.issue} — ${signal.detail}` : signal.detail}
                    </p>
                    {signal.status !== 'Healthy' && signal.recommendation && (
                      <p className="mt-0.5 text-[11.5px] leading-[1.45] text-brand-700">{signal.recommendation}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function ProductReadinessPanel() {
  const [data, setData] = useState<ProductReadinessResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('All');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [hasRun, setHasRun] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchProductReadiness());
      setShown(PAGE_SIZE);
    } catch (caught) {
      setData(null);
      setError(describeFailure(caught));
    } finally {
      setLoading(false);
      setHasRun(true);
    }
  }, []);

  // Not run on mount: this reads the whole catalogue through the Shopify Admin API, which is the
  // same work an audit does. Spending that on every page view would rate-limit the merchant's own
  // shop for a panel they may not have scrolled to.
  useEffect(() => { /* no auto-run */ }, []);

  const filtered = useMemo(
    () => (data ? data.products.filter((product) => filter === 'All' || product.status === filter) : []),
    [data, filter],
  );

  return (
    <section className={cardClass} aria-labelledby="product-readiness-title">
      <div className="flex flex-wrap items-start justify-between gap-2.5 border-b border-surface-100 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-surface-500">Catalog</p>
          <h2 id="product-readiness-title" className="mt-1 flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-surface-950">
            <PackageSearch size={15} className="text-brand-500" />
            Product AI readiness
          </h2>
          <p className="mt-1 text-[12px] leading-[1.45] text-surface-500">
            Which of your products an AI assistant can find, match and act on — one row each, worst first.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Reading catalog…' : hasRun ? 'Re-check' : 'Check my products'}
        </Button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-surface-500">
          <Loader2 size={14} className="animate-spin" />
          Reading your live catalog from Shopify…
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 px-3 py-3.5">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-warning-600" />
          <div>
            <p className="text-[12.5px] leading-[1.5] text-surface-700">{error}</p>
            <div className="mt-2.5"><Button variant="secondary" onClick={() => void load()}>Retry</Button></div>
          </div>
        </div>
      )}

      {!loading && !error && !data && (
        <p className="px-3 py-3.5 text-[12.5px] leading-[1.5] text-surface-600">
          Nothing checked yet. This reads your live catalog from Shopify and runs the same three product
          checks an audit runs, then ranks every product worst-first. Press the button when you want it.
        </p>
      )}

      {!loading && !error && data && data.summary.analyzed === 0 && (
        // A store with no products is not a failure, and is never shown as 0% ready.
        <p className="px-3 py-3.5 text-[12.5px] leading-[1.5] text-surface-600">
          {data.summary.unpublished > 0
            ? `None of this store’s ${data.summary.unpublished.toLocaleString()} products are published to the online store, so no assistant can reach one to assess.`
            : 'This store has no products yet, so there is nothing to assess.'}
        </p>
      )}

      {!loading && !error && data && data.summary.analyzed > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2.5 px-3 py-2.5 lg:grid-cols-4">
            <MetricTile
              label="Average readiness"
              value={data.summary.averageScore === null ? '—' : `${data.summary.averageScore}%`}
              detail={`across ${data.summary.analyzed.toLocaleString()} products`}
              tone={
                data.summary.averageScore !== null && data.summary.averageScore >= 80
                  ? 'success'
                  : data.summary.averageScore !== null && data.summary.averageScore >= 50
                    ? 'warning'
                    : 'critical'
              }
            />
            <MetricTile label="Critical" value={data.summary.critical.toLocaleString()} detail="an agent cannot act on these" tone={data.summary.critical > 0 ? 'critical' : 'neutral'} />
            <MetricTile label="Needs work" value={data.summary.needsWork.toLocaleString()} detail="usable but incomplete" tone={data.summary.needsWork > 0 ? 'warning' : 'neutral'} />
            <MetricTile label="Ready" value={data.summary.healthy.toLocaleString()} detail="pass all three checks" tone={data.summary.healthy > 0 ? 'success' : 'neutral'} />
          </div>

          <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-100 px-3 py-1.5">
            {FILTERS.map((option) => (
              <button
                key={option}
                onClick={() => { setFilter(option); setShown(PAGE_SIZE); }}
                className={`rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition ${
                  filter === option
                    ? 'border-brand-200 bg-brand-50 text-brand-700'
                    : 'border-surface-200 bg-surface-0 text-surface-600 hover:bg-surface-50'
                }`}
              >
                {option}
                {option !== 'All' && (
                  <span className="ml-1 tabular-nums text-surface-400">
                    {option === 'Critical' ? data.summary.critical : option === 'Needs Work' ? data.summary.needsWork : data.summary.healthy}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto border-t border-surface-100">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-surface-100 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">
                  <th className="px-3 py-1.5">Product</th>
                  <th className="px-3 py-1.5">Status</th>
                  <th className="px-3 py-1.5 text-right">Readiness</th>
                  <th className="px-3 py-1.5 text-right">Storefront</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, shown).map((product) => <ProductRow key={product.id} product={product} />)}
              </tbody>
            </table>
          </div>

          {filtered.length > shown && (
            <div className="border-t border-surface-100 px-3 py-1.5">
              <Button variant="ghost" onClick={() => setShown((value) => value + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, filtered.length - shown)} more of {filtered.length.toLocaleString()}
              </Button>
            </div>
          )}

          {/* Coverage, stated. `available: null` means Shopify did not report a total — which is
              unknown, not "all of them", and this never implies otherwise. */}
          <p className="border-t border-surface-100 px-3 py-1.5 text-[11px] leading-[1.5] text-surface-500">
            {data.summary.available === null
              ? `${data.summary.analyzed.toLocaleString()} products assessed. Shopify did not report a catalog total, so the share of your catalog this covers is unknown.`
              : `${data.summary.analyzed.toLocaleString()} of ${data.summary.exact === false ? 'at least ' : ''}${data.summary.available.toLocaleString()} products assessed.`}
            {data.summary.truncated && ' The catalog is larger than one read returns, so this covers the products read.'}
            {/* Stated, so a total below Shopify's own count is explained rather than a mystery. */}
            {data.summary.unpublished > 0 && ` ${data.summary.unpublished.toLocaleString()} draft, archived or unpublished ${data.summary.unpublished === 1 ? 'product was' : 'products were'} left out — no shopper or assistant can reach ${data.summary.unpublished === 1 ? 'it' : 'them'}.`}
            {' '}Readiness is the share of three checks passed — agent can act on it, agent can match it, description answers buying questions. Each verdict is the same one its sub-pillar page shows.
          </p>
        </>
      )}
    </section>
  );
}
