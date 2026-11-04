
import 'dotenv/config';
import { parseTrustProxy } from '../lib/trustProxy.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail fast with the variable NAME only — never echo values.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 5000),
  /** Which proxy hops Express believes when working out a caller's address. See lib/trustProxy.ts. */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  /**
   * The SQLite file a Node process uses (tests, scripts, local runs), e.g. `./local.db`, or
   * `:memory:` for a throwaway one. Optional AT IMPORT because on Cloudflare the database is the D1
   * binding and there is no file. A Node process still fails fast and by name: db/client.ts and
   * server.ts call requireDatabasePath(), which throws "Missing required environment variable".
   */
  databasePath: process.env.DATABASE_PATH,
  /**
   * Skips authentication entirely and treats every request as user 1.
   *
   * ALLOWED ONLY IN DEVELOPMENT, not merely "not production". The previous guard was
   * `NODE_ENV !== 'production'`, which left it available on staging, preview and any environment
   * whose NODE_ENV was set to something else — each one reachable over the network and each one
   * fully unauthenticated the moment MOCK_AUTH was set. This now matches the standard the seed
   * script already held itself to: an explicit `development`, not an absence of `production`.
   */
  mockAuthEnabled: (process.env.NODE_ENV ?? 'development') === 'development' && process.env.MOCK_AUTH === 'true',
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  // Shopify app credentials — optional at startup (unlike the vars above) so the rest of the
  // API keeps working before a real Shopify Partner app is provisioned. Routes that need them
  // check shopifyConfigured() and fail with a clear 500 instead of crashing the whole server.
  shopifyApiKey: process.env.SHOPIFY_API_KEY,
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET,
  // The BACKEND's own public base URL — Shopify calls back to `${backendUrl}/api/shopify/callback`
  // directly, so this must be where this API is actually reachable, not the frontend's URL.
  backendUrl: process.env.BACKEND_URL,
  // Where to send the browser after a successful connect — the frontend app.
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  // ─── Google Search Console ──────────────────────────────────────────
  // OAuth client from the Google Cloud console. Optional at startup like the Shopify block above:
  // without it the API runs and every other route is unaffected, and the Integrations page shows
  // Search Console as unavailable rather than offering a Connect button that would fail.
  //
  // The redirect URI registered in Google Cloud must be exactly
  // `${BACKEND_URL}/api/google/callback` — Google matches it character for character, and a
  // mismatch is rejected at the consent screen before Rankvora AI is ever called.
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  // ─── PageSpeed Insights ─────────────────────────────────────────────
  // NOT an OAuth connector, and deliberately not modelled as one: the PageSpeed Insights API
  // measures a PUBLIC url and asks for no merchant account, so there is nothing for a merchant to
  // authorise. What it does have is quota, and that is what this key is for.
  //
  // OPTIONAL. Without it the API still answers — Google allows anonymous calls — but the quota is
  // per-IP and small, so a busy server will start collecting 429s. The connector therefore runs
  // either way and says which of the two it is using, rather than refusing to work or pretending a
  // rate-limit is a fault in the merchant's storefront.
  //
  // `GOOGLE_API_KEY` is accepted as an alias because that is the name Google's own PageSpeed
  // examples use. Enable "PageSpeed Insights API" on the key's Google Cloud project.
  pagespeedApiKey: process.env.PAGESPEED_API_KEY ?? process.env.GOOGLE_API_KEY,
  /**
   * Ceiling on ONE PageSpeed run, in milliseconds.
   *
   * Generous because this is not a normal API call: Google loads the page in a real headless
   * browser on its own infrastructure, and a heavy storefront on a cold cache genuinely takes
   * half a minute or more. A tight timeout here does not make anything faster — it just reports a
   * measurement that was about to succeed as a failure.
   */
  pagespeedTimeoutMs: Number(process.env.PAGESPEED_TIMEOUT_MS ?? 120_000),
  // ─── AI recommendations (OPTIONAL enhancement) ──────────────────────
  // Rankvora AI's recommendations are produced deterministically by the audit checks. AI only ever
  // REWRITES an existing recommendation more helpfully; it never produces one from nothing and
  // never gates an audit. Missing key, disabled flag, or any provider failure simply means the
  // deterministic text stands. Same optional-at-startup shape as the Shopify block.
  openaiApiKey: process.env.OPENAI_API_KEY,
  /** Cost-efficient default; override per environment. Never hard-code a model at a call site. */
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  /**
   * Which vendor serves AI requests: 'openai' (default) or 'gemini'.
   *
   * Defaults to openai so an existing deployment keeps working untouched. Setting AI_PROVIDER
   * alone is not enough — the chosen provider must also have its key, which is what
   * aiConfigured() checks.
   */
  aiProvider: (process.env.AI_PROVIDER ?? 'openai').trim().toLowerCase(),
  /**
   * Google AI Studio key for the Gemini provider (aistudio.google.com).
   *
   * `GEMINI_API_KEY` is accepted as an alias because that is the name Google's own examples use,
   * and an operator who copies one of those into .env should not have to discover that Rankvora AI
   * spells it differently.
   */
  geminiApiKey: process.env.AI_API_KEY ?? process.env.GEMINI_API_KEY,
  /**
   * Flash-Lite by default, and deliberately not a Gemini 3 model.
   *
   * Verified against a live key: gemini-flash-lite-latest returned valid structured JSON in about
   * a second, while gemini-3.6-flash spent its whole output budget on thinking tokens and came
   * back with a truncated body. Rankvora AI needs short, schema-shaped answers inside a request, which
   * is exactly what Flash-Lite is for.
   */
  geminiModel: process.env.AI_MODEL ?? 'gemini-flash-lite-latest',
  /** Kill switch that works even when a key is present — set to 'false' to stop all AI calls. */
  aiRecommendationsEnabled: process.env.AI_RECOMMENDATIONS_ENABLED !== 'false',
  /**
   * Ceiling on ONE call to the model, in milliseconds.
   *
   * Was a hard-coded 20s in each provider. Two things made that too tight: a cold first call can
   * genuinely take longer (observed against a live key), and there is no retry — one slow call is
   * reported to the merchant as "AI could not draft these right now". It also has to cover a
   * whole batch of fix proposals, which is larger now that the batch size is configurable.
   */
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 45_000),
  /**
   * Ceiling on ONE capability call INCLUDING its retry, in milliseconds.
   *
   * Measured against the live endpoint, latency is bimodal: most calls answer in 1-2s, a minority
   * stall 25-45s and then answer correctly. One retry covers the tail beyond the per-attempt
   * timeout — but two full attempts would leave a merchant at a spinner for a minute and a half,
   * so the retry only runs inside what is left of this.
   */
  aiTotalBudgetMs: Number(process.env.AI_TOTAL_BUDGET_MS ?? 60_000),
  /** Least time a retry is worth starting with. A typical answer takes a couple of seconds; a
   * sliver of remaining budget would spend the merchant's wait on a call that cannot finish. */
  aiRetryMinRemainingMs: Number(process.env.AI_RETRY_MIN_REMAINING_MS ?? 8_000),
  /**
   * How many resources ONE "Draft with AI" press may plan for.
   *
   * Bounded because every target costs prompt tokens, output tokens and latency inside a request.
   * The output budget is derived from this rather than fixed (see fixOutputTokens in prompt.ts),
   * so raising it cannot silently truncate the completion the way a flat budget would.
   */
  aiFixMaxTargets: Number(process.env.AI_FIX_MAX_TARGETS ?? 25),
  // ─── AI product images (OPTIONAL) ───────────────────────────────────
  // Drawing a product photo from a product's own title and description, for the Missing images
  // panel. A separate capability from the text calls above because the two rarely share a model:
  // a key that writes meta descriptions (a free Gemini Flash-Lite key, say) usually cannot draw.
  /**
   * Which vendor draws product images: 'openai' or 'gemini'. Defaults to AI_PROVIDER, so a store
   * configured for one vendor uses its key for images too unless told otherwise.
   */
  aiImageProvider: (process.env.AI_IMAGE_PROVIDER ?? process.env.AI_PROVIDER ?? 'openai').trim().toLowerCase(),
  /** The image model. Unset means the provider's own default (lib/ai/image-provider.ts). */
  aiImageModel: process.env.AI_IMAGE_MODEL?.trim() || undefined,
  /**
   * Ceiling on ONE image request, in milliseconds. Kept under nginx's default 60-second proxy
   * timeout, so a slow model is reported as slow instead of as a dropped connection. Raise it only
   * together with the proxy's timeout.
   */
  aiImageTimeoutMs: Number(process.env.AI_IMAGE_TIMEOUT_MS ?? 55_000),
  /** Kill switch for image generation alone. AI_RECOMMENDATIONS_ENABLED=false stops it too. */
  aiImageEnabled: process.env.AI_IMAGE_ENABLED !== 'false',
  /**
   * How many evidence rows each sub-pillar persists on an audit.
   *
   * EVERY page is still analyzed and scored — this caps only the per-row table stored as JSON and
   * rendered in the evidence table, which is also the set the merchant can select for bulk fixes.
   * At 50 a store with 103 flagged pages could only ever see and act on half of them.
   */
  auditEvidenceRowLimit: Number(process.env.AUDIT_EVIDENCE_ROW_LIMIT ?? 200),
  // ─── Storefront crawler ─────────────────────────────────────────────
  // Bounds on the one part of Rankvora AI that makes requests to a merchant's public storefront.
  // Every value is a safety limit rather than a tuning knob: the defaults are what a polite
  // crawler should do to a live shop that is also serving real customers.
  /** Hard ceiling on pages fetched per audit, across every page type. */
  crawlMaxPages: Number(process.env.CRAWL_MAX_PAGES ?? 40),
  /** Per-request timeout. A slow storefront must not hold an audit open. */
  crawlTimeoutMs: Number(process.env.CRAWL_TIMEOUT_MS ?? 12_000),
  /** Simultaneous in-flight requests to ONE merchant's storefront. */
  crawlConcurrency: Number(process.env.CRAWL_CONCURRENCY ?? 3),
  /** Identifies Rankvora AI to the merchant's logs and to Shopify. Keep the contact URL. */
  crawlUserAgent: process.env.CRAWL_USER_AGENT ?? 'ScoreloAuditBot/1.0 (+https://scorelo.app/bot)',
  /**
   * Optional storefront password for a shop still behind Shopify's "Restrict access" gate.
   *
   * A gated storefront serves the password screen for EVERY url with HTTP 200, so without this a
   * crawl of a development store can measure nothing — and, worse, would read the password page
   * as though it were the merchant's own markup. Supplying it lets Rankvora AI authenticate once and
   * crawl the real pages. Never logged, never returned by the API.
   */
  crawlStorefrontPassword: process.env.CRAWL_STOREFRONT_PASSWORD,
  /** Set to 'false' to stop all storefront crawling without touching anything else. */
  crawlEnabled: process.env.CRAWL_ENABLED !== 'false',
  /**
   * Ask the storefront root for a response as each named AI/search crawler, once per audit.
   *
   * ON by default: it is the only way to see a WAF or bot-manager rule that answers GPTBot
   * differently from a browser, which robots.txt parsing cannot detect because it happens above
   * robots.txt. The cost is one extra request per probeable crawler per audit, pooled at the same
   * concurrency as everything else. Set to 'false' where a shop's edge provider treats repeated
   * crawler-agent requests as abuse.
   */
  crawlProbeBots: process.env.CRAWL_PROBE_BOTS !== 'false',
  // ─── Scheduled re-analysis ──────────────────────────────────────────
  // Per-store scheduling lives in the database (`stores.auto_analysis`, `analysis_frequency`) and
  // is the merchant's to set in Settings. These are the OPERATOR's controls over the sweep that
  // acts on it — how often to look, how much to start at once, and a switch to stop it entirely.
  /** Kill switch for the whole scheduler. Per-store preferences are untouched while it is off. */
  autoAnalysisEnabled: process.env.AUTO_ANALYSIS_ENABLED !== 'false',
  /** How often to look for stores whose interval has elapsed. Not how often a store is analysed —
   * that is the store's own frequency, and a sweep starts nothing when nothing is due. */
  autoAnalysisIntervalMs: Number(process.env.AUTO_ANALYSIS_INTERVAL_MS ?? 30 * 60_000),
  /** Delay before the FIRST sweep after boot, so a redeploy does not trigger a round of audits. */
  autoAnalysisStartDelayMs: Number(process.env.AUTO_ANALYSIS_START_DELAY_MS ?? 5 * 60_000),
  /** Ceiling on runs queued per sweep, so a backlog is worked through over several ticks instead
   * of hitting many storefronts at once. */
  autoAnalysisMaxPerSweep: Number(process.env.AUTO_ANALYSIS_MAX_PER_SWEEP ?? 3),
  /**
   * Whether this Node process closes out queued/running audit jobs when it starts (failInterruptedJobs).
   *
   * ON by default — right while this process is the only thing that runs audits, because a job it
   * was running died with it. Set to 'false' on the old server once Cloudflare runs the audits: those
   * jobs belong to Cloudflare Workflows, and a restart of the old server must not fail them. Turn it
   * off together with AUTO_ANALYSIS_ENABLED=false and WEEKLY_SUMMARY_ENABLED=false.
   */
  failInterruptedJobsOnStart: process.env.FAIL_INTERRUPTED_JOBS !== 'false',
  // ─── Stuck audit jobs (Cloudflare) ──────────────────────────────────
  // On Cloudflare an audit runs in a Workflow, not in a process that restarts, so failInterruptedJobs()
  // has no start-up to run at. Instead the scheduled sweep closes out jobs that cannot still be alive
  // (services/job.service.ts, failStuckJobs). Node does not run this sweep.
  /** A job 'running' longer than this is dead: the Workflow step's own timeout is one hour. */
  stuckJobRunningMs: Number(process.env.STUCK_JOB_RUNNING_MS ?? 90 * 60_000),
  /** A job still 'queued' after this never started: a Workflow normally picks it up in seconds. */
  stuckJobQueuedMs: Number(process.env.STUCK_JOB_QUEUED_MS ?? 15 * 60_000),
  // ─── Weekly summary ─────────────────────────────────────────────────
  // Whether a store receives one is the owner's `notify_weekly_summary` switch. These are the
  // operator's controls over the sweep that writes them (services/weekly-summary.service.ts).
  /** Kill switch for the weekly summary sweep. Per-user preferences are untouched while it is off. */
  weeklySummaryEnabled: process.env.WEEKLY_SUMMARY_ENABLED !== 'false',
  /** How often to look for stores whose Monday summary is due. Not how often one is written —
   * that is once per store per week, whatever this is set to. */
  weeklySummaryIntervalMs: Number(process.env.WEEKLY_SUMMARY_INTERVAL_MS ?? 30 * 60_000),
} as const;

