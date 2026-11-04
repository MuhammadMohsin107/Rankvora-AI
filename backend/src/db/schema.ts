// ─── Rankvora AI · D1 (SQLite) schema ───────────────────────────────────
// The tables, columns, defaults, foreign keys, CHECK rules and indexes of the schema this app ran
// on before Cloudflare, expressed for Cloudflare D1, which is SQLite. Converted column by column, so
// every comment below is its own documentation of what the column is for. Sign-in is Shopify only:
// there is no table or column for a password, a second factor, a reset or an email verification.
// Migrations: ./drizzle-d1.
//
//   users         → Settings · Profile / Notifications / Appearance
//   stores        → Settings · Workspace & store / Analysis; dashboard header
//   audits        → "Last analyzed", score trend, Reports current-vs-previous
//   audit_scores  → Dashboard pillar rows, pillar dashboards, sub-pillar pages
//   findings      → Fix Center (mutable status), priority issues, sub-pillar findings
//   integrations  → Integrations page (mutable connection state)
//
// ID strategy: auto-increment integer PKs — single-tenant internal data
// with no distributed-generation or external-exposure requirement.
//
// ─── How the MySQL types map (and what differs) ──────────────────────
//
// varchar(n) → text: SQLite has one text type and indexes it without a prefix length. The length
// is kept in the column definition for the TypeScript types and as documentation; SQLite does not
// enforce it, so a value longer than the MySQL column allowed is stored rather than refused.
//
// datetime → integer milliseconds since the epoch, UTC (Drizzle 'timestamp_ms'). A Date in, a Date
// out, exactly as before. Defaults are the insert time in whole seconds, like MySQL's DATETIME.
//
// boolean → integer 0/1 (Drizzle 'boolean'): true/false in and out, exactly as before.
//
// json → text holding JSON (Drizzle 'json'): objects in and out, exactly as before.
//
// decimal → numeric, read back as a string — the same type the MySQL driver returned.
//
// The two STORED generated columns MySQL needed only to carry an index (jobs.active_flag,
// audit_scores.sub_pillar_key) are not here: SQLite indexes the expression itself — a partial
// unique index and an expression unique index — which gives the same guarantees. Nothing in the
// code reads either column.
//
// Comparisons are case-SENSITIVE in SQLite; MySQL's default collation compared text ignoring case.
// Lookups that relied on that are dealt with where the queries move over (services), not here.

import { sql } from 'drizzle-orm';
import { check, index, integer, numeric, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** The insert time, in milliseconds like every timestamp column here (whole seconds, as MySQL's DATETIME). */
const now = sql`(unixepoch() * 1000)`;

// ─── users ───────────────────────────────────────────────────────────
// One account per Shopify store, opened from the shop's own records the first time the store opens
// the app. It holds no credential of any kind — Shopify proves who is calling. Persisted by
// Settings → Profile, Notifications and Appearance, which already have a save workflow.
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fullName: text('full_name', { length: 255 }).notNull(),
  email: text('email', { length: 320 }).notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  jobTitle: text('job_title', { length: 255 }),
  /**
   * A PROFILE LABEL, NOT A PERMISSION. Settings → Profile displays this next to the job title, it
   * defaults to 'Administrator' on every row, and no code reads it to make a decision. Never use it
   * as an authorization input: it says 'Administrator' on every account that has ever been created.
   */
  role: text('role', { length: 64 }).notNull().default('Administrator'),
  // Notifications (Settings → Notifications: six explicit toggles)
  notifyAnalysisComplete: integer('notify_analysis_complete', { mode: 'boolean' }).notNull().default(true),
  notifyCriticalIssues: integer('notify_critical_issues', { mode: 'boolean' }).notNull().default(true),
  notifyScoreChanges: integer('notify_score_changes', { mode: 'boolean' }).notNull().default(true),
  notifyWeeklySummary: integer('notify_weekly_summary', { mode: 'boolean' }).notNull().default(true),
  notifyIntegrationAlerts: integer('notify_integration_alerts', { mode: 'boolean' }).notNull().default(true),
  notifyProductUpdates: integer('notify_product_updates', { mode: 'boolean' }).notNull().default(false),
  // Appearance (Settings → Appearance)
  density: text('density', { length: 32 }).notNull().default('Comfortable'),
  reduceMotion: integer('reduce_motion', { mode: 'boolean' }).notNull().default(false),
});

// ─── security_events ─────────────────────────────────────────────────
// An append-only record of security-relevant actions: today, the first time a shop opens the app.
//
// EVERY ROW COMES FROM A REAL BACKEND ACTION. Nothing seeds this table, nothing backfills it, and
// an account that has done nothing shows an empty history rather than an invented one.
//
// SECURITY: `metadata` describes WHAT HAPPENED, never the credential involved. No refresh token,
// access token or hash is ever written here — see security-event.service.ts, which is the only
// writer, precisely so that rule holds in one place.
export const securityEvents = sqliteTable(
  'security_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', { length: 32 }).notNull(),
    /** Real client IP when available, else NULL. */
    ipAddress: text('ip_address', { length: 45 }),
    userAgent: text('user_agent', { length: 512 }),
    /** Small, non-secret context — e.g. how many sessions a revoke-others ended. */
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    index('security_events_user_created_idx').on(table.userId, table.createdAt),
    check(
      'security_events_type_valid',
      // The list still names events no code records any more — logout, password_changed,
      // password_reset, email_verified and the session ones, from when the app had its own sign-in
      // and sessions. It is NOT shortened:
      // rows copied from the old database may hold them, and SQLite can only change a CHECK by
      // rebuilding the table, which would have to refuse or delete those rows. Nothing writes them
      // (SecurityEventType in security-event.service.ts is the live vocabulary).
      sql`${table.type} IN ('login_success', 'login_failed', 'logout', 'password_changed', 'password_reset', 'email_verified', 'session_revoked', 'sessions_revoked')`,
    ),
  ],
);

