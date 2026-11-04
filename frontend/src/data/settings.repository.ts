import { api } from '../lib/api';
import type { StoreRow, UserRow } from './api.types';
import type { SettingsState, WorkspaceSettings } from './settings.config';
import { updateCachedUser } from './user.repository';

/** Backend `stores.url` is a full URL (Zod .url()); the UI field is a bare domain. */
const stripProtocol = (url: string) => url.replace(/^https?:\/\//i, '');
const withProtocol = (domain: string) => (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);

/** The workspace fields of a store row — shared by the full load and a refresh from Shopify. */
function toWorkspace(store: StoreRow): WorkspaceSettings {
  return {
    workspaceName: store.workspaceName,
    storeName: store.name,
    storeUrl: stripProtocol(store.url),
    industry: store.industry,
    country: store.country,
    timezone: store.timezone,
    currency: store.currency,
    platform: store.platform,
    shopify: store.shopifyProfile ?? null,
  };
}

function toSettingsState(user: UserRow, store: StoreRow): SettingsState {
  return {
    profile: {
      fullName: user.fullName,
      email: user.email,
      jobTitle: user.jobTitle ?? '',
      role: user.role as SettingsState['profile']['role'],
      // Straight off the real /users/me row (users.created_at).
      createdAt: user.createdAt,
    },
    workspace: toWorkspace(store),
    analysis: {
      autoAnalysis: store.autoAnalysis,
      frequency: store.analysisFrequency as SettingsState['analysis']['frequency'],
      crawlScope: store.crawlScope as SettingsState['analysis']['crawlScope'],
      pageLimit: store.pageLimit,
      includeBlog: store.includeBlog,
      includeCollections: store.includeCollections,
      respectRobots: store.respectRobots,
    },
    notifications: {
      analysisComplete: user.notifyAnalysisComplete,
      criticalIssues: user.notifyCriticalIssues,
      scoreChanges: user.notifyScoreChanges,
      weeklySummary: user.notifyWeeklySummary,
      integrationAlerts: user.notifyIntegrationAlerts,
      productUpdates: user.notifyProductUpdates,
    },
    appearance: {
      density: user.density,
      reduceMotion: user.reduceMotion,
    },
  };
}

/** Reads the connected shop now and fills the workspace from it; values edited by hand are kept. */
export async function refreshWorkspaceFromShopify(): Promise<StoreRow> {
  return api.post<StoreRow>('/stores/current/refresh-from-shopify');
}

/** The industry vocabulary — the same list guided setup offers, from the one place it is defined. */
export async function fetchIndustryOptions(): Promise<string[]> {
  const { industries } = await api.get<{ industries: string[] }>('/stores/profile-options');
  return industries;
}

/** Applies a refreshed store row to the workspace fields of a settings draft. */
export function withStore(settings: SettingsState, store: StoreRow): SettingsState {
  return { ...settings, workspace: toWorkspace(store) };
}

export async function fetchSettings(): Promise<SettingsState> {
  const [user, store] = await Promise.all([
    api.get<UserRow>('/users/me'),
    api.get<StoreRow>('/stores/current'),
  ]);
  return toSettingsState(user, store);
}

export async function persistSettings(next: SettingsState): Promise<SettingsState> {
  const [user, store] = await Promise.all([
    api.put<UserRow>('/users/me', {
      fullName: next.profile.fullName,
      email: next.profile.email,
      jobTitle: next.profile.jobTitle || null,
      notifyAnalysisComplete: next.notifications.analysisComplete,
      notifyCriticalIssues: next.notifications.criticalIssues,
      notifyScoreChanges: next.notifications.scoreChanges,
      notifyWeeklySummary: next.notifications.weeklySummary,
      notifyIntegrationAlerts: next.notifications.integrationAlerts,
      notifyProductUpdates: next.notifications.productUpdates,
      density: next.appearance.density,
      reduceMotion: next.appearance.reduceMotion,
    }),
    api.put<StoreRow>('/stores/current', {
      workspaceName: next.workspace.workspaceName,
      // Sent only when there is one. Before a shop is connected the store has no name or URL, and
      // an empty value is the honest state — not something to validate and reject.
      ...(next.workspace.storeName.trim() ? { name: next.workspace.storeName } : {}),
      ...(next.workspace.storeUrl.trim() ? { url: withProtocol(next.workspace.storeUrl) } : {}),
      // No platform: it is read from the Shopify connection, never chosen here.
      industry: next.workspace.industry,
      country: next.workspace.country,
      timezone: next.workspace.timezone,
      currency: next.workspace.currency,
      autoAnalysis: next.analysis.autoAnalysis,
      analysisFrequency: next.analysis.frequency,
      crawlScope: next.analysis.crawlScope,
      pageLimit: next.analysis.pageLimit,
      includeBlog: next.analysis.includeBlog,
      includeCollections: next.analysis.includeCollections,
      respectRobots: next.analysis.respectRobots,
    }),
  ]);
  updateCachedUser(user);
  return toSettingsState(user, store);
}
