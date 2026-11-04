/**
 * The shapes shared by the image providers and the selection in image-provider.ts. In a file of
 * their own so a vendor file never imports the module that imports it.
 */

export type ImageFailureCode =
  | 'not_configured'
  | 'key_rejected'
  | 'quota'
  | 'rate_limited'
  | 'model_unavailable'
  | 'refused'
  | 'timeout'
  | 'failed';

export type ImageGenerationResult =
  | { ok: true; bytes: Buffer; mimeType: string; provider: string; model: string }
  | { ok: false; code: ImageFailureCode; detail: string; provider: string; model: string };

export interface ImageProvider {
  readonly name: string;
  /** Used when AI_IMAGE_MODEL is not set. */
  readonly defaultModel: string;
  /** The environment variable(s) its key is read from — named in "update the key" messages. */
  readonly keyVariable: string;
  key(): string | undefined;
  /** One attempt, bounded by `timeoutMs`. Never throws. */
  draw(prompt: string, model: string, apiKey: string, timeoutMs: number): Promise<ImageGenerationResult>;
}

/** Upstream wording made safe to show and log: the key scrubbed out, the length capped. */
export function scrubDetail(message: string, apiKey: string): string {
  const scrubbed = apiKey ? message.split(apiKey).join('[redacted]') : message;
  return scrubbed.replace(/\s+/g, ' ').trim().slice(0, 300);
}
