// ─── Settings · data model ───────────────────────────────────────────
// Types and static option lists / copy only. The actual settings values
// (profile/workspace/analysis/notifications/appearance) are fetched
// from the real API — see data/settings.repository.ts.

/**
 * Whether a settings group is backed by real behaviour in this build.
 * Anything 'preview' renders read-only with an explanation — never a
 * button that looks functional but does nothing.
 */
export type Availability = 'live' | 'preview';

export interface ProfileSettings {
  fullName: string;
  email: string;
  jobTitle: string;
  role: 'Administrator' | 'Editor' | 'Viewer';
  // Server-owned account facts. They are carried in the draft so the Profile panel can render
  // them beside the editable fields, but nothing in the UI writes them — they are echoed back
  // unchanged by every save, which keeps the dirty check (a deep compare of saved vs draft)
  // honest rather than permanently dirty.
  /** ISO timestamp of account creation. */
  createdAt: string;
}

/** What Shopify last reported for the connected shop — see backend store-profile.service.ts. */
export interface ShopifyStoreFacts {
  shopDomain: string;
  name: string | null;
  url: string | null;
  country: string | null;
  currency: string | null;
  timezone: string | null;
  readAt: string;
}

export interface WorkspaceSettings {
  workspaceName: string;
  storeName: string;
  storeUrl: string;
  industry: string;
  country: string;
  timezone: string;
  currency: string;
  // Server-owned, like the profile's createdAt: carried in the draft so the page can show where each
  // value came from, echoed unchanged by every save, and never written from the UI.
  /** 'Shopify' once a shop is connected, 'Not connected' before. A fact, not a choice. */
  platform: string;
  /** Shopify's own values, beside which the page shows "From Shopify" or "Shopify says …". */
  shopify: ShopifyStoreFacts | null;
}

export type AnalysisFrequency = 'Daily' | 'Weekly' | 'Fortnightly' | 'Monthly';
export type CrawlScope = 'Entire store' | 'Products & collections only' | 'Key templates only';

export interface AnalysisSettings {
  autoAnalysis: boolean;
  frequency: AnalysisFrequency;
  crawlScope: CrawlScope;
  pageLimit: number;
  includeBlog: boolean;
  includeCollections: boolean;
  respectRobots: boolean;
}

export interface NotificationSettings {
  analysisComplete: boolean;
  criticalIssues: boolean;
  scoreChanges: boolean;
  weeklySummary: boolean;
  integrationAlerts: boolean;
  productUpdates: boolean;
}

export interface AppearanceSettings {
  density: 'Comfortable' | 'Compact';
  reduceMotion: boolean;
}

export interface SettingsState {
  profile: ProfileSettings;
  workspace: WorkspaceSettings;
  analysis: AnalysisSettings;
  notifications: NotificationSettings;
  appearance: AppearanceSettings;
}

// ─── Option lists ────────────────────────────────────────────────────
// Workspace & store has no hand-written lists any more. Platform is a fact read from the Shopify
// connection (Rankvora AI connects nothing else, so offering WooCommerce or Magento was a choice with
// no effect); timezones, currencies and countries come from the browser's standard data
// (data/referenceLists.ts); industries come from the API, the same vocabulary guided setup uses.
export const frequencyOptions: AnalysisFrequency[] = ['Daily', 'Weekly', 'Fortnightly', 'Monthly'];
export const crawlScopeOptions: CrawlScope[] = ['Entire store', 'Products & collections only', 'Key templates only'];

// ─── Notification copy ───────────────────────────────────────────────
//
// Each toggle carries microcopy explaining exactly what it changes.
//
// EVERY LINE HERE SAID "EMAIL YOU". None of them sent an email — Rankvora AI sends no email at all.
// What these switches actually gate is the in-app bell (see backend notification.service.ts,
// PREFERENCES_BY_TYPE), so that is what they now describe.
//
// The weekly summary is written by backend weekly-summary.service.ts, every Monday in the store's
// timezone. Product updates still say plainly that nothing writes them yet. A switch that has no
// effect in either position is worse than an absent feature, because the customer turns it on and
// believes they will be told.
export const notificationCopy: {
  key: keyof NotificationSettings;
  group: 'Analysis' | 'Account';
  label: string;
  description: string;
  /** False while nothing writes this notification: the switch is shown, disabled, so it cannot be
   * turned on in the belief that it does something. */
  available: boolean;
}[] = [
  {
    key: 'analysisComplete',
    group: 'Analysis',
    label: 'Analysis completed',
    description: 'Show a notification when a scheduled or manual audit finishes and new scores are available. An audit that could not finish is reported while any Analysis switch is on.',
    available: true,
  },
  {
    key: 'criticalIssues',
    group: 'Analysis',
    label: 'Critical issues detected',
    description: 'Notify you as soon as an audit finds a critical-severity issue on any pillar.',
    available: true,
  },
  {
    key: 'scoreChanges',
    group: 'Analysis',
    label: 'Significant score changes',
    description: 'Notify you when a pillar score moves by more than 5 points between audits.',
    available: true,
  },
  {
    key: 'weeklySummary',
    group: 'Analysis',
    label: 'Weekly performance summary',
    description: 'Every Monday, in your store’s timezone: how the overall score moved over the past week, which pillar moved most, and which open issue to start with.',
    available: true,
  },
  {
    key: 'integrationAlerts',
    group: 'Account',
    label: 'Integration problems',
    description: 'Notify you when your Shopify store connects or is uninstalled, a sync fails, its authorization expires, or an audit cannot read your store data.',
    available: true,
  },
  {
    key: 'productUpdates',
    group: 'Account',
    label: 'Rankvora AI product updates',
    description: 'Announcements about new checks, pillars and features. Not available yet — nothing publishes product announcements.',
    available: false,
  },
];

// ─── Plan (no billing backend — presented read-only) ─────────────────
// `usage` was removed rather than updated: every entry was an invented consumption figure
// (1,342 of 2,000 pages, 4 of 6 integrations) rendered as a filled meter, and nothing in the
// product measures those. The Settings card now states that usage tracking is not connected.
/**
 * Rankvora AI has NO billing system: no provider, no subscriptions table, no plan API. Every
 * account is on the same free tier, so "Free plan" is TRUE — but the previous "PKR 0 per
 * month" invented a price and billing cadence for a system that does not exist. This object
 * now states only what is real, and must be replaced by a billing API when one is built.
 */
export const planInfo = {
  name: 'Free',
  price: '',
  cadence: '',
  description: 'All features are currently included. Paid plans are not available yet.',
};
