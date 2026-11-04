import { useState } from 'react';
import { AlertCircle, CheckCircle2, KeyRound, Loader2, RefreshCw, Sparkles, UploadCloud } from 'lucide-react';
import { ApiError } from '../../lib/api';
import {
  AI_KEY_ERROR_CODES,
  applyGeneratedImage,
  generateProductImage,
  type AttachResult,
  type GeneratedImageDraft,
  type ProductImageCapabilities,
  type ProductImageSubject,
} from '../../data/productImages.repository';
import AddedImageResult from './AddedImageResult';
import { formatBytes } from './imageFile';

/** Drawings kept on screen at once. Each is a megabyte or two of the browser's memory. */
const MAX_DRAFTS = 4;
const MAX_DIRECTION = 300;

interface Draft extends GeneratedImageDraft { key: number }

type Failure = { message: string; code?: string };

/**
 * Draw a product photo with AI from the product's own title and description, preview it, draw
 * again, pick one, and add it to the product.
 *
 * What the drawing is based on is shown before anything is spent: the title, and the description,
 * type, vendor and tags as Shopify holds them right now. Nothing reaches the store until the
 * merchant presses Add, and when the AI cannot draw — no key, a key that was rejected, no
 * image quota, a model the key cannot use — the panel says so, and that the AI key is what to
 * update. It never shows a stand-in picture.
 */