// ─── google_connections ──────────────────────────────────────────────
// One row per store that has authorised Rankvora AI against Google Search Console.
//
// A SEPARATE TABLE FROM `integrations`, which holds only display state (status, a label, a last-
// synced stamp). Credentials do not belong there: that row is read and written by ordinary
// settings code, and a refresh token is a long-lived key to a merchant's search data. Keeping it
// in its own table means the integrations row can stay freely readable while the secret is not.
//
// SHAPED AFTER `shopify_connections` deliberately — same encrypted-token pattern, same expiry
// handling, same "one live connection per store". Two OAuth integrations with two different
// storage designs is how one of them ends up with the weaker one.
//
// SECURITY: both tokens are AES-256-GCM encrypted at rest with TOKEN_ENCRYPTION_KEY, never logged,
// and never returned by any API. The access token lives about an hour; the refresh token is what
// actually matters and is spent server-side with no merchant interaction.
export const googleConnections = sqliteTable(
  'google_connections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** The Google account that granted access, for the merchant to recognise the connection by. */
    googleEmail: text('google_email', { length: 320 }),
    /**
     * The Search Console property this store reads, e.g. `sc-domain:example.com` or
     * `https://example.com/`.
     *
     * Nullable because a merchant can authorise before a property is chosen — an account with
     * several verified sites has to pick one, and an arbitrary guess would silently report on the
     * wrong domain.
     */
    siteUrl: text('site_url', { length: 512 }),
    /**
     * The GA4 property this store reports on — the NUMERIC id, e.g. `498211037`, from which
     * `properties/498211037` is formed for the API.
     *
     * NOT the `G-XXXXXXXXXX` measurement id, which belongs in a page tag and which the Data API
     * rejects outright. The two are easy to confuse because the Analytics admin shows both.
     *
     * Nullable for the same reason siteUrl is: an account with several properties has to pick one,
     * and choosing automatically would report another brand's traffic as this store's. It also
     * stays null for every connection that authorised before GA4 support existed.
     */
    ga4PropertyId: text('ga4_property_id', { length: 32 }),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    /**
     * NULLABLE, and the distinction is load-bearing. Google returns a refresh token only on the
     * FIRST consent for a client; a re-authorisation without `prompt=consent` returns an access
     * token alone. A null here therefore means "this connection cannot renew itself" and the
     * merchant must reconnect — not "renewal failed".
     */
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    /** The scope string Google actually granted, which is the truth about what this token permits. */
    scope: text('scope').notNull(),
    /** Set when the last read failed, cleared when one succeeds. */
    lastError: text('last_error', { length: 500 }),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    /** Non-null once the merchant disconnects. The row is kept so a reconnect is an update. */
    disconnectedAt: integer('disconnected_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('google_connections_store_idx').on(table.storeId),
  ],
);

// ─── stores ──────────────────────────────────────────────────────────
// The storefront Rankvora AI analyzes. Identity fields feed the dashboard
// header; analysis fields are Settings → Analysis (crawl behaviour).
export const stores = sqliteTable('stores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerId: integer('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceName: text('workspace_name', { length: 255 }).notNull(),
  name: text('name', { length: 255 }).notNull(),
  url: text('url', { length: 512 }).notNull(),
  platform: text('platform', { length: 64 }).notNull(),
  industry: text('industry', { length: 128 }).notNull(),
  country: text('country', { length: 128 }).notNull(),
  timezone: text('timezone', { length: 64 }).notNull(),
  currency: text('currency', { length: 64 }).notNull(),
  // Analysis preferences (Settings → Analysis)
  autoAnalysis: integer('auto_analysis', { mode: 'boolean' }).notNull().default(true),
  analysisFrequency: text('analysis_frequency', { length: 32 }).notNull().default('Weekly'),
  crawlScope: text('crawl_scope', { length: 64 }).notNull().default('Entire store'),
  pageLimit: integer('page_limit').notNull().default(2000),
  includeBlog: integer('include_blog', { mode: 'boolean' }).notNull().default(true),
  includeCollections: integer('include_collections', { mode: 'boolean' }).notNull().default(true),
  respectRobots: integer('respect_robots', { mode: 'boolean' }).notNull().default(true),
  /**
   * What Shopify last reported for this store's identity — name, primary URL, country, currency,
   * timezone — and when, as a ShopifyStoreFacts (services/store-profile.service.ts).
   *
   * Kept so a refresh can tell a value nobody touched (it still equals this) from one the merchant
   * edited (it does not), and overwrite only the first. Null until a shop has been read.
   */
  shopifyProfile: text('shopify_profile', { mode: 'json' }),
  /**
   * When this store's weekly summary was last written to the bell. Null until the first one.
   *
   * Tracked here, not derived from the notifications table, because a merchant can delete a
   * notification — and a summary whose only record is the row they just removed would be written
   * again on the next sweep. See services/weekly-summary.service.ts.
   */
  weeklySummaryAt: integer('weekly_summary_at', { mode: 'timestamp_ms' }),
}, (table) => [index('stores_owner_idx').on(table.ownerId)]);