/**
 * The local SQLite file (Node only), or a startup error naming the variable.
 *
 * Read when the database is opened, not only at import, so the test helper can point every test at
 * a throwaway in-memory database (tests/helpers/database.ts) whatever a developer's .env says.
 */
export function requireDatabasePath(): string {
  return process.env.DATABASE_PATH || env.databasePath || required('DATABASE_PATH');
}

/** Whether storefront crawling should be attempted at all. */
export function crawlConfigured(): boolean {
  return env.crawlEnabled && env.crawlMaxPages > 0;
}

/** The key belonging to the selected provider, or undefined when it is not configured. */
export function aiProviderKey(): string | undefined {
  return env.aiProvider === 'gemini' ? env.geminiApiKey : env.openaiApiKey;
}

/** The model the selected provider will use. Surfaced to the UI; never the key. */
export function aiModelName(): string {
  return env.aiProvider === 'gemini' ? env.geminiModel : env.openaiModel;
}

/**
 * True only when AI enhancement should actually be attempted. Both a key AND the flag are
 * required, so an operator can disable spend instantly without removing credentials.
 *
 * The key checked is the SELECTED provider's: setting AI_PROVIDER=gemini while only an OpenAI key
 * is present must read as "not configured" rather than quietly calling the wrong vendor.
 */
