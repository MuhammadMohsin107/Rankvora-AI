import { env } from '../../config/env.js';
import { scrubDetail, type ImageFailureCode, type ImageGenerationResult, type ImageProvider } from './image-types.js';

/**
 * ─── OpenAI image provider ───────────────────────────────────────────
 * `POST /v1/images/generations` with a GPT image model. Hand-rolled over fetch like the text
 * provider (openai.provider.ts): no SDK, the key only in the Authorization header, never logged,
 * never returned.
 *
 * GPT image models always answer in base64 (`data[0].b64_json`); the format asked for is JPEG,
 * which Shopify stores as is and which keeps the preview the browser receives small.
 *
 * The default model is the one OpenAI's image-generation guide lists as its fast generation model
 * (gpt-image-2.5-flare, checked 2026-10-02). AI_IMAGE_MODEL overrides it — older ids such as
 * gpt-image-1.5 take the same request.
 *
 * Unlike the text provider, OpenAI's own error message is kept (scrubbed and capped): "your
 * organization must be verified", "billing hard limit reached" and "model not found" all arrive as
 * 4xx statuses, and the message is the only thing that says which one to fix.
 */

const ENDPOINT = 'https://api.openai.com/v1/images/generations';

function classify(status: number, code: string, message: string): ImageFailureCode {
  if (status === 401) return 'key_rejected';
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' || /quota|billing/i.test(message)) return 'quota';
  if (status === 429) return 'rate_limited';
  if (code === 'moderation_blocked' || code === 'content_policy_violation' || /safety system|moderation|content policy/i.test(message)) return 'refused';
  // 403 is how OpenAI answers an organization that has not been verified for image models.
  if (
    status === 403
    || status === 404
    || code === 'model_not_found'
    || (/model/i.test(message) && /not (found|exist|available)|does not have access|verified/i.test(message))
  ) {
    return 'model_unavailable';
  }
  return 'failed';
}

export const openAiImageProvider: ImageProvider = {
  name: 'openai',
  defaultModel: 'gpt-image-2.5-flare',
  keyVariable: 'OPENAI_API_KEY',
  key: () => env.openaiApiKey,

  async draw(prompt: string, model: string, apiKey: string, timeoutMs: number): Promise<ImageGenerationResult> {
    const base = { provider: 'openai', model };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          size: '1024x1024',
          quality: 'medium',
          output_format: 'jpeg',
        }),
      });

      if (!response.ok) {
        let code = '';
        let message = '';
        try {
          const body = (await response.json()) as { error?: { code?: unknown; type?: unknown; message?: unknown } };
          code = typeof body.error?.code === 'string' ? body.error.code : typeof body.error?.type === 'string' ? body.error.type : '';
          message = typeof body.error?.message === 'string' ? body.error.message : '';
        } catch {
          // A non-JSON error body carries nothing an operator could use; the status still does.
        }
        const detail = scrubDetail(`HTTP ${response.status}${message ? ` — ${message}` : ''}`, apiKey);
        return { ok: false, code: classify(response.status, code, message), detail, ...base };
      }

      const payload = (await response.json()) as { data?: Array<{ b64_json?: unknown }>; output_format?: unknown };
      const encoded = payload.data?.[0]?.b64_json;
      if (typeof encoded !== 'string' || encoded.length === 0) {
        return { ok: false, code: 'failed', detail: 'OpenAI answered without an image', ...base };
      }
      const format = typeof payload.output_format === 'string' ? payload.output_format : 'jpeg';
      return { ok: true, bytes: Buffer.from(encoded, 'base64'), mimeType: `image/${format === 'jpg' ? 'jpeg' : format}`, ...base };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        code: aborted ? 'timeout' : 'failed',
        detail: aborted ? `no image within ${Math.round(timeoutMs / 1000)}s` : 'the request to OpenAI failed',
        ...base,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
