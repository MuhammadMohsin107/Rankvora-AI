/**
 * ─── The crawlers AI Discovery cares about, by exact name ────────────
 *
 * WHY AN EXACT LIST AND NOT A PATTERN
 * robots.txt matching is literal. `GPT-Bot` is not `GPTBot`, `Claude-Bot` is not `ClaudeBot`, and
 * a group naming the wrong string is silently inert — the crawler it was meant to address never
 * matches it, reads the `*` group instead, and the merchant believes they configured something
 * they did not. A single typo is one of the most common real defects in this area precisely
 * because nothing anywhere reports it. Holding the canonical spellings in one place is what lets
 * a check say "you wrote GPT-Bot; OpenAI's crawler is GPTBot" instead of "no rule found".
 *
 * WHY TRAINING AND CITATION CRAWLERS ARE SEPARATED
 * They are different business decisions. Blocking `GPTBot` keeps a store out of model training
 * while leaving it citable in ChatGPT's search results; blocking `OAI-SearchBot` removes it from
 * those results entirely. A check that lumped them together would tell a merchant who
 * deliberately opted out of training that they had broken their AI visibility, which is both
 * wrong and the opposite of what they chose. Purpose travels with the name for that reason.
 *
 * Sources are each vendor's own published crawler documentation. `commonCrawl` is listed because
 * several models were trained on its archive, but it is a third-party crawler rather than an AI
 * vendor's own, and the checks weight it accordingly.
 */

export type CrawlerPurpose = 'training' | 'search' | 'user-action' | 'archive';

export interface AiCrawler {
  /** The exact, case-correct token that belongs in a `User-agent:` line. */
  name: string;
  vendor: string;
  purpose: CrawlerPurpose;
  /**
   * The full User-Agent header this crawler sends, for a live fetch-as-bot probe. Null where the
   * vendor publishes no stable full string — Rankvora AI then never claims to have tested it.
   */
  userAgent: string | null;
  /** One line explaining what blocking this one actually costs the merchant. */
  effect: string;
  /**
   * Misspellings seen in the wild that a merchant plausibly meant as this crawler. Matched
   * case-insensitively; the canonical name is excluded so a correct rule never matches here.
   */
  commonTypos: string[];
}

