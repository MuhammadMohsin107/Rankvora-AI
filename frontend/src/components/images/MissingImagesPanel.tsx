import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ImageOff, ImagePlus, Package, Sparkles, UploadCloud, X } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { scrollChaining } from '../../lib/scrollChaining';
import {
  fetchImageCapabilities,
  fetchMissingImageProducts,
  fetchProductForImages,
  type AttachResult,
  type MissingImageProduct,
  type ProductImageCapabilities,
  type ProductImageSubject,
} from '../../data/productImages.repository';
import { followAuditRun } from '../../data/useAuditRun';
import GrantShopifyAccess from '../audit/GrantShopifyAccess';
import GenerateTab from './GenerateTab';
import UploadTab from './UploadTab';
import Button from '../../components/polaris/Button';
import Banner from '../polaris/Banner';
import { SearchField } from '../polaris/fields';

type Tab = 'upload' | 'ai';

const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Active', DRAFT: 'Draft', ARCHIVED: 'Archived', UNLISTED: 'Unlisted' };

/**
 * ─── Missing images ──────────────────────────────────────────────────
 *
 * One panel for the whole job: find the products in the connected store that have no image, pick
 * one, then either upload a photo from the computer or have AI draw one from the product's own
 * title and description, preview it, and add it to that product in Shopify.
 *
 * EVERYTHING ON SCREEN IS READ FROM SHOPIFY WHEN THE PANEL OPENS — the list of products with no
 * image, each product's title and description, the status of an image just added. The list is not
 * the last audit's sample, so a product fixed a minute ago is already gone from it. When an image is
 * added the panel marks the product done, and the app re-analyses the store in the background so
 * the Media richness numbers, the Products list and each product's page move with it.
 */
export default function MissingImagesPanel({ open, onClose, initialProductId = null, onImageAdded }: {
  open: boolean;
  onClose: () => void;
  /** Opens with this product already chosen — from a product's own page. */
  initialProductId?: string | null;
  /** Called after an image was added to a product, once Shopify accepted it. */
  onImageAdded?: () => void;
}) {
  if (!open) return null;
  return <PanelBody onClose={onClose} initialProductId={initialProductId} onImageAdded={onImageAdded} />;
}

