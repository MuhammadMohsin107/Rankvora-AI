/**
 * ─── The AI assistants that send real traffic, by exact source ───────
 *
 * The companion to ai-crawlers.ts. That file names the bots that COME AND READ the store; this one
 * names the hosts that APPEAR IN GA4 when a shopper, having read an assistant's answer, clicks
 * through and arrives. They are different lists and they answer different questions — a store can
 * be crawled diligently by GPTBot and never once be cited in an answer somebody acted on.
 *
 * WHY AN EXACT LIST AND NOT A PATTERN
 * The same reason as the crawler file, with an extra hazard: substring matching on "ai" would
 * capture `aliexpress.com`, `mail.google.com` and every `.ai` domain in existence, and a store
 * would be shown invented AI traffic that is really its own newsletter. GA4 reports a host, so the
 * match is against a host, exactly.
 *
 * WHAT GA4 ACTUALLY PUTS IN `sessionSource`
 * Usually the bare hostname of the referrer — `chatgpt.com`, `perplexity.ai`. But GA4 also applies
 * its own source categorisation, and some properties see a token with the TLD stripped (`chatgpt`)
 * or with a subdomain retained (`www.perplexity.ai`). All three forms are matched, because a store
 * whose property reports one form and not another would otherwise read as having no AI traffic at
 * all — a zero that looks like a measurement.
 *
 * WHAT THIS CANNOT SEE, AND WHY THAT IS STATED RATHER THAN PAPERED OVER
 * An assistant that answers from the store's content WITHOUT linking sends no referral at all, and
 * one whose app opens links in an in-app browser may arrive as `(direct)`. So these numbers are a
 * FLOOR on AI-driven traffic, never a total, and every surface that shows them says so.
 */

export type AiReferrerKind = 'assistant' | 'ai-search';

export interface AiReferrer {
  /** Stable key used in API responses and as a React key. */
  id: string;
  /** How the merchant knows it. */
  label: string;
  vendor: string;
  kind: AiReferrerKind;
  /**
   * Exact `sessionSource` values to match, lower-cased. Includes the bare-token and `www.` forms
   * because GA4's categorisation is not consistent across properties — see the header.
   */
  sources: string[];
}

export const AI_REFERRERS: AiReferrer[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    vendor: 'OpenAI',
    kind: 'assistant',
    // chat.openai.com was the original host and still appears in historical ranges. NOT the bare
    // openai.com: that is OpenAI's company site — docs, blog, careers — and a visit from it is not
    // a shopper who read a ChatGPT answer. Counting it inflated the one outcome figure this has.
    sources: ['chatgpt.com', 'www.chatgpt.com', 'chatgpt', 'chat.openai.com'],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    vendor: 'Perplexity AI',
    kind: 'ai-search',
    sources: ['perplexity.ai', 'www.perplexity.ai', 'perplexity'],
  },
  {
    id: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    kind: 'assistant',
    sources: ['claude.ai', 'www.claude.ai', 'claude'],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    vendor: 'Google',
    kind: 'assistant',
    // bard.google.com is the pre-rename host; ranges that span the change still carry it.
    sources: ['gemini.google.com', 'gemini', 'bard.google.com', 'bard'],
  },
  {
    id: 'copilot',
    label: 'Microsoft Copilot',
    vendor: 'Microsoft',
    kind: 'assistant',
    // Hosts only. `bing.com/chat` used to be listed, but GA4's sessionSource is a host and never
    // carries a path, so the entry could not match anything — it only looked like coverage.
    sources: ['copilot.microsoft.com', 'copilot'],
  },
  {
    id: 'you',
    label: 'You.com',
    vendor: 'You.com',
    kind: 'ai-search',
    sources: ['you.com', 'www.you.com'],
  },
  {
    id: 'poe',
    label: 'Poe',
    vendor: 'Quora',
    kind: 'assistant',
    sources: ['poe.com', 'www.poe.com'],
  },
  {
    id: 'phind',
    label: 'Phind',
    vendor: 'Phind',
    kind: 'ai-search',
    sources: ['phind.com', 'www.phind.com'],
  },
  {
    id: 'mistral',
    label: 'Le Chat',
    vendor: 'Mistral AI',
    kind: 'assistant',
    // The assistant's host only; mistral.ai is the company site, not the chat.
    sources: ['chat.mistral.ai'],
  },
  {
    id: 'grok',
    label: 'Grok',
    vendor: 'xAI',
    kind: 'assistant',
    // The assistant's host only; x.ai is the company site, not the chat.
    sources: ['grok.com', 'www.grok.com'],
  },
];

/**
 * Every source string that counts as AI traffic, pre-indexed to its referrer.
 *
 * Built once at module load rather than scanned per row: a 28-day report can return a hundred
 * source rows, and this turns the classification into a map lookup.
 */
const SOURCE_INDEX: Map<string, AiReferrer> = new Map(
  AI_REFERRERS.flatMap((referrer) => referrer.sources.map((source) => [source, referrer] as const)),
);

/**
 * The referrer a GA4 `sessionSource` value belongs to, or null when it is not an AI assistant.
 *
 * Null is the overwhelmingly common answer — most sources are `google`, `(direct)` and the store's
 * own email — and returning it plainly is what keeps the AI figure a real subset rather than a
 * catch-all bucket.
 */
export function matchAiReferrer(sessionSource: string): AiReferrer | null {
  const normalized = sessionSource.trim().toLowerCase();
  if (!normalized) return null;
  return SOURCE_INDEX.get(normalized) ?? null;
}