// ─── audits ──────────────────────────────────────────────────────────
// One row per analysis run. run_at powers "Last analyzed"; the series
// powers the dashboard score trend and Reports' current-vs-previous.
export const audits = sqliteTable(
  'audits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    overallScore: integer('overall_score').notNull(),
    runAt: integer('run_at', { mode: 'timestamp_ms' }).notNull().default(now),
    // 'engine' = computed by the real audit engine from live store data.
    // 'seed'   = development/demo fixture. Kept distinguishable so seeded rows can never be
    //            silently presented to a customer as a real audit of their store.
    source: text('source', { length: 16 }).notNull().default('engine'),
    // Honest run metadata: scope limits actually applied, resource counts fetched, and any
    // pillar that failed (so a partial audit is never mistaken for a complete one).
    metadata: text('metadata', { mode: 'json' }),
  },
  (table) => [
    index('audits_store_run_idx').on(table.storeId, table.runAt),
    check('audits_score_range', sql`${table.overallScore} BETWEEN 0 AND 100`),
    check('audits_source_valid', sql`${table.source} IN ('engine', 'seed')`),
  ],
);

// ─── audit_scores ────────────────────────────────────────────────────
// Pillar- and sub-pillar-level scores for one audit.
//   sub_pillar NULL  → pillar row (dashboard pillar list; checks_* shown there)
//   sub_pillar set   → sub-pillar row (detail pages; analyzed/healthy metric strip)
export const auditScores = sqliteTable(
  'audit_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    auditId: integer('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    pillar: text('pillar', { length: 32 }).notNull(),
    subPillar: text('sub_pillar', { length: 120 }),
    // MySQL carried COALESCE(sub_pillar, '') in a generated `sub_pillar_key` column and put one
    // unique index on (audit_id, pillar, sub_pillar_key). Here the same guarantee is two plain
    // indexes below — one row per sub-pillar, and one pillar-level row (sub_pillar NULL) per audit
    // and pillar — because drizzle-kit 0.31 writes an expression index with a comma in it as broken
    // SQL. Nothing in the code reads `sub_pillar_key`.
    score: integer('score').notNull(),
    // Pillar rows only (Dashboard "checks passed" column)
    checksTotal: integer('checks_total'),
    checksPassed: integer('checks_passed'),
    // Sub-pillar rows only (detail-page metric strip)
    analyzedCount: integer('analyzed_count'),
    healthyCount: integer('healthy_count'),
    // Per-sub-pillar detailed metrics / evidence payloads for flexible audit data
    details: text('details', { mode: 'json' }),
  },
  (table) => [
    // One row per sub-pillar of an audit's pillar. Rows whose sub_pillar is NULL never collide here
    // (SQLite, like MySQL, treats NULLs as distinct in a unique index) — the next index covers them.
    uniqueIndex('audit_scores_unique_idx').on(table.auditId, table.pillar, table.subPillar),
    // One pillar-level row (sub_pillar NULL) per audit and pillar.
    uniqueIndex('audit_scores_pillar_unique_idx').on(table.auditId, table.pillar).where(sql`${table.subPillar} IS NULL`),
    check('audit_scores_score_range', sql`${table.score} BETWEEN 0 AND 100`),
    check(
      'audit_scores_pillar_valid',
      sql`${table.pillar} IN ('seo', 'content', 'speed', 'cro', 'ai-discovery')`,
    ),
  ],
);

