import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ImagePlus, Loader2, RefreshCw, UploadCloud, X } from 'lucide-react';
import { ApiError } from '../../lib/api';
import {
  uploadProductImage,
  type AttachResult,
  type ImageLimits,
  type ProductImageSubject,
} from '../../data/productImages.repository';
import AddedImageResult from './AddedImageResult';
import { acceptedTypesLabel, formatBytes, inspectImage, type PickedImage } from './imageFile';

type Phase =
  | { name: 'choose' }
  | { name: 'sending'; fraction: number }
  | { name: 'added'; result: AttachResult };

/**
 * Upload a photo from the merchant's computer and add it to the chosen product.
 *
 * choose → preview → apply: the file is checked in the browser as soon as it is picked, shown at its
 * real size and pixels, and only sent when the merchant presses the button. The bar shows the bytes
 * actually leaving the browser; once they have arrived the card hands over to the result, which
 * reports Shopify's own processing status.
 */
export default function UploadTab({ product, limits, canWrite, onBusyChange, onAdded }: {
  product: ProductImageSubject;
  limits: ImageLimits;
  /** False when Rankvora AI may not change this store; the button then says so rather than failing. */
  canWrite: boolean;
  onBusyChange: (busy: boolean) => void;
  onAdded: (result: AttachResult) => void;
}) {
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const [alt, setAlt] = useState(product.title);
  const [pickError, setPickError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<{ message: string; code?: string } | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'choose' });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pickedRef = useRef<PickedImage | null>(null);
  pickedRef.current = picked;

  // The preview's object URL is released when the picture is replaced, discarded or the tab closes.
  useEffect(() => () => {
    if (pickedRef.current) URL.revokeObjectURL(pickedRef.current.previewUrl);
    abortRef.current?.abort();
  }, []);

  const discard = useCallback(() => {
    setPicked((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
    setPickError(null);
    setSendError(null);
  }, []);

  const choose = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setSendError(null);
    const result = await inspectImage(file, limits);
    if (!result.ok) { setPickError(result.message); return; }
    setPickError(null);
    setPicked((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return result.picked;
    });
  }, [limits]);

  const send = async () => {
    if (!picked) return;
    setSendError(null);
    setPhase({ name: 'sending', fraction: 0 });
    onBusyChange(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await uploadProductImage(product.id, picked.file, {
        alt,
        signal: controller.signal,
        onProgress: (fraction) => setPhase({ name: 'sending', fraction }),
      });
      setPhase({ name: 'added', result });
      onAdded(result);
    } catch (error) {
      setPhase({ name: 'choose' });
      if (error instanceof ApiError && error.code === 'ABORTED') return;
      setSendError({
        message: error instanceof ApiError ? error.message : 'The image could not be added. Please try again.',
        code: error instanceof ApiError ? error.code : undefined,
      });
    } finally {
      abortRef.current = null;
      onBusyChange(false);
    }
  };

  if (phase.name === 'added') {
    return (
      <AddedImageResult
        result={phase.result}
        productTitle={product.title}
        source="upload"
        onAddAnother={() => { setPhase({ name: 'choose' }); discard(); setAlt(product.title); }}
      />
    );
  }

  const sending = phase.name === 'sending';
  // Everything on the wire has arrived at 100%, but Shopify is still being told about it.
  const fraction = phase.name === 'sending' ? phase.fraction : 0;
  const waitingOnShopify = sending && fraction >= 1;

  return (
    <div className="space-y-3">
      {!picked ? (
        <div
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void choose(event.dataTransfer.files?.[0]); }}
          className={`flex flex-col items-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
            dragging ? 'border-brand-400 bg-brand-50' : 'border-surface-300 bg-surface-50/60 hover:border-brand-300'
          }`}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100">
            <UploadCloud size={20} aria-hidden="true" />
          </span>
          <p className="mt-2.5 text-[13px] font-semibold text-surface-900">Drop a product photo here</p>
          <p className="mt-0.5 text-[11.5px] text-surface-500">
            {acceptedTypesLabel(limits)} · up to {formatBytes(limits.maxBytes)} · up to {limits.maxSide} × {limits.maxSide} px
          </p>
          <button type="button" onClick={() => inputRef.current?.click()} className="btn-secondary mt-3">
            <ImagePlus size={15} aria-hidden="true" />
            Choose from your computer
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={limits.types.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a product image from your computer"
            onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }}
          />
        </div>
      ) : (
        <figure className="overflow-hidden rounded-xl border border-surface-200 bg-surface-50">
          <div className="relative flex items-center justify-center bg-[repeating-conic-gradient(var(--c-surface-100)_0%_25%,transparent_0%_50%)] [background-size:16px_16px]">
            <img src={picked.previewUrl} alt={`Preview of ${picked.file.name}`} className="max-h-72 w-auto object-contain" />
            {!sending && (
              <button
                type="button"
                onClick={discard}
                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-surface-0/90 text-surface-600 shadow ring-1 ring-surface-200 hover:text-surface-900"
                aria-label="Remove this photo"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t border-surface-200 bg-surface-0 px-3 py-1.5 text-[11px] text-surface-500">
            <span className="min-w-0 truncate font-medium text-surface-700">{picked.file.name}</span>
            <span className="tabular-nums">{picked.width} × {picked.height} px · {formatBytes(picked.file.size)}</span>
          </figcaption>
        </figure>
      )}

      {pickError && (
        <p className="flex items-start gap-1.5 rounded-md bg-critical-50 px-2.5 py-2 text-[12px] text-critical-700 ring-1 ring-inset ring-critical-100" role="alert">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {pickError}
        </p>
      )}

      {picked && (
        <div>
          <label htmlFor="upload-alt" className="text-[12px] font-medium text-surface-700">Alt text</label>
          <input
            id="upload-alt"
            value={alt}
            onChange={(event) => setAlt(event.target.value)}
            maxLength={512}
            disabled={sending}
            className="mt-1 w-full rounded-lg border border-surface-200 bg-surface-0 px-3 py-2 text-[12.5px] text-surface-900 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-surface-50"
          />
          <p className="mt-1 text-[11px] text-surface-500">Describes the photo for shoppers who cannot see it, and for search engines. It starts as the product’s name — say what the photo shows.</p>
        </div>
      )}

      {sending && (
        <div aria-live="polite">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-label="Upload progress">
            <div className="h-full rounded-full bg-brand-600 transition-[width] duration-150" style={{ width: `${Math.max(3, Math.round(fraction * 100))}%` }} />
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-surface-600">
            <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {waitingOnShopify ? 'Sent. Adding it to the product in Shopify…' : `Uploading… ${Math.round(fraction * 100)}%`}
          </p>
        </div>
      )}

      {sendError && (
        <div className="rounded-md bg-critical-50 px-2.5 py-2 text-[12px] text-critical-700 ring-1 ring-inset ring-critical-100" role="alert">
          <p className="flex items-start gap-1.5">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            {sendError.message}
          </p>
          {picked && (
            <button type="button" onClick={() => void send()} className="btn-secondary btn-xs mt-2">
              <RefreshCw size={12} aria-hidden="true" />
              Try again
            </button>
          )}
        </div>
      )}

      {picked && (
        <button type="button" onClick={() => void send()} disabled={sending || !canWrite || alt.trim() === ''} className="btn-primary w-full">
          {sending ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <UploadCloud size={15} aria-hidden="true" />}
          {sending ? 'Adding to your store…' : 'Add this image to the product in Shopify'}
        </button>
      )}
      {picked && !canWrite && (
        <p className="text-[11.5px] text-surface-500">Adding images is switched off for this store — see the notice above.</p>
      )}
    </div>
  );
}
