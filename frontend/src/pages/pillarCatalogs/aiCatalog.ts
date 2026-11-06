import type { GenericSubPillarConfig } from './genericTypes';

/**
 * ─── AI Discovery · sub-pillar presentation config ───────────────────
 *
 * TITLES ONLY. Every number a sub-pillar page shows — score, analysed, healthy,
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
  analyzedLabel: string,
): GenericSubPillarConfig => ({
  pillar: 'ai-discovery',
  pillarLabel: 'AI Discovery',
  key,
  title,
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
    'Files',
  ),
  'ai-discovery/agentic-attrs': liveOnly(
    'agentic-attrs',
    'Agentic Commerce Attributes',
    'Products',
  ),
  'ai-discovery/answerable-qa': liveOnly(
    'answerable-qa',
    'Answerable Q&A + FAQ Schema',
    'Products',
  ),
  'ai-discovery/feed': liveOnly(
    'feed',
    'Catalog / Feed Readiness',
    'Products',
  ),
  'ai-discovery/indexing-freshness': liveOnly(
    'indexing-freshness',
    'Real-time Indexing Readiness',
    'Signals',
  ),
  'ai-discovery/indexnow': liveOnly(
    'indexnow',
    'IndexNow Readiness',
    'Signals',
  ),
  'ai-discovery/prompt-tracking': liveOnly(
    'prompt-tracking',
    'Prompt Tracking',
    'Questions',
  ),
};