export function aiConfigured(): boolean {
  return Boolean(aiProviderKey()) && env.aiRecommendationsEnabled;
}

export function shopifyConfigured(): boolean {
  return Boolean(env.shopifyApiKey && env.shopifyApiSecret && env.backendUrl && env.tokenEncryptionKey);
}

/**
 * Whether Google Search Console can be offered at all.
 *
 * `tokenEncryptionKey` is part of it because the refresh token Google returns is a long-lived
 * credential to a merchant's search data — storing it without encryption at rest is not a
 * degraded mode worth having, so the integration is hidden rather than offered insecurely.
 *
 * `backendUrl` is required because the OAuth redirect URI is derived from it and Google matches
 * it exactly; guessing a default here would produce a consent screen that always fails.
 */
export function googleConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret && env.backendUrl && env.tokenEncryptionKey);
}

/**
 * Whether PageSpeed runs are made against Google's KEYED quota rather than its anonymous one.
 *
 * Deliberately NOT a `pagespeedConfigured()` gate. There is nothing to configure before the
 * connector works — Google answers keyless calls — so a false here narrows the quota, it does not
 * disable the feature. The card says which quota is in use so a 429 is legible instead of looking
 * like an intermittent fault.
 */
export function pagespeedKeyed(): boolean {
  return Boolean(env.pagespeedApiKey);
}

export const isDev = env.nodeEnv !== 'production';
