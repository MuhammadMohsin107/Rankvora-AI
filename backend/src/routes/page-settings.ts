import { Router } from 'express';
import { getPageSettings, upsertPageSettings } from '../controllers/pageSettings.controller.js';
import { getAltTextSettings, putAltTextSettings } from '../controllers/altText.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { pageSettingsPathSchema, pageSettingsSlugSchema, upsertPageSettingsSchema } from '../schemas/pageSettings.schema.js';
import { altTextConfigSchema } from '../schemas/altText.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const pageSettingsRouter = Router();

pageSettingsRouter.use(authenticate);

/**
 * Image alt-text template configuration.
 *
 * It lives on this router because it IS page settings — same table, same store scoping — but it
 * gets typed routes rather than the generic `:slug` pair: the generic PUT accepts any JSON object,
 * and a template that generates text for a merchant's storefront needs its shape and its meaning
 * validated before it is stored.
 *
 * Declared before '/:slug' so 'image-alt-text' is never parsed as a settings slug.
 */
pageSettingsRouter.get('/image-alt-text/template', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getAltTextSettings));
pageSettingsRouter.put('/image-alt-text/template', validateRequest({ query: storeIdQuerySchema, body: altTextConfigSchema }), asyncHandler(putAltTextSettings));

/**
 * Two-segment form, for the generic pillars whose slug is `pillar/subPillar`.
 *
 * The client used to send those as ONE segment with the slash percent-encoded
 * (`/page-settings/ai-discovery%2Ffeed`), which Express handles correctly on its own. It does not
 * survive the journey: the edge proxy in front of this API normalises `%2F` back to a real `/`
 * before forwarding, so what actually arrives is `/page-settings/ai-discovery/feed` — two
 * segments, matching no route, and every generic sub-pillar page logged "Failed to load page
 * settings" with a 404 while silently falling back to defaults.
 *
 * Accepting the path in the shape a proxy cannot mangle removes the whole class of problem rather
 * than depending on nobody's nginx ever decoding a path again. The STORED slug is unchanged —
 * still `pillar/subPillar` — so existing rows keep working.
 *
 * Declared before '/:slug' would be harmless (Express prefers the more specific segment count),
 * but it is placed first to keep the reading order specific-to-general.
 */
pageSettingsRouter.get(
  '/:pillar/:subPillar',
  validateRequest({ params: pageSettingsPathSchema, query: storeIdQuerySchema }),
  asyncHandler(getPageSettings),
);
pageSettingsRouter.put(
  '/:pillar/:subPillar',
  validateRequest({ params: pageSettingsPathSchema, query: storeIdQuerySchema, body: upsertPageSettingsSchema }),
  asyncHandler(upsertPageSettings),
);

// Single-segment form, for the SEO sub-pillars whose slug has no pillar prefix ('title-tags').
pageSettingsRouter.get('/:slug', validateRequest({ params: pageSettingsSlugSchema, query: storeIdQuerySchema }), asyncHandler(getPageSettings));
pageSettingsRouter.put('/:slug', validateRequest({ params: pageSettingsSlugSchema, query: storeIdQuerySchema, body: upsertPageSettingsSchema }), asyncHandler(upsertPageSettings));
