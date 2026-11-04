import type { Request, Response } from 'express';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import {
  completeOnboarding,
  getOnboarding,
  getOnboardingSuggestions,
  reopenOnboarding,
  saveOnboardingStep,
} from '../services/onboarding.service.js';

export async function getOnboardingState(req: Request, res: Response) {
  res.json({ data: await getOnboarding(requireUserId(req), optionalStoreId(req)) });
}

export async function getSuggestions(req: Request, res: Response) {
  res.json({ data: await getOnboardingSuggestions(requireUserId(req), optionalStoreId(req)) });
}

export async function putStep(req: Request, res: Response) {
  res.json({ data: await saveOnboardingStep(requireUserId(req), req.body, optionalStoreId(req)) });
}

export async function postReopen(req: Request, res: Response) {
  res.json({ data: await reopenOnboarding(requireUserId(req), optionalStoreId(req)) });
}

export async function postComplete(req: Request, res: Response) {
  res.json({ data: await completeOnboarding(requireUserId(req), optionalStoreId(req)) });
}
