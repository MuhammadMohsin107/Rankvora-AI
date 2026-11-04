import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';

/**
 * ─── Speed · App & script bloat ──────────────────────────────────────
 * Scores third-party load the Admin API can genuinely see:
 *
 *   1. APP EMBED BLOCKS from config/settings_data.json — apps the merchant has switched on in
 *      the theme editor, each of which injects its bundle into every page. Disabled embeds are
 *      listed as evidence (they are one toggle from returning) but do not count against health.
 *   2. EXTERNAL <script src> tags hardcoded in layout/theme.liquid — third-party scripts pasted
 *      into the layout, loading on every single page.
 *
 * HONEST LIMIT, stated in the summary: ScriptTag-API injections and app proxy scripts are only
 * visible with `read_script_tags` or a rendered-page crawl, so the real third-party total can
 * be HIGHER than measured here — never lower. Health means "no always-on third-party load that
 * the Admin API can see", not a certificate of a clean page.
 */

const CLEAN = 'No Always-on Load';
const ACTIVE_EMBED = 'Active App Embed';
const DISABLED_EMBED = 'Disabled App Embed';
const LAYOUT_SCRIPT = 'Layout Script';

/** "shopify://apps/<app-handle>/blocks/..." → the app handle, the part a merchant recognizes. */
function appNameFrom(type: string): string {
  return type.match(/^shopify:\/\/apps\/([^/]+)/)?.[1] ?? type;
}

export const appBloatCheck: AuditCheck = {
  id: 'speed.app-bloat',
  pillar: 'speed',
  subPillar: 'app-bloat',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.theme || !snapshot.theme) {
      return unavailableResult('app-bloat', 'Rankvora AI could not read the store’s theme, so app and script load could not be measured.');
    }
    const { appEmbeds, externalScripts } = snapshot.theme;
    // Null means UNREADABLE, which is unknown — reporting "no apps" on unknown data would be
    // exactly the fabricated pass this engine refuses to produce.
    if (appEmbeds === null && externalScripts === null) {
      return unavailableResult('app-bloat', 'The theme’s settings and layout files could not be parsed, so app load is unknown.');
    }

    const rows: SubPillarEvidenceRow[] = [];
    let activeEmbeds = 0;
    let disabledEmbeds = 0;

    for (const embed of appEmbeds ?? []) {
      const app = appNameFrom(embed.type);
      if (embed.disabled) disabledEmbeds += 1; else activeEmbeds += 1;
      rows.push({
        id: `embed:${embed.type}`,
        status: embed.disabled ? DISABLED_EMBED : ACTIVE_EMBED,
        facet: 'App embed',
        cells: { url: embed.type, pageType: 'App embed', title: app, length: embed.disabled ? 0 : 1 },
        current: { label: 'App embed', value: app, meta: embed.disabled ? 'disabled' : 'enabled — loads on every page' },
      });
    }

    const scripts = externalScripts ?? [];
    for (const src of scripts) {
      let host = src;
      try { host = new URL(src).hostname; } catch { /* keep raw src */ }
      rows.push({
        id: `script:${src}`,
        status: LAYOUT_SCRIPT,
        facet: 'Layout script',
        cells: { url: src, pageType: 'Layout script', title: host, length: 1 },
        current: { label: 'External script', value: host, meta: 'hardcoded in layout/theme.liquid — loads on every page' },
      });
    }

    // The unit is the third-party load source. A store with none analyzed=1 healthy=1 — the
    // clean state is itself a real, positive measurement, not an absence of data.
    const burdens = activeEmbeds + scripts.length;
    if (rows.length === 0) {
      rows.push({
        id: 'app-bloat:clean',
        status: CLEAN,
        facet: 'Summary',
        cells: { url: '—', pageType: 'Summary', title: 'No always-on third-party load detected', length: 0 },
        current: { label: 'Result', value: 'No app embeds or hardcoded external scripts', meta: 'Admin-visible surface only' },
      });
    }

    const analyzed = Math.max(1, (appEmbeds?.length ?? 0) + scripts.length);
    const healthy = Math.max(0, analyzed - burdens);
    const findings: SubPillarFindingResult[] = [];
    const lift = (n: number) => Math.round((n / analyzed) * 100);

    if (activeEmbeds > 0) {
      findings.push({
        title: 'App embeds loading on every page',
        severity: activeEmbeds >= 4 ? 'high' : 'medium',
        affectedCount: activeEmbeds,
        affectedLabel: 'app embeds',
        scoreLift: lift(activeEmbeds),
        resolutionType: 'apps',
        problem: `${formatCount(activeEmbeds)} app embed${activeEmbeds === 1 ? ' is' : 's are'} enabled in the theme.`,
        why: 'Each enabled embed injects its bundle into every page load, whether or not that page uses the feature — app scripts are the most common cause of slow Shopify storefronts.',
        recommendation: 'Review each enabled embed in the theme editor; disable any whose feature is not actively in use.',
        evidence: [(appEmbeds ?? []).filter((e) => !e.disabled).map((e) => appNameFrom(e.type)).join(', ') || '—'],
        details: { issueType: ACTIVE_EMBED },
      });
    }
    if (scripts.length > 0) {
      findings.push({
        title: 'External scripts hardcoded in the theme layout',
        severity: 'medium',
        affectedCount: scripts.length,
        affectedLabel: 'scripts',
        scoreLift: lift(scripts.length),
        resolutionType: 'theme',
        problem: `${formatCount(scripts.length)} third-party script${scripts.length === 1 ? '' : 's'} are hardcoded in layout/theme.liquid.`,
        why: 'Layout scripts run on every page and survive app uninstalls — they are the classic source of orphaned tracking snippets that keep costing load time for a tool nobody uses.',
        recommendation: 'Confirm each script still serves a live integration; move page-specific ones out of the layout and delete orphans.',
        evidence: scripts.slice(0, 5),
        details: { issueType: LAYOUT_SCRIPT },
      });
    }

    return {
      subPillar: 'app-bloat',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(activeEmbeds)} enabled app embed${activeEmbeds === 1 ? '' : 's'}, ${formatCount(disabledEmbeds)} disabled, ${formatCount(scripts.length)} hardcoded external script${scripts.length === 1 ? '' : 's'} in the layout. ScriptTag-API injections need a scope or storefront access Rankvora AI does not have, so the true third-party total can only be equal or higher.`,
        healthChip: burdens === 0 ? 'No always-on load detected' : `${formatCount(burdens)} always-on source${burdens === 1 ? '' : 's'}`,
        contextLabel: 'Always-on sources',
        contextValue: String(burdens),
        healthyStatus: CLEAN,
        evidenceRows: takeEvidenceSample(rows, CLEAN),
      },
      findings,
    };
  },
};
