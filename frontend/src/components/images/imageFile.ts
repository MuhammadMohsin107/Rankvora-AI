import type { ImageLimits } from '../../data/productImages.repository';

/**
 * Checks a chosen file in the browser before anything is sent, with Shopify's limits (the server
 * checks the same ones again on the bytes — this only saves a round trip and says why straight
 * away). The preview is the file's own pixels, shown from the browser's copy of it.
 */

export interface PickedImage {
  file: File;
  /** An object URL for the preview. The owner revokes it with `URL.revokeObjectURL`. */
  previewUrl: string;
  width: number;
  height: number;
}

export type PickResult = { ok: true; picked: PickedImage } | { ok: false; message: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPE_LABEL: Record<string, string> = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

/** "JPEG, PNG, WebP or GIF" from the server's own list of accepted types. */
export function acceptedTypesLabel(limits: ImageLimits): string {
  const names = limits.types.map((type) => TYPE_LABEL[type] ?? type);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join('');
}

function readDimensions(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export async function inspectImage(file: File, limits: ImageLimits): Promise<PickResult> {
  const lowerName = file.name.toLowerCase();
  if (file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/.test(lowerName)) {
    return { ok: false, message: 'HEIC photos cannot be previewed here. Save the photo as a JPEG first, then choose it again.' };
  }
  if (!limits.types.includes(file.type)) {
    return { ok: false, message: `“${file.name}” is not a supported image. Choose a ${acceptedTypesLabel(limits)} file.` };
  }
  if (file.size === 0) return { ok: false, message: `“${file.name}” is empty.` };
  if (file.size > limits.maxBytes) {
    return { ok: false, message: `“${file.name}” is ${formatBytes(file.size)}. Shopify accepts product images up to ${formatBytes(limits.maxBytes)}.` };
  }

  const previewUrl = URL.createObjectURL(file);
  const size = await readDimensions(previewUrl);
  if (!size || size.width < 1 || size.height < 1) {
    URL.revokeObjectURL(previewUrl);
    return { ok: false, message: `“${file.name}” could not be read as an image. It may be damaged — try saving it again.` };
  }
  const { width, height } = size;
  if (width > limits.maxSide || height > limits.maxSide || width * height > limits.maxPixels) {
    URL.revokeObjectURL(previewUrl);
    return { ok: false, message: `“${file.name}” is ${width} × ${height} px. Shopify accepts up to ${limits.maxSide} × ${limits.maxSide} px (20 megapixels).` };
  }
  if (width / height > 100 || height / width > 100) {
    URL.revokeObjectURL(previewUrl);
    return { ok: false, message: `“${file.name}” is ${width} × ${height} px — too narrow. Shopify needs an aspect ratio between 100:1 and 1:100.` };
  }
  return { ok: true, picked: { file, previewUrl, width, height } };
}