export const AI_CRAWLERS: AiCrawler[] = [
  {
    name: 'GPTBot',
    vendor: 'OpenAI',
    purpose: 'training',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
    effect: 'Blocking it keeps your content out of OpenAI model training. It does not remove you from ChatGPT search results — OAI-SearchBot controls that.',
    commonTypos: ['GPT-Bot', 'GPT Bot', 'ChatGPTBot', 'OpenAIBot', 'GPTbot-User'],
  },
  {
    name: 'OAI-SearchBot',
    vendor: 'OpenAI',
    purpose: 'search',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
    effect: 'This is what puts your pages in ChatGPT search results. Blocking it removes you from them.',
    commonTypos: ['OAISearchBot', 'OAI_SearchBot', 'OpenAI-SearchBot', 'SearchGPT'],
  },
  {
    name: 'ChatGPT-User',
    vendor: 'OpenAI',
    purpose: 'user-action',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    effect: 'Fetches a page because a user asked ChatGPT to look at it. Blocking it means "open this link" fails for your store.',
    commonTypos: ['ChatGPTUser', 'ChatGPT_User', 'ChatGPT-user-agent'],
  },
  {
    name: 'ClaudeBot',
    vendor: 'Anthropic',
    purpose: 'training',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com',
    effect: 'Anthropic’s general crawler. Blocking it keeps your content out of Claude’s index.',
    commonTypos: ['Claude-Bot', 'Claude Bot', 'AnthropicBot', 'Claudebot-User'],
  },
  {
    name: 'Claude-User',
    vendor: 'Anthropic',
    purpose: 'user-action',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com',
    effect: 'Fetches a page on a user’s explicit request inside Claude. Blocking it breaks those lookups for your store.',
    commonTypos: ['ClaudeUser', 'Claude_User'],
  },
  {
    name: 'anthropic-ai',
    vendor: 'Anthropic',
    purpose: 'training',
    userAgent: null,
    effect: 'A legacy Anthropic agent string. Harmless to allow or disallow alongside ClaudeBot; on its own it controls nothing current.',
    commonTypos: ['anthropic_ai', 'anthropicai', 'Anthropic-AI-Bot'],
  },
  {
    name: 'PerplexityBot',
    vendor: 'Perplexity',
    purpose: 'search',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot',
    effect: 'Indexes pages so Perplexity can cite them. Blocking it removes your store from its answers.',
    commonTypos: ['Perplexity-Bot', 'Perplexity Bot', 'PerplexityAI', 'Perplexitybot-User'],
  },
  {
    name: 'Perplexity-User',
    vendor: 'Perplexity',
    purpose: 'user-action',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user',
    effect: 'Visits a page because a user followed it inside Perplexity. Blocking it breaks those visits.',
    commonTypos: ['PerplexityUser', 'Perplexity_User'],
  },
  {
    name: 'Google-Extended',
    vendor: 'Google',
    purpose: 'training',
    // Google-Extended is a robots.txt token only: it has no user-agent of its own and is never
    // sent as a header, so a live fetch cannot test it. Saying otherwise would be a fake probe.
    userAgent: null,
    effect: 'A robots.txt-only control for Gemini training and grounding. It does NOT affect Google Search ranking — Googlebot does that.',
    commonTypos: ['GoogleExtended', 'Google Extended', 'Google-Extended-Bot', 'GoogleOther-Extended'],
  },
  {
    name: 'Googlebot',
    vendor: 'Google',
    purpose: 'search',
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    effect: 'Google Search itself. Blocking it removes the store from Google entirely — the single most damaging robots.txt mistake there is.',
    // NOT `Googlebot-Mobile`: that was Google's own feature-phone crawler token, so a group naming it
    // is a real (if retired) rule, and calling it a misspelling of Googlebot is exactly the
    // confident wrong correction crawlerByTypo() exists to avoid.
    commonTypos: ['Google-Bot', 'Google bot', 'Googlebot-Web'],
  },
  {
    name: 'Bingbot',
    vendor: 'Microsoft',
    purpose: 'search',
    userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    effect: 'Bing Search, and the index behind Copilot. Blocking it costs both.',
    commonTypos: ['Bing-bot', 'Bing bot', 'MSNBot-Bing', 'BingBot-Search'],
  },
  {
    name: 'CCBot',
    vendor: 'Common Crawl',
    purpose: 'archive',
    userAgent: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
    effect: 'A public archive several models are trained from. Blocking it is a training-data decision, not a visibility one.',
    commonTypos: ['CC-Bot', 'CommonCrawl', 'Common-Crawl'],
  },
];

/** Crawlers whose absence genuinely costs a merchant AI/search visibility today. */
export const VISIBILITY_CRAWLERS = AI_CRAWLERS.filter(
  (crawler) => crawler.purpose === 'search' || crawler.purpose === 'user-action',
);

/** Every crawler that publishes a real User-Agent string, so a live probe is possible. */
export const PROBEABLE_CRAWLERS = AI_CRAWLERS.filter((crawler) => crawler.userAgent !== null);

/** Canonical name lookup, lower-cased, for matching a robots.txt token to a known crawler. */
const BY_LOWER_NAME = new Map(AI_CRAWLERS.map((crawler) => [crawler.name.toLowerCase(), crawler]));

/** The crawler a robots.txt `User-agent:` token names exactly, or null. */
export function crawlerByName(token: string): AiCrawler | null {
  return BY_LOWER_NAME.get(token.trim().toLowerCase()) ?? null;
}

/**
 * The crawler a mistyped token was probably meant to be, or null.
 *
 * Only the curated `commonTypos` are matched. Fuzzy distance scoring was deliberately not used:
 * it would eventually tell a merchant that their intentional rule for some unrelated bot is a
 * misspelling of GPTBot, and a confident wrong correction is worse than no correction.
 */
export function crawlerByTypo(token: string): AiCrawler | null {
  const normalized = token.trim().toLowerCase();
  if (BY_LOWER_NAME.has(normalized)) return null;
  return AI_CRAWLERS.find((crawler) => crawler.commonTypos.some((typo) => typo.toLowerCase() === normalized)) ?? null;
}
