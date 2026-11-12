import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { fetchMediaStatus, type AttachResult, type MediaOutcome } from '../../data/productImages.repository';
import Button from '../../components/polaris/Button';

/** How long to keep asking Shopify whether an image has finished processing. */
const SETTLE_MS = 90_000;
const POLL_MS = 2_000;

/**
 * What happened to an image that was added, in Shopify's own words.
 *
 * "Added" is never claimed on Rankvora AI's say-so: the image is shown from the CDN URL Shopify returned
 * once its status is READY. While Shopify is still processing it the card says so and keeps asking;
 * a FAILED status is shown with Shopify's reasons.
 */
export default function AddedImageResult({ result, productTitle, onAddAnother, onSettled }: {
  result: AttachResult;
  productTitle: string;
  source: 'upload' | 'ai';
  onAddAnother: () => void;
  /** Called once with the final outcome, so the host can refresh what it shows. */
  onSettled?: (outcome: MediaOutcome) => void;
}) {
  const [outcome, setOutcome] = useState<MediaOutcome>(result.media);
  const [imageCount, setImageCount] = useState<number | null>(result.imageCount);
  const [gaveUp, setGaveUp] = useState(false);
  const settledRef = useRef(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    let live = true;
    const startedAt = Date.now();
    const finish = (final: MediaOutcome) => {
      if (settledRef.current) return;
      settledRef.current = true;
      onSettledRef.current?.(final);
    };

    const check = async (current: MediaOutcome) => {
      if (current.status === 'READY' || current.status === 'FAILED') { finish(current); return; }
      // oxlint-disable-next-line no-unmodified-loop-condition -- `live` is cleared by the effect cleanup while the loop awaits
      while (live && Date.now() - startedAt < SETTLE_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!live) return;
        try {
          const next = await fetchMediaStatus(result.productId, current.mediaId);
          if (!live) return;
          setOutcome(next);
          if (next.imageCount !== null) setImageCount(next.imageCount);
          if (next.status === 'READY' || next.status === 'FAILED') { finish(next); return; }
        } catch {
          // A failed check is not a failed image; the next poll asks again.
        }
      }
      if (live) setGaveUp(true);
    };

    void check(result.media);
    return () => { live = false; };
  }, [result.productId, result.media]);

  const ready = outcome.status === 'READY';
  const failed = outcome.status === 'FAILED';

  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className={`flex items-start gap-3 rounded-lg px-3 py-3 ring-1 ring-inset ${
        failed ? 'bg-critical-50 ring-critical-100' : ready ? 'bg-success-50 ring-success-100' : 'bg-info-50 ring-info-100'
      }`}>
        {failed
          ? <AlertCircle size={18} className="mt-0.5 flex-shrink-0 text-critical-600" aria-hidden="true" />
          : ready
            ? <CheckCircle2 size={18} className="mt-0.5 flex-shrink-0 text-success-600" aria-hidden="true" />
            : <Loader2 size={18} className="mt-0.5 flex-shrink-0 animate-spin text-info-600 motion-reduce:animate-none" aria-hidden="true" />}
        <div className="min-w-0 text-[12.5px] leading-[1.5]">
          <p className={`font-semibold ${failed ? 'text-critical-800' : ready ? 'text-success-800' : 'text-info-800'}`}>
            {failed
              ? 'Shopify could not process this image'
              : ready
                ? `Image added to “${productTitle}”`
                : gaveUp
                  ? 'Shopify is still processing the image'
                  : 'Shopify is processing the image…'}
          </p>
          <p className="mt-0.5 text-surface-700">
            {failed
              ? (outcome.errors.length > 0 ? outcome.errors.join(' · ') : 'Try a different image.')
              : ready
                ? (imageCount !== null ? `The product now has ${imageCount} ${imageCount === 1 ? 'image' : 'images'}.` : '')
                : gaveUp
                  ? 'It will appear once Shopify finishes.'
                  : ''}
          </p>
        </div>
      </div>

      {ready && outcome.url && (
        <figure className="overflow-hidden rounded-lg border border-surface-200 bg-surface-50">
          <img src={outcome.url} alt={outcome.alt ?? productTitle} className="mx-auto max-h-72 w-auto object-contain" />
          <figcaption className="border-t border-surface-200 bg-surface-0 px-3 py-1.5 text-[11px] text-surface-500">
            Served by Shopify{outcome.width && outcome.height ? ` · ${outcome.width} × ${outcome.height} px` : ''}
            {outcome.alt ? ` · alt text: “${outcome.alt}”` : ''}
          </figcaption>
        </figure>
      )}

      <Button variant="secondary" onClick={onAddAnother}>
        
        {failed ? 'Try another image' : 'Add another image'}
      </Button>
    </div>
  );
}
