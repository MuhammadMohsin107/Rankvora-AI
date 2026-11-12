import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
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
import Button from '../../components/polaris/Button';
import Banner from '../polaris/Banner';
import { TextAreaField, TextField } from '../polaris/fields';

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
      setFailure(asFailure(error, 'The image could not be drawn. Try again.'));
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
      setFailure(asFailure(error, 'The image could not be added. Try again.'));
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
      <Banner tone="warning" heading="AI images are not set up">
        {ai.reason && <s-text>{ai.reason}</s-text>}
      </Banner>
    );
  }

  const descriptionExcerpt = product.description.length > 260 ? `${product.description.slice(0, 260).trimEnd()}…` : product.description;
  const keyProblem = failure?.code ? AI_KEY_ERROR_CODES.has(failure.code) : false;

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-surface-200 bg-surface-50/70 px-3 py-2.5" aria-label="What the picture is based on">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">Drawn from</p>
        <p className="mt-1 text-[13px] font-semibold text-surface-950">{product.title}</p>
        {descriptionExcerpt
          ? <p className="mt-0.5 text-[12px] leading-[1.5] text-surface-600">{descriptionExcerpt}</p>
          : <p className="mt-0.5 text-[12px] italic text-surface-500">No description in Shopify.</p>}
        {(product.productType || product.vendor || product.tags.length > 0) && (
          <p className="mt-1.5 flex flex-wrap gap-1">
            {product.productType && <span className="meta-chip">Type: <span className="font-medium text-surface-800">{product.productType}</span></span>}
            {product.vendor && <span className="meta-chip">Brand: <span className="font-medium text-surface-800">{product.vendor}</span></span>}
            {product.tags.length > 0 && <span className="meta-chip">{product.tags.length} {product.tags.length === 1 ? 'tag' : 'tags'}</span>}
          </p>
        )}
      </section>

      <TextAreaField
        id="ai-direction"
        label="Your direction (optional)"
        rows={2}
        value={direction}
        onChange={(next) => setDirection(next.slice(0, MAX_DIRECTION))}
        disabled={busy}
        placeholder="For example: on a light oak counter, soft morning light"
        details={`${direction.length}/${MAX_DIRECTION}`}
      />

      {generating && (
        <div className="flex aspect-square max-h-72 w-full flex-col items-center justify-center rounded-xl border border-surface-200 bg-surface-50 text-center" role="status" aria-live="polite">
          <Loader2 size={26} className="animate-spin text-brand-600 motion-reduce:animate-none" aria-hidden="true" />
          <p className="mt-2.5 text-[13px] font-semibold text-surface-900">Drawing…</p>
          <p className="mt-0.5 max-w-xs text-[11.5px] text-surface-500">Usually 10–40 seconds.</p>
        </div>
      )}

      {!generating && selected && (
        <div className="space-y-2.5">
          <figure className="overflow-hidden rounded-xl border border-surface-200 bg-surface-50">
            {/* oxlint-disable-next-line jsx-a11y/img-redundant-alt -- "picture" tells a screen reader this is generated artwork, not a product photo */}
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

          <Banner tone="info">
            <s-text>An AI drawing, not a photo of your product. Check it before adding.</s-text>
          </Banner>

          <TextField id="ai-alt" label="Alt text" value={alt} onChange={(next) => setAlt(next.slice(0, 512))} disabled={busy} />
        </div>
      )}

      {failure && (
        <Banner tone={keyProblem ? 'warning' : 'critical'} heading={keyProblem ? 'Update the AI key' : undefined}>
          <s-text>{failure.message}</s-text>
        </Banner>
      )}

      <div className="flex flex-wrap gap-2">
        {selected && (
          <Button loading={applying} variant="primary" onClick={() => void apply()} disabled={busy || !canWrite || alt.trim() === ''} className="flex-1">
            {applying ? 'Adding to your store…' : 'Add to product in Shopify'}
          </Button>
        )}
        <Button variant={selected ? 'secondary' : 'primary'} onClick={() => void generate()} disabled={busy} loading={generating} className={selected ? undefined : 'flex-1'}>
          {generating ? 'Drawing…' : selected ? 'Regenerate' : 'Generate image with AI'}
        </Button>
      </div>
      {selected && !canWrite && <p className="text-[11.5px] text-surface-500">Adding images is switched off for this store.</p>}
    </div>
  );
}