export default function GenerateTab({ product, ai, canWrite, onBusyChange, onAdded }: {
  product: ProductImageSubject;
  ai: ProductImageCapabilities['ai'];
  canWrite: boolean;
  onBusyChange: (busy: boolean) => void;
  onAdded: (result: AttachResult) => void;
}) {
  const [direction, setDirection] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [counter, setCounter] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [alt, setAlt] = useState(product.title);
  const [added, setAdded] = useState<AttachResult | null>(null);

  const selected = drafts.find((draft) => draft.key === selectedKey) ?? null;
  const busy = generating || applying;

  const asFailure = (error: unknown, fallback: string): Failure => (
    error instanceof ApiError ? { message: error.message, code: error.code } : { message: fallback }
  );

  const generate = async () => {
    setFailure(null);
    setGenerating(true);
    onBusyChange(true);
    try {
      const draft = await generateProductImage(product.id, direction);
      const key = counter + 1;
      setCounter(key);
      setDrafts((current) => [...current, { ...draft, key }].slice(-MAX_DRAFTS));
      setSelectedKey(key);
    } catch (error) {
      setFailure(asFailure(error, 'The image could not be drawn. Please try again.'));
    } finally {
      setGenerating(false);
      onBusyChange(false);
    }
  };

  const apply = async () => {
    if (!selected) return;
    setFailure(null);
    setApplying(true);
    onBusyChange(true);
    try {
      const result = await applyGeneratedImage(product.id, selected.token, alt);
      setAdded(result);
      onAdded(result);
    } catch (error) {
      setFailure(asFailure(error, 'The image could not be added. Please try again.'));
    } finally {
      setApplying(false);
      onBusyChange(false);
    }
  };

  if (added) {
    return (
      <AddedImageResult
        result={added}
        productTitle={product.title}
        source="ai"
        onAddAnother={() => { setAdded(null); setDrafts([]); setSelectedKey(null); setAlt(product.title); }}
      />
    );
  }

  // The server's own answer to "can it draw at all". Nothing is offered that would only fail.
  if (!ai.configured) {
    return (
      <div className="rounded-xl border border-warning-200 bg-warning-50 px-4 py-4" role="alert">
        <div className="flex items-start gap-2.5">
          <KeyRound size={18} className="mt-0.5 flex-shrink-0 text-warning-700" aria-hidden="true" />
          <div className="min-w-0 text-[12.5px] leading-[1.5] text-warning-900">
            <p className="font-semibold">AI image generation needs an updated AI key</p>
            <p className="mt-0.5">
              No AI key that can generate images is set up on this server yet, so no picture can be drawn. Uploading a photo from your computer still works.
            </p>
            {ai.reason && <p className="mt-1.5 text-[11.5px] text-warning-800">{ai.reason}</p>}
          </div>
        </div>
      </div>
    );
  }

  const descriptionExcerpt = product.description.length > 260 ? `${product.description.slice(0, 260).trimEnd()}…` : product.description;
  const keyProblem = failure?.code ? AI_KEY_ERROR_CODES.has(failure.code) : false;

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-surface-200 bg-surface-50/70 px-3 py-2.5" aria-label="What the picture is based on">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">The picture is drawn from</p>
        <p className="mt-1 text-[13px] font-semibold text-surface-950">{product.title}</p>
        {descriptionExcerpt
          ? <p className="mt-0.5 text-[12px] leading-[1.5] text-surface-600">{descriptionExcerpt}</p>
          : <p className="mt-0.5 text-[12px] italic text-surface-500">This product has no description in Shopify, so the picture is drawn from its title alone.</p>}
        {(product.productType || product.vendor || product.tags.length > 0) && (
          <p className="mt-1.5 flex flex-wrap gap-1">
            {product.productType && <span className="meta-chip">Type: <span className="font-medium text-surface-800">{product.productType}</span></span>}
            {product.vendor && <span className="meta-chip">Brand: <span className="font-medium text-surface-800">{product.vendor}</span></span>}
            {product.tags.length > 0 && <span className="meta-chip">{product.tags.length} {product.tags.length === 1 ? 'tag' : 'tags'}</span>}
          </p>
        )}
      </section>

      <div>
        <label htmlFor="ai-direction" className="text-[12px] font-medium text-surface-700">
          Your direction <span className="font-normal text-surface-400">(optional)</span>
        </label>
        <textarea
          id="ai-direction"
          value={direction}
          onChange={(event) => setDirection(event.target.value)}
          maxLength={MAX_DIRECTION}
          rows={2}
          disabled={busy}
          placeholder="For example: on a light oak counter, soft morning light"
          className="mt-1 w-full resize-none rounded-lg border border-surface-200 bg-surface-0 px-3 py-2 text-[12.5px] text-surface-900 placeholder:text-surface-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-surface-50"
        />
        <p className="mt-0.5 text-right text-[10.5px] tabular-nums text-surface-400">{direction.length}/{MAX_DIRECTION}</p>
      </div>

      {generating && (
        <div className="flex aspect-square max-h-72 w-full flex-col items-center justify-center rounded-xl border border-surface-200 bg-surface-50 text-center" role="status" aria-live="polite">
          <Loader2 size={26} className="animate-spin text-brand-600 motion-reduce:animate-none" aria-hidden="true" />
          <p className="mt-2.5 text-[13px] font-semibold text-surface-900">Drawing from the title and description…</p>
          <p className="mt-0.5 max-w-xs text-[11.5px] text-surface-500">This usually takes 10–40 seconds. You can keep this panel open.</p>
        </div>
      )}

      {!generating && selected && (
        <div className="space-y-2.5">
          <figure className="overflow-hidden rounded-xl border border-surface-200 bg-surface-50">
            <img src={selected.image.dataUrl} alt={`AI-drawn picture for ${product.title}`} className="mx-auto max-h-80 w-auto object-contain" />
            <figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t border-surface-200 bg-surface-0 px-3 py-1.5 text-[11px] text-surface-500">
              <span>Drawn by {selected.provider} · {selected.model}</span>
              <span className="tabular-nums">{selected.image.width} × {selected.image.height} px · {formatBytes(selected.image.bytes)}</span>
            </figcaption>
          </figure>

          {drafts.length > 1 && (
            <ul className="flex flex-wrap gap-2" aria-label="Pictures drawn so far">
              {drafts.map((draft, index) => (
                <li key={draft.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(draft.key)}
                    disabled={busy}
                    aria-pressed={draft.key === selectedKey}
                    aria-label={`Picture ${index + 1} of ${drafts.length}`}
                    className={`relative h-16 w-16 overflow-hidden rounded-lg border-2 transition-colors ${draft.key === selectedKey ? 'border-brand-500' : 'border-surface-200 hover:border-surface-300'}`}
                  >
                    <img src={draft.image.dataUrl} alt="" className="h-full w-full object-cover" />
                    {draft.key === selectedKey && (
                      <span className="absolute right-0.5 top-0.5 rounded-full bg-surface-0 text-brand-600"><CheckCircle2 size={14} aria-hidden="true" /></span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="rounded-md bg-info-50 px-2.5 py-1.5 text-[11.5px] leading-[1.5] text-info-800 ring-1 ring-inset ring-info-100">
            This is an AI drawing of what the words describe, not a photo of your product. Check that it matches what you sell before adding it to the store.
          </p>

          <div>
            <label htmlFor="ai-alt" className="text-[12px] font-medium text-surface-700">Alt text</label>
            <input
              id="ai-alt"
              value={alt}
              onChange={(event) => setAlt(event.target.value)}
              maxLength={512}
              disabled={busy}
              className="mt-1 w-full rounded-lg border border-surface-200 bg-surface-0 px-3 py-2 text-[12.5px] text-surface-900 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-surface-50"
            />
          </div>
        </div>
      )}

      {failure && (
        <div
          className={`rounded-md px-2.5 py-2 text-[12px] ring-1 ring-inset ${keyProblem ? 'bg-warning-50 text-warning-900 ring-warning-200' : 'bg-critical-50 text-critical-700 ring-critical-100'}`}
          role="alert"
        >
          <p className="flex items-start gap-1.5">
            {keyProblem
              ? <KeyRound size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              : <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />}
            <span>
              {keyProblem && <strong className="font-semibold">Update the AI key. </strong>}
              {failure.message}
            </span>
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {selected && (
          <button type="button" onClick={() => void apply()} disabled={busy || !canWrite || alt.trim() === ''} className="btn-primary flex-1">
            {applying ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <UploadCloud size={15} aria-hidden="true" />}
            {applying ? 'Adding to your store…' : 'Add this image to the product in Shopify'}
          </button>
        )}
        <button type="button" onClick={() => void generate()} disabled={busy} className={selected ? 'btn-secondary' : 'btn-primary flex-1'}>
          {generating
            ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : selected ? <RefreshCw size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
          {generating ? 'Drawing…' : selected ? 'Regenerate' : 'Generate image with AI'}
        </button>
      </div>
      {selected && !canWrite && <p className="text-[11.5px] text-surface-500">Adding images is switched off for this store — see the notice above.</p>}
      {drafts.length > 0 && drafts.length >= MAX_DRAFTS && (
        <p className="text-[11px] text-surface-400">The panel keeps the last {MAX_DRAFTS} pictures; drawing another replaces the oldest.</p>
      )}
    </div>
  );
}
