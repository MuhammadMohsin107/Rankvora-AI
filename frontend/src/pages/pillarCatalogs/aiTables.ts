import type { GenericSubPillarDetails } from './genericTypes';

/**
 * ─── AI Discovery · evidence table config ────────────────────────────
 *
 * COLUMN DEFINITIONS ONLY. `fetchSubPillarAnalysis` replaces `evidence.rows` with the rows the
 * audit actually produced, so `rows: []` here is correct and load-bearing.
 *
 * Every entry previously carried three illustrative rows — "1,086 AI-readable pages", "318
 * products without useful Q&A" — figures for a store that does not exist. They never reached the
 * screen, and that is precisely why they were dangerous: nothing about reading this file told you
 * they were fictional. A store with no audit now gets the page's empty state instead.
 */

const good = 'bg-success-100 text-success-700';
const warn = 'bg-warning-100 text-warning-700';
const bad = 'bg-critical-100 text-critical-700';

const details = (
  title: string,
  subtitle: string,
  searchPlaceholder: string,
  signalHeader: string,
): GenericSubPillarDetails => ({
  table: {
    title,
    subtitle,
    searchPlaceholder,
    filters: ['All', 'Critical', 'Needs Work', 'Healthy'],
    statusClass: { Critical: bad, 'Needs Work': warn, Healthy: good },
    columns: [
      { key: 'signal', header: signalHeader },
      { key: 'detail', header: 'Detail', variant: 'muted' },
      { key: 'coverage', header: 'Coverage', align: 'center', variant: 'number' },
      { key: 'status', header: 'Status', align: 'center', variant: 'status' },
      { key: 'recommendation', header: 'Recommendation', variant: 'muted' },
    ],
    rows: [],
  },
  /**
   * EMPTY, like every other pillar's.
   *
   * Each entry used to carry an opportunity card rated `impact: 'High'` and `effort: 'Low'` —
   * two judgements nobody measured, written the same for all seven sub-pillars whatever the audit
   * found. Nothing renders this: NonSeoSubPillarPage shows the audit's own findings, which carry
   * the real severity, impact and effort the check recorded. So the ratings were invented AND
   * invisible, which is the combination this file's own header warns about — a plausible value
   * one render away from the screen is the thing most likely to be mistaken for a measurement
   * later. The field stays because the shared type requires it.
   */
  opportunities: [],
});

export const aiTables: Record<string, GenericSubPillarDetails> = {
  'ai-discovery/agents-md': details(
    'Agent-readable Files',
    'What your storefront root returns when an assistant asks for agents.md and llms.txt.',
    'Search by file…',
    'File',
  ),
  'ai-discovery/agentic-attrs': details(
    'Agentic Commerce Signals',
    'Whether an agent that found your product can actually act on it — stock, selectable variants, and a rendered offer it can read.',
    'Search by product…',
    'Product',
  ),
  'ai-discovery/answerable-qa': details(
    'Answerable Content',
    'Whether your descriptions answer pre-purchase questions, and whether any page renders FAQ structured data.',
    'Search by product…',
    'Product',
  ),
  'ai-discovery/feed': details(
    'Catalog Feed Readiness',
    'Identifiers, price and availability, read from real variant data.',
    'Search by product…',
    'Product',
  ),
  'ai-discovery/indexing-freshness': details(
    'Crawler Access & Freshness',
    'Which named crawlers robots.txt admits, what your server answers them, and how fresh your sitemap claims to be.',
    'Search by crawler or signal…',
    'Signal',
  ),
  'ai-discovery/indexnow': details(
    'IndexNow Verification',
    'Live checks of the key file and sitemap that decide whether an IndexNow submission authenticates.',
    'Search by signal…',
    'Signal',
  ),
  'ai-discovery/prompt-tracking': details(
    'Assistant Mention Rates',
    'How often each tracked question produced an answer naming this store. Rates across real answers, never rankings.',
    'Search by question…',
    'Question',
  ),
};