function PanelBody({ onClose, initialProductId, onImageAdded }: {
  onClose: () => void;
  initialProductId: string | null;
  onImageAdded?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape closes (unless an upload or a drawing is under way), focus is kept inside, the page
  // behind does not scroll.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
          event.target.blur();
          return;
        }
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([tabindex="-1"]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // ── What the server says this store and this key can do ──
  const [capabilities, setCapabilities] = useState<ProductImageCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchImageCapabilities()
      .then((value) => { if (live) setCapabilities(value); })
      .catch((error) => { if (live) setCapabilityError(error instanceof ApiError ? error.message : 'Could not check what Rankvora AI can do for this store.'); });
    return () => { live = false; };
  }, []);

  // ── The products with no image, read live ──
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<MissingImageProduct[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [scanned, setScanned] = useState(0);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<{ message: string; code?: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const loadList = useCallback(async (search: string, after: string | null) => {
    const request = ++requestRef.current;
    if (after) setLoadingMore(true); else setListState('loading');
    try {
      const page = await fetchMissingImageProducts({ after, search });
      if (request !== requestRef.current) return;
      setProducts((current) => (after ? [...current, ...page.products.filter((p) => !current.some((c) => c.id === p.id))] : page.products));
      setCursor(page.nextCursor);
      setScanned((current) => (after ? current + page.scanned : page.scanned));
      setListError(null);
      setListState('ready');
    } catch (error) {
      if (request !== requestRef.current) return;
      setListError({ message: error instanceof ApiError ? error.message : 'Your products could not be read from Shopify.', code: error instanceof ApiError ? error.code : undefined });
      setListState('error');
    } finally {
      if (request === requestRef.current) setLoadingMore(false);
    }
  }, []);

  useEffect(() => { void loadList(query, null); }, [query, loadList]);

  // ── The chosen product, read live ──
  const [selectedId, setSelectedId] = useState<string | null>(initialProductId);
  const [subject, setSubject] = useState<ProductImageSubject | null>(null);
  const [subjectState, setSubjectState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [subjectError, setSubjectError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('upload');

  useEffect(() => {
    if (!selectedId) { setSubject(null); setSubjectState('idle'); return undefined; }
    let live = true;
    setSubject(null);
    setSubjectState('loading');
    setSubjectError(null);
    fetchProductForImages(selectedId)
      .then((value) => { if (live) { setSubject(value); setSubjectState('ready'); } })
      .catch((error) => {
        if (!live) return;
        setSubjectError(error instanceof ApiError ? error.message : 'The product could not be read from Shopify.');
        setSubjectState('error');
      });
    return () => { live = false; };
  }, [selectedId]);

  // ── What has been added in this sitting ──
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const handleAdded = (result: AttachResult) => {
    setDone((current) => new Set(current).add(result.productId));
    onImageAdded?.();
    // The re-audit the server queued, followed like one started here: the banner shows it, and every
    // page showing results reloads when it finishes.
    if (result.reauditJobId) followAuditRun(result.reauditJobId);
  };

  const write = capabilities?.write;
  const canWrite = write?.allowed ?? false;
  const needsReconnect = write?.code === 'MISSING_WRITE_SCOPE';
  const doneCount = done.size;
  const showingList = selectedId === null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <div className="absolute inset-0 bg-surface-950/30 motion-safe:animate-fade-in" onClick={() => { if (!busy) onClose(); }} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="missing-images-title"
        className="relative flex h-full w-full max-w-5xl flex-col bg-surface-0 shadow-2xl motion-safe:animate-scale-in"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-surface-200 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-surface-500">Media richness</p>
            <h2 id="missing-images-title" className="mt-0.5 flex items-center gap-2 text-[16px] font-semibold tracking-tight text-surface-950">
              <ImagePlus size={17} className="text-brand-600" aria-hidden="true" />
              Add product images
            </h2>
            <p className="mt-0.5 text-[12px] text-surface-500">
              Products in your store with no image, read live from Shopify. Upload a photo or draw one with AI, then add it to the product.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-surface-500 transition-colors hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Whether Rankvora AI may change this store at all — said once, above everything else. */}
        {capabilityError && (
          <div className="border-b border-surface-200 px-4 py-2">
            <Banner tone="critical"><s-text>{capabilityError}</s-text></Banner>
          </div>
        )}
        {write && !write.allowed && (
          <div className="border-b border-surface-200 px-4 py-2">
            <Banner tone="warning">
              <s-text>{write.reason}</s-text>
              {write.code === 'AUTOMATION_NOT_PERMITTED' && (
                <Button slot="secondary-actions" variant="secondary" to="/onboarding">Review your setup answers</Button>
              )}
            </Banner>
            {needsReconnect && <GrantShopifyAccess scope="write_products" />}
          </div>
        )}

        <div className="grid min-h-0 flex-1 md:grid-cols-[320px_minmax(0,1fr)]">
          {/* ── Left: the products with no image ── */}
          <section className={`min-h-0 flex-col border-surface-200 md:flex md:border-r ${showingList ? 'flex' : 'hidden'}`} aria-label="Products with no image">
            <div className="border-b border-surface-200 px-3 py-2.5">
              <SearchField id="missing-search" label="Search products by name" value={searchInput} onChange={setSearchInput} placeholder="Search by product name…" />
              <p className="mt-1.5 flex items-center justify-between text-[11px] text-surface-500" aria-live="polite">
                {listState === 'ready'
                  ? (
                    <>
                      <span><span className="font-semibold tabular-nums text-surface-800">{products.length}</span> without an image{cursor ? ' so far' : ''}</span>
                      <span className="tabular-nums">{scanned.toLocaleString()} checked</span>
                    </>
                  )
                  : <span>{listState === 'loading' ? 'Reading your store…' : ' '}</span>}
              </p>
            </div>

            <div ref={scrollChaining} className="min-h-0 flex-1 overflow-y-auto [scrollbar-color:var(--c-surface-300)_transparent] [scrollbar-width:thin]">
              {listState === 'loading' && (
                <ul className="space-y-1 p-2" aria-busy="true" aria-label="Loading products">
                  {Array.from({ length: 7 }).map((_, index) => <li key={index} className="skeleton h-14 rounded-lg" />)}
                </ul>
              )}

              {listState === 'error' && listError && (
                <div className="m-3">
                  <Banner tone="critical">
                    <s-text>{listError.message}</s-text>
                    {listError.code === 'SHOPIFY_NOT_CONNECTED' || listError.code === 'SHOPIFY_RECONNECT_REQUIRED'
                      ? <Button slot="secondary-actions" variant="secondary" to="/integrations">Go to Integrations</Button>
                      : <Button slot="secondary-actions" variant="secondary" onClick={() => void loadList(query, null)}>Try again</Button>}
                  </Banner>
                </div>
              )}

              {listState === 'ready' && products.length === 0 && (
                <div className="px-4 py-10 text-center">
                  <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-success-50 text-success-600 ring-1 ring-inset ring-success-100">
                    <CheckCircle2 size={18} aria-hidden="true" />
                  </span>
                  <p className="mt-2.5 text-[13px] font-semibold text-surface-900">
                    {query ? `No product without an image matches “${query}”` : scanned === 0 ? 'Your store has no products yet' : 'Every product has an image'}
                  </p>
                  <p className="mx-auto mt-1 max-w-[16rem] text-[11.5px] leading-[1.5] text-surface-500">
                    {query
                      ? 'Try fewer letters, or clear the search.'
                      : scanned === 0
                        ? 'Add products in Shopify, then come back.'
                        : `All ${scanned.toLocaleString()} products Shopify listed have at least one image.`}
                  </p>
                </div>
              )}

              {listState === 'ready' && products.length > 0 && (
                <ul className="space-y-1 p-2">
                  {products.map((product) => {
                    const isDone = done.has(product.id);
                    const isSelected = product.id === selectedId;
                    return (
                      <li key={product.id}>
                        <button
                          type="button"
                          onClick={() => { setSelectedId(product.id); setTab('upload'); }}
                          disabled={busy && !isSelected}
                          aria-current={isSelected ? 'true' : undefined}
                          className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
                            isSelected ? 'border-brand-300 bg-brand-50/70 ring-1 ring-brand-200' : 'border-transparent hover:border-surface-200 hover:bg-surface-50'
                          }`}
                        >
                          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border border-dashed border-surface-300 bg-surface-50 text-surface-400" aria-hidden="true">
                            {isDone ? <CheckCircle2 size={17} className="text-success-600" /> : <ImageOff size={16} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-semibold text-surface-900">{product.title}</span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-surface-500">
                              {isDone
                                ? <span className="font-semibold text-success-700">Image added</span>
                                : (
                                  <>
                                    {product.status && <span>{STATUS_LABEL[product.status] ?? product.status}</span>}
                                    {product.vendor && <span className="truncate">· {product.vendor}</span>}
                                    {product.otherMedia > 0 && <span>· {product.otherMedia} {product.otherMedia === 1 ? 'video or 3D model' : 'videos or 3D models'}</span>}
                                  </>
                                )}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {listState === 'ready' && cursor && (
                <div className="px-3 pb-3">
                  <Button loading={loadingMore} variant="secondary" onClick={() => void loadList(query, cursor)} disabled={loadingMore} fullWidth>
                    {loadingMore ? 'Reading more of your store…' : 'Look further down your catalogue'}
                  </Button>
                </div>
              )}
            </div>

            {doneCount > 0 && (
              <p className="border-t border-surface-200 bg-success-50 px-3 py-1.5 text-[11.5px] font-medium text-success-800">
                {doneCount} {doneCount === 1 ? 'product has' : 'products have'} a new image
              </p>
            )}
          </section>

          {/* ── Right: the chosen product ── */}
          <section className={`min-h-0 overflow-y-auto md:block ${showingList ? 'hidden' : 'block'}`} aria-label="Add an image" ref={scrollChaining}>
            {selectedId === null && (
              <div className="flex h-full min-h-[18rem] flex-col items-center justify-center px-6 py-10 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-100 text-surface-400"><Package size={22} aria-hidden="true" /></span>
                <p className="mt-3 text-[14px] font-semibold text-surface-900">Choose a product</p>
                <p className="mt-1 max-w-xs text-[12px] leading-[1.5] text-surface-500">Pick a product from the list to upload a photo for it or draw one with AI.</p>
              </div>
            )}

            {selectedId !== null && (
              <div className="mx-auto max-w-2xl space-y-3.5 px-4 py-4">
                <button type="button" onClick={() => setSelectedId(null)} disabled={busy} className="inline-flex items-center gap-1 text-[12px] font-medium text-surface-500 hover:text-surface-900 disabled:opacity-40 md:hidden">
                  <ArrowLeft size={13} aria-hidden="true" />
                  All products
                </button>

                {subjectState === 'loading' && (
                  <div className="space-y-3" aria-busy="true" aria-label="Reading the product from Shopify">
                    <div className="skeleton h-6 w-2/3" />
                    <div className="skeleton h-4 w-1/3" />
                    <div className="skeleton h-56 rounded-xl" />
                  </div>
                )}

                {subjectState === 'error' && (
                  <Banner tone="critical">
                    <s-text>{subjectError}</s-text>
                    <Button slot="secondary-actions" variant="secondary" onClick={() => { const id = selectedId; setSelectedId(null); setTimeout(() => setSelectedId(id), 0); }}>
                      Try again
                    </Button>
                  </Banner>
                )}

                {subjectState === 'ready' && subject && capabilities && (
                  <>
                    <header>
                      <h3 className="text-[16px] font-semibold leading-snug tracking-tight text-surface-950">{subject.title}</h3>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-surface-500">
                        {subject.status && <span className="meta-chip">{STATUS_LABEL[subject.status] ?? subject.status}</span>}
                        <span className="meta-chip">Shopify id <span className="font-mono text-surface-800">{subject.id}</span></span>
                        <span className={`meta-chip ${subject.images.length === 0 ? '!border-warning-200 !bg-warning-50 !text-warning-800' : ''}`}>
                          {subject.images.length === 0 ? 'No images yet' : `${subject.images.length}${subject.moreImages ? '+' : ''} ${subject.images.length === 1 ? 'image' : 'images'} already`}
                        </span>
                      </p>
                      {subject.images.length > 0 && (
                        <div className="mt-2">
                          <Banner tone="info">
                            <s-text>This product already has {subject.images.length === 1 ? 'an image' : 'images'} in Shopify — it may have been added since your last analysis. A new image will be added alongside.</s-text>
                          </Banner>
                        </div>
                      )}
                    </header>

                    <div role="tablist" aria-label="How to add the image" className="grid grid-cols-2 gap-1 rounded-lg bg-surface-100 p-1">
                      {([
                        ['upload', 'Upload from computer', UploadCloud],
                        ['ai', 'Generate with AI', Sparkles],
                      ] as const).map(([id, label, Icon]) => (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={tab === id}
                          disabled={busy && tab !== id}
                          onClick={() => setTab(id)}
                          className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-50 ${
                            tab === id ? 'bg-surface-0 text-surface-950 shadow-sm ring-1 ring-surface-200' : 'text-surface-600 hover:text-surface-900'
                          }`}
                        >
                          <Icon size={14} aria-hidden="true" />
                          {label}
                        </button>
                      ))}
                    </div>

                    <div role="tabpanel">
                      {/* Keyed by product, so choosing another starts a clean tab — no picked file or
                          drawing from one product can be carried over to another. */}
                      {tab === 'upload'
                        ? <UploadTab key={`upload:${subject.id}`} product={subject} limits={capabilities.limits} canWrite={canWrite} onBusyChange={setBusy} onAdded={handleAdded} />
                        : <GenerateTab key={`ai:${subject.id}`} product={subject} ai={capabilities.ai} canWrite={canWrite} onBusyChange={setBusy} onAdded={handleAdded} />}
                    </div>
                  </>
                )}

                {subjectState === 'ready' && subject && !capabilities && !capabilityError && (
                  <div className="skeleton h-40 rounded-xl" aria-busy="true" />
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