// ─── findings ────────────────────────────────────────────────────────
// One row per issue an audit surfaced. This is the only entity the UI
// mutates repeatedly: Fix Center moves status between open / reviewed /
// resolved / ignored (single and bulk). Also renders priority issues
// and every sub-pillar findings list + investigation drawer.
export const findings = sqliteTable(
  'findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    auditId: integer('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    pillar: text('pillar', { length: 32 }).notNull(),
    // Slug, not display label (e.g. 'title-tags', not 'Title Tags') — matches the
    // frontend route param and pillarMeta.ts's canonical sub-pillar ids.
    subPillar: text('sub_pillar', { length: 120 }).notNull(),
    title: text('title', { length: 512 }).notNull(),
    severity: text('severity', { length: 16 }).notNull(),
    status: text('status', { length: 16 }).notNull().default('open'),
    // How the finding gets resolved (Automated / Product / Service /
    // Integration / Deferred) — drives the CTA on pillar pages.
    resolutionType: text('resolution_type', { length: 32 }),
    affectedCount: integer('affected_count').notNull(),
    affectedLabel: text('affected_label', { length: 255 }).notNull(),
    /**
     * NO LONGER WRITTEN, and read by nothing. Every check used to type an impact word in by hand
     * ("High" for the same issue in every store) and every screen showed it as if it had been
     * measured. The audit's rule-based `severity` is what is shown now. Kept nullable rather than
     * dropped so the audits already stored still load; new rows leave it empty.
     */
    impact: text('impact', { length: 32 }),
    scoreLift: integer('score_lift').notNull().default(0),
    // Drawer copy: what is wrong / why it matters / what to do.
    problem: text('problem'),
    why: text('why').notNull(),
    recommendation: text('recommendation').notNull(),
    // Bullet list shown in the Fix Center / sub-pillar drawers. Postgres used a
    // text[]; MySQL has no array type, so this is a JSON array of strings. The
    // shape the API returns is unchanged.
    evidence: text('evidence', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // Structured row data for evidence tables that need richer than text-only payloads
    evidenceRows: text('evidence_rows', { mode: 'json' }),
    // ─── Optional AI enhancement ─────────────────────────────────────
    // Cached so a recommendation is generated ONCE per finding rather than on every render —
    // this is the cost control that keeps a dashboard refresh from becoming an API bill.
    // Null is the normal state: no AI configured, not requested yet, or generation failed.
    // `recommendation` above remains the deterministic source of truth and is never overwritten.
    aiRecommendation: text('ai_recommendation', { mode: 'json' }).$type<{
      recommendation: string;
      whyItMatters: string;
      suggestedAction: string;
      confidence: 'high' | 'medium' | 'low';
    }>(),
    /** Which model produced the cached text, so a model change can be identified later. */
    aiModel: text('ai_model', { length: 64 }),
    aiGeneratedAt: integer('ai_generated_at', { mode: 'timestamp_ms' }),
    // Per-sub-pillar-analysis extras (issueType/effort) that don't apply to every
    // pillar's findings — see SubPillarFinding in frontend/src/data/seo/subpillar.model.ts.
    details: text('details', { mode: 'json' }),
    // When status last changed — shown in Fix Center's "Applied fixes".
    statusChangedAt: integer('status_changed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('findings_audit_idx').on(table.auditId),
    index('findings_status_idx').on(table.status),
    check(
      'findings_severity_valid',
      sql`${table.severity} IN ('critical', 'high', 'medium', 'low')`,
    ),
    check(
      'findings_status_valid',
      sql`${table.status} IN ('open', 'reviewed', 'resolved', 'ignored')`,
    ),
    check(
      'findings_pillar_valid',
      sql`${table.pillar} IN ('seo', 'content', 'speed', 'cro', 'ai-discovery')`,
    ),
  ],
);

// ─── integrations ────────────────────────────────────────────────────
// Connection STATE only. Provider names, descriptions and "data
// received" chips are a static catalog in the frontend; what changes —
// and therefore persists — is whether each provider is connected,
// which account, when it last synced, and any attention notice.
export const integrations = sqliteTable(
  'integrations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    provider: text('provider', { length: 64 }).notNull(),
    status: text('status', { length: 32 }).notNull().default('not_connected'),
    accountDetail: text('account_detail', { length: 255 }),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
    notice: text('notice'),
  },
  (table) => [
    uniqueIndex('integrations_store_provider_idx').on(table.storeId, table.provider),
    check(
      'integrations_status_valid',
      sql`${table.status} IN ('connected', 'needs_attention', 'not_connected')`,
    ),
  ],
);

// ─── pagespeed_reports ───────────────────────────────────────────────
// One row per PageSpeed Insights MEASUREMENT, append-only.
//
// Append-only rather than one row per (store, strategy) because a performance measurement is an
// observation with a time attached, not a current value: "LCP is 3.1s" is meaningless without
// "when", and overwriting destroys the only thing that shows whether a change helped. The latest
// is the newest row for that strategy.
//
// NOTHING IS DERIVED OR FILLED IN HERE. `lab` is the Lighthouse run Google just performed;
// `field` is real-user CrUX data and is NULL whenever the url (or its origin) has too few real
// visits for Google to report — which is the normal state for a new or quiet store, and must
// stay distinguishable from "fast". The two are separate columns for the same reason: a lab
// number is not a field number and neither substitutes for the other.
export const pagespeedReports = sqliteTable(
  'pagespeed_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** The url Rankvora AI asked Google to measure. */
    requestedUrl: text('requested_url', { length: 1024 }).notNull(),
    /** The url Lighthouse actually landed on after redirects — what the numbers describe. */
    finalUrl: text('final_url', { length: 1024 }),
    /** 'mobile' or 'desktop'. Google emulates a different device for each; they are not comparable. */
    strategy: text('strategy', { length: 16 }).notNull(),
    /** Lighthouse performance category, 0–100. Null when the run produced no category score. */
    performanceScore: integer('performance_score'),
    /** This run's lab metrics, as parsed from lighthouseResult.audits. See pagespeed.service.ts. */
    lab: text('lab', { mode: 'json' }),
    /** CrUX field metrics for real visitors. NULL = Google has no sufficient sample, never "0". */
    field: text('field', { mode: 'json' }),
    /** Lighthouse opportunities carrying a real estimated saving, as Google ranked them. */
    opportunities: text('opportunities', { mode: 'json' }),
    lighthouseVersion: text('lighthouse_version', { length: 32 }),
    /** When GOOGLE ran the analysis (analysisUTCTimestamp), which is not when Rankvora AI asked. */
    analyzedAt: integer('analyzed_at', { mode: 'timestamp_ms' }),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // Ordered so "the latest run for this store and strategy" is an index seek, which is the one
    // query the card and the audit both make.
    index('pagespeed_reports_latest_idx').on(table.storeId, table.strategy, table.fetchedAt),
    check('pagespeed_reports_strategy_valid', sql`${table.strategy} IN ('mobile', 'desktop')`),
  ],
);

