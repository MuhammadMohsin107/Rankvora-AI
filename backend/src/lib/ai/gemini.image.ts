import { env } from '../../config/env.js';
import { scrubDetail, type ImageFailureCode, type ImageGenerationResult, type ImageProvider } from './image-types.js';

/**
 * ─── Gemini image provider ───────────────────────────────────────────
 * Native Gemini image generation ("Nano Banana") through `models/{model}:generateContent` with
 * `responseModalities: ["TEXT", "IMAGE"]` — the same endpoint and key header gemini.provider.ts
 * already uses for text. The picture comes back as base64 in a part's `inlineData`.
 *
 * THESE MODELS HAVE NO FREE TIER. Google's pricing page lists every image model as "Free Tier: Not
 * available" (checked 2026-10-02), so a free AI Studio key that writes Rankvora AI's text cannot draw:
 * Google answers 429 RESOURCE_EXHAUSTED with a quota limit of 0. That answer is classified as
 * 'quota', which the panel shows as "update the AI key" — the honest description of the fix.
 *
 * Default model: gemini-3.1-flash-image (stable). gemini-2.5-flash-image is marked deprecated on
 * the same page. AI_IMAGE_MODEL overrides it, e.g. gemini-3.1-flash-lite-image for lower cost.
 *
 * Every image Google generates carries its SynthID watermark; nothing here adds or removes one.
 */

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Finish reasons that mean the model declined to draw rather than failed to. */
const REFUSALS = new Set([
  'SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_RECITATION',
]);

function classify(status: number, googleStatus: string, message: string): ImageFailureCode {
  // Google answers a rejected key with 400 API_KEY_INVALID, not 401 (see gemini.provider.ts).
  if (status === 401 || (status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(message))) return 'key_rejected';
  if (status === 403 || googleStatus === 'PERMISSION_DENIED') return 'key_rejected';
  if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    // A quota of zero is the free tier meeting a paid-only model; that is the key, not the moment.
    // Google's wording for that: "Quota exceeded for metric: ...free_tier_requests, limit: 0".
    return /limit:\s*0\b|free[_ ]tier|billing/i.test(message) ? 'quota' : 'rate_limited';
  }
  if (/billing|FAILED_PRECONDITION/i.test(`${googleStatus} ${message}`)) return 'quota';
  if (status === 404 || googleStatus === 'NOT_FOUND' || /model.*(not found|not supported|does not support)/i.test(message)) return 'model_unavailable';
  return 'failed';
}

interface InlineData { mimeType?: unknown; mime_type?: unknown; data?: unknown }
interface GeminiPart { text?: unknown; inlineData?: InlineData; inline_data?: InlineData }

export const geminiImageProvider: ImageProvider = {
  name: 'gemini',
  defaultModel: 'gemini-3.1-flash-image',
  keyVariable: 'AI_API_KEY (or GEMINI_API_KEY)',
  key: () => env.geminiApiKey,

  async draw(prompt: string, model: string, apiKey: string, timeoutMs: number): Promise<ImageGenerationResult> {
    const base = { provider: 'gemini', model };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: '1:1' },
          },
        }),
      });

      if (!response.ok) {
        let googleStatus = '';
        let message = '';
        try {
          const body = (await response.json()) as { error?: { status?: unknown; message?: unknown } };
          googleStatus = typeof body.error?.status === 'string' ? body.error.status : '';
          message = typeof body.error?.message === 'string' ? body.error.message : '';
        } catch {
          // A non-JSON error body carries nothing an operator could use; the status still does.
        }
        const detail = scrubDetail(`HTTP ${response.status}${googleStatus ? ` ${googleStatus}` : ''}${message ? ` — ${message}` : ''}`, apiKey);
        return { ok: false, code: classify(response.status, googleStatus, message), detail, ...base };
      }

      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: unknown }>;
        promptFeedback?: { blockReason?: unknown };
      };

      if (typeof payload.promptFeedback?.blockReason === 'string') {
        return { ok: false, code: 'refused', detail: `blocked: ${payload.promptFeedback.blockReason}`, ...base };
      }

      const candidate = payload.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        const inline = part.inlineData ?? part.inline_data;
        const data = inline?.data;
        if (typeof data === 'string' && data.length > 0) {
          const mime = typeof inline?.mimeType === 'string' ? inline.mimeType : typeof inline?.mime_type === 'string' ? inline.mime_type : 'image/png';
          return { ok: true, bytes: Buffer.from(data, 'base64'), mimeType: mime, ...base };
        }
      }

      const finish = typeof candidate?.finishReason === 'string' ? candidate.finishReason : '';
      if (REFUSALS.has(finish)) return { ok: false, code: 'refused', detail: `finish reason ${finish}`, ...base };
      // The model sometimes answers in words instead of drawing; what it said is the only clue why.
      const said = parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join(' ').trim();
      return {
        ok: false,
        code: 'failed',
        detail: scrubDetail(`no image in the response${finish ? ` (finish reason ${finish})` : ''}${said ? ` — the model said: ${said}` : ''}`, apiKey),
        ...base,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        code: aborted ? 'timeout' : 'failed',
        detail: aborted ? `no image within ${Math.round(timeoutMs / 1000)}s` : 'the request to Gemini failed',
        ...base,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
