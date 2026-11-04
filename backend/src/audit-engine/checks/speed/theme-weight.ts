import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';

/**
 * ─── Speed · Theme weight / fonts / lazy-load ────────────────────────
 * Scores the MAIN theme's shippable payload from real Admin API data: every file under
 * `assets/` with its byte size (read via the already-granted `read_themes` scope).
 *
 * WHAT IS MEASURED: the theme's own JS, CSS and font assets — the code the theme can serve to
 * every visitor. Individual heavy files are the unit: one 300KB script is one problem with one
 * owner, which is more actionable than a single opaque total.
 *
 * HONEST LIMITS, disclosed in the summary:
 *   · Which assets a given page actually loads (and lazy-loading behaviour) is a rendered-page
 *     question — storefront access required. This check scores what EXISTS in the theme.
 *   · Sizes are pre-compression bytes as stored; CDN gzip/brotli will deliver less. Thresholds
 *     are set with that in mind.
 *
 * THRESHOLDS (heuristics, documented, not ranking rules):
 *   JS  file  > 100 KB   Heavy Script
 *   CSS file  > 120 KB   Heavy Stylesheet
 *   font file > 150 KB   Heavy Font (usually an unsubset family)
 */

const JS_HEAVY_BYTES = 100 * 1024;
const CSS_HEAVY_BYTES = 120 * 1024;
const FONT_HEAVY_BYTES = 150 * 1024;

const LEAN = 'Lean';
const HEAVY_SCRIPT = 'Heavy Script';
const HEAVY_CSS = 'Heavy Stylesheet';
const HEAVY_FONT = 'Heavy Font';

type Kind = 'js' | 'css' | 'font' | 'other';

function kindOf(filename: string, contentType: string | null): Kind {
  if (/\.(js|mjs)(\.liquid)?$/i.test(filename) || /javascript/i.test(contentType ?? '')) return 'js';
  if (/\.css(\.liquid)?$/i.test(filename) || /text\/css/i.test(contentType ?? '')) return 'css';
  if (/\.(woff2?|ttf|otf|eot)$/i.test(filename) || /font/i.test(contentType ?? '')) return 'font';
  return 'other';
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export const themeWeightCheck: AuditCheck = {
  id: 'speed.theme-weight',
  pillar: 'speed',
  subPillar: 'theme-weight',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.theme || !snapshot.theme) {
      return unavailableResult('theme-weight', 'Rankvora AI could not read the store’s theme, so theme weight could not be measured.');
    }

    // Only code/font payload is scored; theme images are merchandising content with their own
    // sub-pillar, and scoring them here would double-count.
    const assets = snapshot.theme.assets
      .map((asset) => ({ ...asset, kind: kindOf(asset.filename, asset.contentType) }))
      .filter((asset) => asset.kind !== 'other');

    if (assets.length === 0) {
      return unavailableResult('theme-weight', 'The theme exposes no JS, CSS or font assets to measure.');
    }

    const counts: Record<string, number> = { [LEAN]: 0, [HEAVY_SCRIPT]: 0, [HEAVY_CSS]: 0, [HEAVY_FONT]: 0 };
    const rows: SubPillarEvidenceRow[] = [];
    const totals = { js: 0, css: 0, font: 0 };

    for (const asset of assets) {
      totals[asset.kind as 'js' | 'css' | 'font'] += asset.size;
      const status =
        asset.kind === 'js' && asset.size > JS_HEAVY_BYTES ? HEAVY_SCRIPT
        : asset.kind === 'css' && asset.size > CSS_HEAVY_BYTES ? HEAVY_CSS
        : asset.kind === 'font' && asset.size > FONT_HEAVY_BYTES ? HEAVY_FONT
        : LEAN;
      counts[status] += 1;

      rows.push({
        id: `asset:${asset.filename}`,
        status,
        facet: asset.kind.toUpperCase(),
        cells: {
          url: asset.filename,
          pageType: asset.kind.toUpperCase(),
          title: asset.filename.replace(/^assets\//, ''),
          length: Math.round(asset.size / 1024),
        },
        current: { label: 'Asset size', value: kb(asset.size), meta: asset.filename },
      });
    }

    const analyzed = assets.length;
    const healthy = counts[LEAN];
    const findings: SubPillarFindingResult[] = [];
    const lift = (n: number) => Math.round((n / analyzed) * 100);

    const heavyEntries: Array<[string, string, number, string]> = [
      [HEAVY_SCRIPT, 'scripts', JS_HEAVY_BYTES, 'Large scripts block the main thread while they parse and execute; splitting or deferring them is usually the single biggest theme-side win.'],
      [HEAVY_CSS, 'stylesheets', CSS_HEAVY_BYTES, 'Oversized stylesheets delay first render on every page, since CSS blocks paint until it is downloaded and parsed.'],
      [HEAVY_FONT, 'font files', FONT_HEAVY_BYTES, 'Fonts this large are usually unsubset full families; the browser stalls text rendering while they download.'],
    ];
    for (const [status, noun, threshold, why] of heavyEntries) {
      if (counts[status] === 0) continue;
      findings.push({
        title: `Theme ${noun} over ${Math.round(threshold / 1024)} KB`,
        severity: 'medium',
        affectedCount: counts[status],
        affectedLabel: noun,
        scoreLift: lift(counts[status]),
        resolutionType: 'theme',
        problem: `${formatCount(counts[status])} theme ${noun} exceed ${Math.round(threshold / 1024)} KB each.`,
        why,
        recommendation: `Minify, split, subset or lazy-load the flagged ${noun}; remove any that no template still uses.`,
        evidence: [`${formatCount(counts[status])} of ${formatCount(analyzed)} theme assets are over the ${noun} threshold.`],
        details: { issueType: status },
      });
    }

    return {
      subPillar: 'theme-weight',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} theme assets are lean (${snapshot.theme.name ? `theme “${snapshot.theme.name}”: ` : ''}JS ${kb(totals.js)}, CSS ${kb(totals.css)}, fonts ${kb(totals.font)}). Sizes are stored bytes from the Admin API; per-page loading and lazy-load behaviour need storefront access and are not claimed here.${snapshot.theme.assetsTruncated ? ' Asset listing was truncated.' : ''}`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Total JS + CSS',
        contextValue: kb(totals.js + totals.css),
        healthyStatus: LEAN,
        evidenceRows: takeEvidenceSample(rows, LEAN),
      },
      findings,
    };
  },
};
