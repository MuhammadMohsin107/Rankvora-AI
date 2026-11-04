import type { GenericSubPillarConfig } from './genericTypes';

/**
 * ─── AI Discovery · sub-pillar presentation config ───────────────────
 *
 * TITLES AND DESCRIPTIONS ONLY. Every number a sub-pillar page shows — score, analysed, healthy,
 * issues, and every evidence row — is replaced by `fetchSubPillarAnalysis` with what the audit
 * actually measured, and the page renders a skeleton until that lands.
 *
 * So the numeric fields below are zeros and the lists are empty. This file previously derived them
 * from `data/ai-discovery/ai-discovery.mock.ts`, which held invented figures (1,342 pages
 * analysed, 318 products missing FAQs, a score of 80) for a store that does not exist. They were
 * never displayed — but a plausible number sitting one render away from the screen is the thing
 * most likely to be mistaken for a measurement later, so the mock is gone and these are zeros.
 *
 * A store with no audit yet gets the page's empty state, not a fabricated one.
 */

const liveOnly = (
  key: string,
  title: string,
  description: string,
  analyzedLabel: string,
): GenericSubPillarConfig => ({
  pillar: 'ai-discovery',
  pillarLabel: 'AI Discovery',
  key,
  title,
  description,
  score: 0,
  statusLabel: '',
  analyzedLabel,
  analyzed: 0,
  healthy: 0,
  metrics: [],
  breakdown: [],
  issues: [],
});

export const aiPillarCatalog: Record<string, GenericSubPillarConfig> = {
  'ai-discovery/agents-md': liveOnly(
    'agents-md',
    'agents.md / llms.txt',
    'Publish plain-text instructions at your storefront root so AI assistants read how you want your store described, instead of guessing from your HTML.',
    'Files',
  ),
  'ai-discovery/agentic-attrs': liveOnly(
    'agentic-attrs',
    'Agentic Commerce Attributes',
    'Expose what a shopping agent needs to complete a purchase: something in stock, variants it can tell apart, and a rendered offer carrying price and availability.',
    'Products',
  ),
  'ai-discovery/answerable-qa': liveOnly(
    'answerable-qa',
    'Answerable Q&A + FAQ Schema',
    'Answer the questions shoppers ask before buying — materials, sizing, care, compatibility — in a form an assistant can quote.',
    'Products',
  ),
  'ai-discovery/feed': liveOnly(
    'feed',
    'Catalog / Feed Readiness',
    'Keep product identifiers, price and availability complete so AI shopping agents can match and compare your products against other merchants.',
    'Products',
  ),
  'ai-discovery/indexing-freshness': liveOnly(
    'indexing-freshness',
    'Real-time Indexing Readiness',
    'Check which named AI and search crawlers robots.txt actually admits, what your server answers them, and whether your sitemap publishes freshness dates that match your catalog.',
    'Signals',
  ),
  'ai-discovery/indexnow': liveOnly(
    'indexnow',
    'IndexNow Readiness',
    'Verify that your IndexNow key file is really published and really matches, so instant submissions to Bing, Yandex, Naver, Seznam and Yep authenticate.',
    'Signals',
  ),
  'ai-discovery/prompt-tracking': liveOnly(
    'prompt-tracking',
    'Prompt Tracking',
    'How often AI assistants name this store when asked your own shopper questions. Reported as a rate across real answers, never as a ranking.',
    'Questions',
  ),
};
