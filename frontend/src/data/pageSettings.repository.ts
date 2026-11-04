import { api } from '../lib/api';
import { getDefaultSubPillarSettings, type PageSettingValue } from './pageSettings.registry';

/**
 * A slug may carry a pillar prefix ('speed/cwv', 'ai-discovery/feed') or not ('title-tags').
 *
 * The prefixed form is sent as TWO path segments, matching the API's `/:pillar/:subPillar` route.
 * It used to be percent-encoded into one segment, which Express itself handles correctly — but the
 * edge proxy in front of the API normalises `%2F` back to a real slash before forwarding, so the
 * request arrived as two segments, matched no route, and every generic sub-pillar page logged
 * "Failed to load page settings" with a 404 and quietly fell back to defaults. Saving a setting
 * failed the same way.
 *
 * Each segment is still encoded individually, so a slug containing anything unusual stays safe.
 */
const settingsPath = (slug: string) =>
  `/page-settings/${slug.split('/').map(encodeURIComponent).join('/')}`;

/** Stored values merged over the registry defaults, so new fields always have a value. */
export async function fetchSubPillarSettings(slug: string): Promise<Record<string, PageSettingValue>> {
  const { values } = await api.get<{ slug: string; values: Record<string, PageSettingValue> }>(settingsPath(slug));
  return { ...getDefaultSubPillarSettings(slug), ...values };
}

export async function saveSubPillarSettings(slug: string, values: Record<string, PageSettingValue>): Promise<void> {
  await api.put(settingsPath(slug), { values });
}
