import { Router } from 'express';
import {
  getOnboardingState,
  getSuggestions,
  postComplete,
  postReopen,
  putStep,
} from '../controllers/onboarding.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';
import { saveOnboardingStepSchema } from '../schemas/onboarding.schema.js';

export const onboardingRouter = Router();

onboardingRouter.use(authenticate);

/** State + the live shop context step 1 pre-fills from. Cheap enough for the app shell to poll. */
onboardingRouter.get('/', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getOnboardingState));

/** Catalogue-derived suggestions for steps 2–4. Heavier — fetched only when those steps open. */
onboardingRouter.get('/suggestions', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getSuggestions));

onboardingRouter.put(
  '/step',
  validateRequest({ query: storeIdQuerySchema, body: saveOnboardingStepSchema }),
  asyncHandler(putStep),
);

/**
 * There is no `/skip` and no `/defer`. Every step is required, so a merchant leaves setup by
 * answering it — the step endpoint saves drafts as they go, and `/complete` refuses to finish
 * while an answer is missing.
 */

/** Re-entering setup from the resume card or Settings. */
onboardingRouter.post('/reopen', validateRequest({ query: storeIdQuerySchema }), asyncHandler(postReopen));

onboardingRouter.post('/complete', validateRequest({ query: storeIdQuerySchema }), asyncHandler(postComplete));