// ─── notifications ────────────────────────────────────────────────────
// Real, persisted notifications for the app header and notifications page.
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    type: text('type', { length: 64 }).notNull(),
    title: text('title', { length: 255 }).notNull(),
    message: text('message').notNull(),
    tone: text('tone', { length: 16 }).notNull().default('info'),
    /**
     * WHERE THE WORK IS. An in-app path — "/fix-center?severity=critical", "/seo",
     * "/reports?audit=214" — captured when the notification is written, because that is the only
     * moment the specifics are known: which pillar moved, which audit finished. Reconstructing it
     * later from the type alone can only ever land on a list.
     *
     * Always a path, never a URL. Nothing here may become an off-site redirect: the value is
     * checked on write and again before the browser navigates.
     *
     * Nullable, and not back-filled. Rows written before this column existed have no specifics to
     * recover; the client falls back to the best page for their type rather than inventing a
     * target they were never about.
     */
    link: text('link', { length: 512 }),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    index('notifications_store_created_idx').on(table.storeId, table.createdAt),
    check(
      'notifications_tone_valid',
      sql`${table.tone} IN ('neutral', 'success', 'warning', 'critical', 'info')`,
    ),
  ],
);

// ─── shopify_connections ────────────────────────────────────────────────
// OAuth install state for a store's connected Shopify shop. Separate from
// `integrations` (which is a generic, provider-agnostic connection-status
// display row) because OAuth has its own lifecycle: install/token/scope,
// uninstall, and the GDPR redact webhooks.
export const shopifyConnections = sqliteTable(
  'shopify_connections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    shopDomain: text('shop_domain', { length: 255 }).notNull().unique(),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    scope: text('scope').notNull(),
    // ── Expiring offline access tokens ────────────────────────────────
    // Shopify requires public apps to use EXPIRING offline tokens for Admin API requests from
    // 2027-01-01. An expiring access token lives 1 hour; the refresh token that renews it lives
    // 90 days and is spent server-side with no merchant interaction.
    //
    // All four columns are nullable on purpose: a connection created before this change holds a
    // legacy non-expiring token with no refresh token and no expiry, and must keep working
    // untouched until the merchant reconnects. NULL `access_token_expires_at` therefore means
    // "legacy, never expires", NOT "expired" — see needsRefresh() in shopify-oauth.service.ts.
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    // The shop's own Admin API identity (gid://shopify/Shop/123456). Captured from Shopify at
    // install rather than assumed, so store identity survives a myshopify domain rename.
    shopGid: text('shop_gid', { length: 64 }),
    // Outcome of the last real read of the shop's data: resource counts actually fetched, which
    // groups were truncated by the scope limit, and any non-fatal warnings. Persisted so the
    // Integrations page can show what was genuinely synced instead of re-asserting "Connected",
    // and so a partial sync of a large catalogue is never presented as a complete one.
    lastSyncSummary: text('last_sync_summary', { mode: 'json' }),
    // Set when the last sync failed, cleared when one succeeds. A store that failed to sync must
    // say so rather than keep displaying the previous success.
    lastSyncError: text('last_sync_error'),
    installedAt: integer('installed_at', { mode: 'timestamp_ms' }).notNull().default(now),
    uninstalledAt: integer('uninstalled_at', { mode: 'timestamp_ms' }),
    lastWebhookAt: integer('last_webhook_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('shopify_connections_store_idx').on(table.storeId)],
);

// ─── jobs ────────────────────────────────────────────────────────────
// Tracks one async audit run so the frontend can poll status instead of
// blocking the request. In-process execution for now (no queue infra) —
// see backend-plan / the approved implementation plan §4 for the bullmq
// migration path if run volume ever needs it.
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    type: text('type', { length: 32 }).notNull().default('audit_run'),
    status: text('status', { length: 16 }).notNull().default('queued'),
    // "At most one active job per store" is enforced by the partial unique index below: unique on
    // store_id, but only over rows that are queued or running. That closes the race two concurrent
    // POST /api/audits/run requests would otherwise both pass the in-app check for, and finished
    // jobs never collide. (MySQL needed a generated `active_flag` column to say the same thing.)
    progress: integer('progress').notNull().default(0),
    // What the audit is doing right now, in the merchant's words, with the real counts read so
    // far ("Reading products — 1,250 of 6,762"). Written by the runner as each step actually
    // completes work; null before it starts. Kept after a failure, so it names the step that failed.
    stage: text('stage', { length: 191 }),
    error: text('error'),
    auditId: integer('audit_id').references(() => audits.id, { onDelete: 'set null' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    index('jobs_store_created_idx').on(table.storeId, table.createdAt),
    uniqueIndex('jobs_store_active_unique_idx').on(table.storeId).where(sql`${table.status} IN ('queued', 'running')`),
    check('jobs_status_valid', sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`),
    check('jobs_progress_range', sql`${table.progress} BETWEEN 0 AND 100`),
  ],
);

// ─── page_settings ────────────────────────────────────────────────────
// Persists per-page settings instead of localStorage-only storage.
export const pageSettings = sqliteTable(
  'page_settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    slug: text('slug', { length: 190 }).notNull(),
    values: text('values', { mode: 'json' }).notNull().default({}),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('page_settings_store_slug_idx').on(table.storeId, table.slug),
    index('page_settings_store_updated_idx').on(table.storeId, table.updatedAt),
  ],
);

// ─── schema_templates ─────────────────────────────────────────────────
// One store's configuration for one Schema.org type: whether it is switched on, and where each
// of its properties gets its value from.
//
// A TABLE OF ITS OWN, not another `page_settings` slug. Publishing has to answer "which types are
// enabled for this store?" in one query, and that is a column here rather than a LIKE over slugs
// and a JSON probe. The `properties` blob holds the ValueSource tree, which is the engine's own
// shape (schema-engine/types.ts) and is validated before it is written — never rendered from here.
export const schemaTemplates = sqliteTable(
  'schema_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** A Schema.org type name, e.g. 'Product'. Not an enum: the library grows by data, and the
     * custom builder may emit a type the library does not carry. */
    schemaType: text('schema_type', { length: 64 }).notNull(),
    /** Which Shopify record it renders against — product, collection, page, article or shop. */
    context: text('context', { length: 16 }).notNull(),
    /** Off until the merchant switches it on. Nothing is ever published by default. */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    properties: text('properties', { mode: 'json' }).notNull().default({}),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    // One configuration per type per context per store. The same type legitimately appears in two
    // contexts — BreadcrumbList on a product and on an article are different templates.
    uniqueIndex('schema_templates_store_type_context_idx').on(table.storeId, table.schemaType, table.context),
    index('schema_templates_store_enabled_idx').on(table.storeId, table.enabled),
  ],
);

// ─── ai_fix_proposals ─────────────────────────────────────────────────
// One AI-proposed value for one field of one resource, awaiting a human decision.
//
// This table exists because approval is a SEPARATE request from generation: the merchant reviews
// a preview and comes back. The proposal therefore has to survive between the two, and it has to
// be re-validated on the way out — a row here is a suggestion on record, never an authorisation
// to change anything.
//
// `currentValue` is captured at proposal time so the preview can show current-vs-proposed, and so
// approval can detect that the underlying resource moved on since the proposal was written.
export const aiFixProposals = sqliteTable(
  'ai_fix_proposals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    findingId: integer('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    // Denormalized from the finding's audit so every tenancy check is one predicate, not a join
    // through audits — the authorization path should be the hardest thing in here to get wrong.
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    // 'product' | 'collection' | 'page' | 'article' — see lib/ai/fix-policy.ts.
    resourceType: text('resource_type', { length: 32 }).notNull(),
    resourceId: text('resource_id', { length: 64 }).notNull(),
    // Allow-listed field path, e.g. 'seo.title'. Never free-form.
    field: text('field', { length: 64 }).notNull(),
    currentValue: text('current_value').notNull(),
    proposedValue: text('proposed_value').notNull(),
    /** The model's one-sentence justification, shown beside the diff at approval time. */
    reason: text('reason').notNull(),
    /** The deterministic engine's own suggestion, kept so the preview can show both and so an
     * approval remains possible when AI is later unavailable. */
    deterministicValue: text('deterministic_value'),
    /**
     * proposed → approved → applied, or → rejected / failed.
     * 'approved' and 'applied' are distinct on purpose: approval is the merchant's decision,
     * application is what the fix engine subsequently managed to do with it.
     */
    status: text('status', { length: 16 }).notNull().default('proposed'),
    /** Why an application failed, or why a proposal was rejected by validation. */
    statusDetail: text('status_detail'),
    aiModel: text('ai_model', { length: 64 }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    /** Who approved or rejected it. Null while still awaiting a decision. */
    decidedBy: integer('decided_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('ai_fix_proposals_finding_idx').on(table.findingId),
    index('ai_fix_proposals_store_status_idx').on(table.storeId, table.status),
    // One live proposal per resource+field. A re-run supersedes the old row rather than stacking
    // duplicates the merchant would have to disambiguate.
    uniqueIndex('ai_fix_proposals_target_idx').on(table.findingId, table.resourceType, table.resourceId, table.field),
    check(
      'ai_fix_proposals_status_valid',
      sql`${table.status} IN ('proposed', 'approved', 'applied', 'rejected', 'failed')`,
    ),
  ],
);

// ─── onboarding_state ────────────────────────────────────────────────
// The merchant's answers to the five-step guided setup, one row per store.
//
// WHY A TABLE AND NOT localStorage: the setup is explicitly resumable. A merchant who closes the
// tab on step 3 must come back to step 3 — on any device — and a browser-local draft cannot
// promise that. It also means the audit engine can read the answers, which is the entire point of
// asking.
//
// EVERY ANSWER COLUMN IS NULLABLE, even the ones a merchant cannot finish setup without. A step is
// saved as they work through it, so a half-filled row is a normal state; which answers a step
// REQUIRES is enforced in onboarding.service.ts, not by the column type. Null means "not
// answered", which is materially different from an empty string ("answered, deliberately blank").
// Nothing is back-filled with a guess, and the UI renders what is actually missing rather than a
// default dressed up as the merchant's choice.
//
// WHAT IS *NOT* HERE: the store's name, country, timezone, currency, plan, domain and catalogue
// counts. Shopify already knows all of those and they are read live from the Admin API (see
// onboarding.service.ts → detectShopContext). Copying them in would create a second, staler
// source of truth for facts we do not own.
export const onboardingState = sqliteTable(
  'onboarding_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .unique()
      .references(() => stores.id, { onDelete: 'cascade' }),

    /** 1–5. Where "Resume setup" lands. Advances only past a step whose required answers are in. */
    currentStep: integer('current_step').notNull().default(1),

    // ── Step 1 · Confirm your business ──────────────────────────────
    /** Pre-filled from shop.name, but stored separately: a merchant may trade under a name that
     * differs from the Shopify store name, and correcting it here must not imply a rename there. */
    organizationName: text('organization_name', { length: 255 }),
    /** The brand string as it should appear in generated title tags — often shorter than the
     * organisation name ("Northline" for "Northline Outdoor Supply Co."). */
    brandName: text('brand_name', { length: 255 }),
    /** The canonical storefront origin the merchant confirmed. Usually Shopify's primary domain;
     * stored because a store can serve its canonical content from a domain Shopify does not rank
     * first, and the audit must crawl the one the merchant actually publishes. */
    primaryDomain: text('primary_domain', { length: 512 }),

    // ── Step 2 · What you sell ──────────────────────────────────────
    /**
     * string[] of industry labels from INDUSTRY_OPTIONS.
     *
     * A LIST, not one value. It was `varchar industry`, which forced a store selling both beauty
     * and supplements — or apparel and accessories, which is most of them — to pick the one that
     * decided its checks and discard the rest. Real catalogues span categories, and the answer
     * drives which checks apply, so narrowing it narrowed the audit.
     *
     * json for the same reason the country list is: a short list read as a whole and never
     * queried by element.
     */
    industries: text('industries', { mode: 'json' }),
    /** One line of free text. The most useful single input for generated copy, and the reason the
     * step exists at all — a product taxonomy cannot express "hand-thrown stoneware for cafés". */
    sellsDescription: text('sells_description'),
    /** string[] of BUSINESS_MODELS labels. A list for the same reason as `industries`: a store is
     * routinely DTC *and* wholesale, or subscription *and* made to order. */
    businessModels: text('business_models', { mode: 'json' }),
    catalogShape: text('catalog_shape', { length: 64 }),

    // ── Step 3 · Markets and languages ──────────────────────────────
    /**
     * string[] of country NAMES, not ISO codes — matching `stores.country`, which already holds a
     * name, and matching what Shopify's `billingAddress.country` returns. One vocabulary for
     * countries across the schema beats two that need translating at every boundary.
     *
     * json, not a join table: a short list read as a whole and never queried by element.
     */
    targetCountries: text('target_countries', { mode: 'json' }),
    /** string[] of Shopify locale codes ("en", "fr-CA"). */
    targetLanguages: text('target_languages', { mode: 'json' }),
    /** The country to optimise for when the others conflict — hreflang and canonical strategy
     * need a winner, not a set. */
    primaryMarket: text('primary_market', { length: 128 }),

    // ── Step 4 · Keywords and competitors ───────────────────────────
    /** string[]. Seeded from the merchant's own catalogue, then edited. */
    targetKeywords: text('target_keywords', { mode: 'json' }),
    brandedTerms: text('branded_terms', { mode: 'json' }),
    competitorDomains: text('competitor_domains', { mode: 'json' }),

    // ── Step 5 · Goals and permission to act ────────────────────────
    primaryGoal: text('primary_goal', { length: 64 }),
    /** PillarKey[] in the merchant's own priority order. Order is the data — an unordered set
     * would not tell the dashboard what to lead with. */
    priorityPillars: text('priority_pillars', { mode: 'json' }),
    /**
     * THE WRITE GATE. 'none' | 'ask' | 'low_risk'.
     *
     * Null is not "no preference" — it is "never asked", and both null and 'ask' must behave as
     * ask-first. Nothing may treat an absent answer as consent to write to a merchant's store.
     */
    automationConsent: text('automation_consent', { length: 32 }),
    /** Mapped onto the existing per-user notification toggles when setup completes, so choosing
     * it here actually changes what gets sent rather than recording a preference nothing reads. */
    alertFrequency: text('alert_frequency', { length: 32 }),

    // ── Lifecycle ───────────────────────────────────────────────────
    /**
     * int[] of step numbers the merchant explicitly skipped. LEGACY, and no longer read by
     * anything: steps are mandatory, so a step on this list is in exactly the state an untouched
     * one is — unanswered, and owed before setup can be finished. The column is kept rather than
     * dropped because it records what a merchant was once allowed to pass by.
     */
    skippedSteps: text('skipped_steps', { mode: 'json' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
    /**
     * When the merchant chose "Finish later". LEGACY, like `skipped_steps`: setup is mandatory and
     * that exit is gone, so nothing sets this any more. It is still READ — a merchant who deferred
     * while the option existed keeps their dashboard and resumes from the card on it rather than
     * being redirected into setup — and re-entering setup clears it for good.
     */
    deferredAt: integer('deferred_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    check('onboarding_state_step_range', sql`${table.currentStep} BETWEEN 1 AND 5`),
    check(
      'onboarding_state_consent_valid',
      sql`${table.automationConsent} IS NULL OR ${table.automationConsent} IN ('none', 'ask', 'low_risk')`,
    ),
  ],
);

// ─── ai_discovery_settings ───────────────────────────────────────────
// Per-store inputs the AI Discovery pillar needs and cannot discover on its own.
//
// WHY A TABLE RATHER THAN ENV OR A GUESS: an IndexNow key is a secret-ish string the merchant
// hosts at their own storefront root as `<key>.txt`. There is no discovery mechanism in the
// IndexNow spec — you cannot enumerate a site root — so a checker that was not TOLD the key
// cannot verify anything. Rankvora AI can generate a candidate key (the spec says self-generate),
// but the check only ever reports "verified" after really fetching that file and matching its
// body. The generated string is a credential, never a measurement.
export const aiDiscoverySettings = sqliteTable(
  'ai_discovery_settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .unique()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /**
     * The IndexNow key this store publishes. Null = the merchant has not set one up, which the
     * check reports as "not configured" — a real, actionable state, not a failure to measure.
     * Hex, 8–128 chars, per the IndexNow spec.
     */
    indexNowKey: text('index_now_key', { length: 128 }),
    /** When the key was generated or entered. Shown so a merchant knows how old the setup is. */
    indexNowKeySetAt: integer('index_now_key_set_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
);

// ─── prompt_queries ──────────────────────────────────────────────────
// The questions a merchant wants checked against AI assistants, entered by them.
//
// Rankvora AI does NOT invent these. A generated query list would measure Rankvora AI's guess at what
// shoppers ask, and report the result as the store's AI visibility — which is a fabricated
// measurement wearing a real number's clothes.
export const promptQueries = sqliteTable(
  'prompt_queries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** The merchant's own question, e.g. "best waterproof dog coat uk". */
    query: text('query', { length: 500 }).notNull(),
    /**
     * What counts as the store being mentioned. Defaults to the shop's brand name at creation
     * time, but stored per query because a merchant may trade under a different name than their
     * Shopify store name — matching on the wrong string would under-report every run.
     */
    brandTerm: text('brand_term', { length: 255 }).notNull(),
    /** Paused queries stay in the list (with their history) but are skipped by the sweep. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    index('prompt_queries_store_idx').on(table.storeId, table.active),
    // One row per question per store. Asking the same thing twice doubles the bill for one answer.
    uniqueIndex('prompt_queries_store_query_idx').on(table.storeId, table.query),
  ],
);

// ─── prompt_checks ───────────────────────────────────────────────────
// One recorded observation: this query, asked of this model, at this moment, mentioned the store
// or did not.
//
// EVERY ROW IS A REAL API CALL THAT REALLY HAPPENED. Nothing is back-filled, interpolated or
// seeded. A query with no rows has never been checked, and the pillar reports exactly that
// rather than a zero — those are different facts about a store.
//
// WHY INDIVIDUAL OBSERVATIONS RATHER THAN A ROLLING SCORE: an LLM's answer is non-deterministic.
// The same question asked twice can mention the store once. A single observation is therefore not
// a ranking and must never be presented as one; only the frequency across several real samples
// means anything, and that can only be computed if each sample is kept.
export const promptChecks = sqliteTable(
  'prompt_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    queryId: integer('query_id')
      .notNull()
      .references(() => promptQueries.id, { onDelete: 'cascade' }),
    /** Denormalized for the same reason ai_fix_proposals denormalizes it — one tenancy predicate. */
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** The model actually asked, as the provider named it. Never a family name or a guess. */
    model: text('model', { length: 64 }).notNull(),
    /** True when the answer contained the query's brand term. */
    mentioned: integer('mentioned', { mode: 'boolean' }).notNull(),
    /**
     * The sentence the brand appeared in, quoted verbatim from the model's answer, so a merchant
     * can see WHY it counted. Null when it was not mentioned — there is nothing to quote.
     */
    mentionContext: text('mention_context'),
    /**
     * Where the brand appeared, as a fraction of the answer's length (0 = first character,
     * 1 = last). Null when it was not mentioned.
     *
     * WHY A FRACTION AND NOT A CHARACTER OFFSET: answers vary wildly in length, so offset 400 is
     * near the top of a long answer and near the bottom of a short one. The fraction is comparable
     * across samples; the raw offset is not. Assistants list their strongest recommendations first,
     * so earlier is genuinely better — but this is a POSITION IN ONE ANSWER, never a global rank,
     * and nothing built on it may call it one.
     */
    // MySQL: decimal(5,4). Read back as a string here too, so the code that reads it is unchanged.
    mentionPosition: numeric('mention_position'),
    /**
     * The brand's 1-based ordinal among every tracked brand named in this answer — the store's own
     * plus any competitor the merchant listed during onboarding. 1 means it was named first.
     *
     * Null when the brand was not mentioned, and null when no competitor terms are configured:
     * "1 of 1" is not a rank, it is the absence of a comparison, and storing it as a rank would
     * make every store look like it wins every answer.
     */
    brandRank: integer('brand_rank'),
    /** How many tracked brands were named in this answer — the denominator `brandRank` counts against. */
    brandsNamed: integer('brands_named'),
    /**
     * Which competitors were named, and where. `Array<{ term, position }>` with position on the
     * same 0-1 scale as `mentionPosition`.
     *
     * Only terms the MERCHANT supplied are matched. Rankvora AI never infers a competitor from an
     * answer: extracting brand names from free prose would invent companies, attribute them to the
     * merchant's market, and there would be no way for anyone to tell which were real.
     *
     * An empty array means the answer named none of them. Null means none were configured, which
     * is a different fact and is reported differently.
     */
    competitorsNamed: text('competitors_named', { mode: 'json' }),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    index('prompt_checks_query_idx').on(table.queryId, table.checkedAt),
    index('prompt_checks_store_idx').on(table.storeId, table.checkedAt),
  ],
);
