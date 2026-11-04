import { env } from '../../config/env.js';
import { geminiImageProvider } from './gemini.image.js';
import { openAiImageProvider } from './openai.image.js';
import type { ImageGenerationResult, ImageProvider } from './image-types.js';

export type { ImageFailureCode, ImageGenerationResult, ImageProvider } from './image-types.js';

/**
 * ─── AI product images: the contract ─────────────────────────────────
 *
 * Draws ONE product photo from a product's own title and description, for the Missing images panel.
 * The same seam as the text providers (provider.ts): services ask HERE, a vendor is one file beside
 * this one, and a provider never throws for an expected failure — every outcome is a value.
 *
 * WHAT THE MODEL IS GIVEN. The product's title, its description reduced to plain text, its type,
 * vendor and tags — exactly what Shopify holds, read live — and, when the merchant typed one, their
 * own direction ("on a wooden table"). Nothing is invented to fill a gap: a product with no
 * description is drawn from its title, and the panel says so.
 *
 * WHAT COMES BACK IS A DRAWING, NOT A PHOTO OF THE MERCHANT'S PRODUCT. The model pictures what the
 * words describe. The panel says that in so many words beside every preview, and nothing is ever
 * attached to a product without the merchant choosing that image and pressing Apply.
 *
 * WHY THE FAILURES ARE SPELLED OUT. A key that writes text is often not one that can draw: Google's
 * image models have no free tier, and OpenAI requires organization verification for its image
 * models. Each refusal is classified so the panel can say what to change — most often, the key.
 */

const PROVIDERS: Record<string, ImageProvider> = {
  openai: openAiImageProvider,
  gemini: geminiImageProvider,
};

/** The configured image provider, or null when AI_IMAGE_PROVIDER names one Rankvora AI does not have. */
export function imageProvider(): ImageProvider | null {
  return PROVIDERS[env.aiImageProvider] ?? null;
}

export function imageModelName(): string | null {
  const provider = imageProvider();
  return provider ? env.aiImageModel ?? provider.defaultModel : null;
}

export interface ImageGenerationStatus {
  configured: boolean;
  provider: string;
  model: string | null;
  /** Why it is not configured, in words an operator can act on. Null when it is. */
  reason: string | null;
}

/** Whether a draw would even be attempted, and with what. Names and on/off only — never a key. */
export function imageGenerationStatus(): ImageGenerationStatus {
  const provider = imageProvider();
  const model = imageModelName();
  if (!provider) {
    return {
      configured: false,
      provider: env.aiImageProvider,
      model: null,
      reason: `AI_IMAGE_PROVIDER is "${env.aiImageProvider}", which Rankvora AI does not support. Use "openai" or "gemini".`,
    };
  }
  if (!env.aiRecommendationsEnabled || !env.aiImageEnabled) {
    return { configured: false, provider: provider.name, model, reason: 'AI is switched off on this server (AI_RECOMMENDATIONS_ENABLED or AI_IMAGE_ENABLED is false).' };
  }
  if (!provider.key()) {
    return { configured: false, provider: provider.name, model, reason: `No ${provider.name === 'openai' ? 'OpenAI' : 'Gemini'} key is set (${provider.keyVariable}).` };
  }
  return { configured: true, provider: provider.name, model, reason: null };
}

export interface ProductImageBrief {
  title: string;
  /** The product description as plain text. Empty when the product has none. */
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  /** The merchant's own direction for this drawing, if they gave one. */
  direction: string;
}

/** Room for the description in the prompt. Enough for the facts that shape a picture. */
const DESCRIPTION_LIMIT = 1200;
const MAX_TAGS = 10;

/**
 * The prompt, built only from what the product says about itself.
 *
 * The style lines are the one fixed part, and they are instructions about the PHOTOGRAPH (plain
 * background, even light, no text), never claims about the product. Text and logos are excluded
 * because a model asked to draw a brand's label invents one, and a made-up label on a storefront is
 * a claim the merchant never made.
 */
export function buildProductImagePrompt(brief: ProductImageBrief): string {
  const lines = [
    'Create a realistic, professional e-commerce product photograph of the product described below.',
    '',
    `Product: ${brief.title}`,
  ];
  const description = brief.description.replace(/\s+/g, ' ').trim();
  if (description) lines.push(`Description: ${description.length > DESCRIPTION_LIMIT ? `${description.slice(0, DESCRIPTION_LIMIT).trimEnd()}…` : description}`);
  if (brief.productType.trim()) lines.push(`Product type: ${brief.productType.trim()}`);
  if (brief.vendor.trim()) lines.push(`Brand: ${brief.vendor.trim()}`);
  const tags = brief.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, MAX_TAGS);
  if (tags.length > 0) lines.push(`Tags: ${tags.join(', ')}`);
  if (brief.direction.trim()) lines.push('', `Merchant's direction for this photo: ${brief.direction.trim()}`);
  lines.push(
    '',
    'Photograph requirements:',
    '- Show the whole product, centred and in sharp focus, matching the colours, materials and details in the description.',
    '- Clean, plain, light studio background with soft, even lighting and a subtle natural shadow.',
    '- Square composition suitable for an online store product gallery.',
    '- No text, no words, no logos, no watermarks, no price tags, no borders.',
    '- Do not add accessories or extra products that the description does not mention.',
  );
  return lines.join('\n');
}

/**
 * Draws one image for the product. Never throws.
 *
 * No automatic retry: a drawing costs money and tens of seconds, and the merchant has a
 * Regenerate button. A second attempt they did not ask for would double both.
 */
export async function generateProductImage(brief: ProductImageBrief): Promise<ImageGenerationResult> {
  const status = imageGenerationStatus();
  const provider = imageProvider();
  if (!status.configured || !provider) {
    return { ok: false, code: 'not_configured', detail: status.reason ?? 'not configured', provider: status.provider, model: status.model ?? '' };
  }
  const model = status.model ?? provider.defaultModel;
  const apiKey = provider.key() ?? '';
  return provider.draw(buildProductImagePrompt(brief), model, apiKey, Math.max(5_000, env.aiImageTimeoutMs));
}
