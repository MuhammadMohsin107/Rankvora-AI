// ─── The catalog: the latest audit, one row per product / collection / article ───
//
// A DIFFERENT VIEW OF MEASUREMENTS THAT ALREADY EXIST, not a new measurement. Every check that looks
// at a product, a collection or an article records one evidence row per item (`product:<id>`,
// `collection:<id>`, `article:<id>` — or `productImage:<id>/<media>` for the per-image alt-text
// check), and each sub-pillar page already reads those rows from /audits/latest/:pillar/:subPillar.
// This module reads the same endpoints and turns the rows sideways: instead of "which items failed
// this check", "which checks did this item fail". One implementation serves all three kinds; what
// differs between them is in data/catalogKinds.ts.
//
// Nothing is computed that the checks did not decide. An item's verdict per check is the row's own
// status; its severity is the severity of the finding that owns that status (the same lookup the
// sub-pillar evidence table uses); a photo is the image URL a check recorded; a date is the date a
// check recorded. An item a check did not record is "not recorded" for that check — never a pass, and
// a fact no check recorded (a photo, a date, a count) is null — never a stand-in.

import { api, ApiError } from '../lib/api';
import type { PillarKey } from './dashboard/dashboard.types';
import { pillarMeta, subPillarLabel } from './pillarMeta';
import { findingForRow, isIssueStatus, severityForStatus, type EvidenceRow, type Severity, type SubPillarFinding } from './seo/subpillar.model';
import { isNotAuditedYet } from './seo/subpillar.repository';
import { CATALOG_KINDS, CATALOG_KIND_LIST, routesOf, type CatalogKind, type CatalogKindConfig } from './catalogKinds';

export type ItemVerdict = 'passing' | 'warning' | 'critical';

export interface CatalogCheckResult {
  /** "seo/title-tags" */
  key: string;
  label: string;
  pillar: PillarKey;
  pillarLabel: string;
  /** The sub-pillar page, where this item's row sits in the evidence table. */
  route: string;
  /** The evidence row's id ("product:123") — what a fix is aimed at. */
  rowId: string;
  verdict: ItemVerdict;
  /** The finding's severity for a failing row; null when the item passed. */
  severity: Severity | null;
  /** The check's own word for this item ("Too Long", "Complete", "Missing price"). */
  status: string;
  /** The check's one-line explanation for this item, when it wrote one. */
  detail: string | null;
  /**
   * The title of the finding this failing row belongs to ("Products with no image alt text at
   * all") — the same title the dashboard's Winning moves list shows, which is how a move is matched
   * to the items it names. Null for a passing row.
   */
  findingTitle: string | null;
  /**
   * The finding that owns this failing row. With `rowId` it is the anchor a fix is applied through:
   * the server re-derives that finding's own evidence and refuses a row that is not among it. Null
   * for a passing row.
   */
  findingId: string | null;
  /** What the check read for this item, in its own words ("Current title": "…"). */
  current: { label: string; value: string; meta?: string } | null;
  /** The value the check itself proposed from the store's own data, when it proposed one. */
  suggested: { label: string; value: string } | null;
  /** The check's own advice for this item, when it wrote one. */
  recommendation: string | null;
}

/** One product image as the alt-text check recorded it. */
export interface CatalogImage {
  /** The evidence row's id (`productImage:<product>/<media>`). */
  id: string;
  src: string | null;
  /** The image's description as the store has it; '' when it has none. */
  alt: string;
  /** 1-based place in the product's gallery, when recorded. */
  position: number | null;
  /** The finding that owns this image while its alt text is flagged — the anchor a fix is applied through. Null when it is not flagged. */
  findingId: string | null;
}

export interface CatalogItem {
  /** Shopify's numeric id, as the checks recorded it. */
  id: string;
  /** The item's title as a check recorded it. Null only if no check wrote one. */
  name: string | null;
  url: string | null;
  /** The item's photo: a product's first image, a collection's or an article's featured image. Null when none was recorded. */
  imageSrc: string | null;
  /** A product's images as the alt-text check recorded them, in gallery order. Empty for the other kinds. */
  images: CatalogImage[];
  /** How many images a product has, as the media or alt-text check counted them. Null when neither did (and for the other kinds). */
  imageCount: number | null;
  /** When Shopify last recorded a change to the item, as a check recorded it. Null when not recorded. */
  updatedAt: string | null;
  /** When an article was published, as the freshness check recorded it. Null when not recorded (and for the other kinds). */
  publishedAt: string | null;
  /** How many products a collection holds, as the description check recorded it. Null when not recorded (and for the other kinds). */
  productCount: number | null;
  /** Product type and vendor as Shopify has them, carried on the alt-text check's rows. Null when not recorded (and for the other kinds). */
  productType: string | null;
  vendor: string | null;
  checks: CatalogCheckResult[];
  critical: number;
  warnings: number;
  passing: number;
  /** Share of this item's recorded checks it passed, 0-100. A count, not a weighted model. */
  passRate: number;
}

export interface Catalog {
  items: CatalogItem[];
  /** Checks that returned rows for this audit. */
  checksRead: Array<{ key: string; label: string; pillarLabel: string }>;
  /** Checks that could not contribute, with the reason the server or the check gave. */
  checksUnavailable: Array<{ key: string; label: string; reason: string }>;
  lastAnalyzed: string | null;
}

interface LiveSubPillarRows {
  findings: SubPillarFinding[];
  evidenceRows: EvidenceRow[];
  healthyStatus?: string;
  lastAnalyzed: string;
  status?: 'ok' | 'unavailable';
  unavailableReason?: string | null;
}

/** `product:123` → 123 · `productImage:123/456` → 123 (products only) · another kind's row → null. */
function itemIdOf(config: CatalogKindConfig, rowId: string): string | null {
  const own = new RegExp(`^${config.rowPrefix}:([^/:]+)$`).exec(rowId);
  if (own) return own[1];
  if (config.kind === 'product') {
    const image = /^productImage:([^/:]+)\/[^/:]+$/.exec(rowId);
    if (image) return image[1];
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Each check names the item in its own column — the first one present is the item's title. */
const NAME_CELLS = ['name', 'product', 'collection', 'article', 'surface', 'signal', 'page', 'title', 'label'];

function nameOf(row: EvidenceRow): string | null {
  for (const key of NAME_CELLS) {
    const value = text(row.cells[key]);
    if (value) return value;
  }
  return null;
}

function urlOf(row: EvidenceRow): string | null {
  const cell = text(row.cells.url);
  if (cell) return cell;
  const meta = text(row.current?.meta);
  return meta && (meta.startsWith('http') || meta.startsWith('/')) ? meta : null;
}

/**
 * A row whose own words say the check reached no verdict ("Availability not measured"). The check
 * files it under a failing status so its table can show it, but it is not a problem found in the
 * item — counting it as a warning would report a measurement that did not happen.
 */
function isUnmeasured(row: EvidenceRow): boolean {
  const said = [row.status, row.cells.detail, row.cells.issue, row.current?.value].filter((value) => typeof value === 'string') as string[];
  return said.some((value) => /\bnot measured\b/i.test(value));
}

const verdictRank: Record<ItemVerdict, number> = { passing: 0, warning: 1, critical: 2 };
const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const CACHE_MS = 2 * 60 * 1000;
const cache = new Map<CatalogKind, { at: number; promise: Promise<Catalog> }>();

/** Forgets what was read, so the next read is fresh — after a fix has changed the store. */
export function invalidateCatalogs(): void {
  cache.clear();
}

/**
 * Reads every check of one kind of the latest audit and regroups its rows by item.
 *
 * Throws the server's ApiError when the store has no audit at all, so the page can show its
 * first-run state; a single check that cannot be read is listed in `checksUnavailable` instead.
 * Opening an item from the list, and coming back, does not re-read every endpoint each way: the
 * list's Reload asks for a fresh read, and anything older than two minutes is re-read.
 */
export async function fetchCatalog(kind: CatalogKind, options: { fresh?: boolean } = {}): Promise<Catalog> {
  const hit = cache.get(kind);
  if (!options.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = readCatalog(CATALOG_KINDS[kind]);
  cache.set(kind, { at: Date.now(), promise });
  promise.catch(() => { if (cache.get(kind)?.promise === promise) cache.delete(kind); });
  return promise;
}

async function readCatalog(config: CatalogKindConfig): Promise<Catalog> {
  const settled = await Promise.allSettled(
    config.checks.map(({ pillar, subPillar }) => api.get<LiveSubPillarRows>(`/audits/latest/${pillar}/${subPillar}`)),
  );

  // Every check failed: a store with no audit is the first-run state, not a broken page.
  if (settled.every((result) => result.status === 'rejected')) {
    const first = (settled[0] as PromiseRejectedResult).reason;
    throw first instanceof ApiError ? first : new Error('The latest audit could not be read.');
  }

  const byId = new Map<string, CatalogItem & { imagePosition: number }>();
  const checksRead: Catalog['checksRead'] = [];
  const checksUnavailable: Catalog['checksUnavailable'] = [];
  let lastAnalyzed: string | null = null;

  settled.forEach((result, index) => {
    const { pillar, subPillar } = config.checks[index];
    const key = `${pillar}/${subPillar}`;
    const label = subPillarLabel(pillar, subPillar);
    const pillarLabel = pillarMeta[pillar].label;

    if (result.status === 'rejected') {
      const reason = result.reason;
      checksUnavailable.push({
        key,
        label,
        reason: isNotAuditedYet(reason) ? 'Not in the latest audit.' : reason instanceof Error ? reason.message : 'Could not be read.',
      });
      return;
    }
    const data = result.value;
    lastAnalyzed = lastAnalyzed ?? data.lastAnalyzed;
    if (data.status === 'unavailable') {
      checksUnavailable.push({ key, label, reason: data.unavailableReason ?? 'This check could not measure the store.' });
      return;
    }
    checksRead.push({ key, label, pillarLabel });

    // One verdict per item per check. The alt-text check writes a row per IMAGE, all carrying the
    // product's verdict; the worst one stands, so two rows can never count as two checks.
    const perItem = new Map<string, CatalogCheckResult>();
    for (const row of data.evidenceRows ?? []) {
      const id = itemIdOf(config, row.id);
      if (!id) continue;

      const entry: CatalogItem & { imagePosition: number } = byId.get(id) ?? {
        id, name: null, url: null, imageSrc: null, imagePosition: Infinity, images: [], imageCount: null, updatedAt: null,
        publishedAt: null, productCount: null, productType: null, vendor: null,
        checks: [], critical: 0, warnings: 0, passing: 0, passRate: 0,
      };
      entry.name = entry.name ?? nameOf(row);
      entry.url = entry.url ?? urlOf(row);

      // Facts a check recorded on its row without making them a column. Each is null until some
      // check records it; the first one recorded stands.
      const imageSrc = text(row.cells.imageSrc);
      const position = typeof row.cells.position === 'number' ? row.cells.position : Infinity;
      if (imageSrc && position < entry.imagePosition) {
        entry.imageSrc = imageSrc;
        entry.imagePosition = position;
      } else if (imageSrc && !entry.imageSrc) {
        entry.imageSrc = imageSrc;
      }
      entry.updatedAt = entry.updatedAt ?? text(row.cells.updatedAt);
      entry.publishedAt = entry.publishedAt ?? text(row.cells.publishedAt);
      if (typeof row.cells.productCount === 'number' && entry.productCount === null) entry.productCount = row.cells.productCount;

      if (config.kind === 'product') {
        // The gallery, one row per image, from the alt-text check — the only check that records them.
        if (key === 'seo/image-alt-text' && row.id.startsWith('productImage:') && !entry.images.some((image) => image.id === row.id)) {
          entry.images.push({
            id: row.id,
            src: imageSrc,
            alt: typeof row.cells.alt === 'string' ? row.cells.alt : '',
            position: Number.isFinite(position) ? position : null,
            // The check stamps every image of a partly-described product with the product's verdict,
            // so an image is only "flagged" — and offered a fix — when its OWN alt text is empty.
            findingId: typeof row.cells.alt === 'string' && row.cells.alt.trim() !== ''
              ? null
              : isIssueStatus(row.status, data.healthyStatus) ? findingForRow(row, data.findings, data.healthyStatus)?.id ?? null : null,
          });
        }
        const counted = key === 'content/media-richness' ? row.cells.images : key === 'seo/image-alt-text' ? row.cells.imageCount : undefined;
        if (typeof counted === 'number' && entry.imageCount === null) entry.imageCount = counted;
        if (key === 'seo/image-alt-text') {
          entry.productType = entry.productType ?? text(row.cells.productType);
          entry.vendor = entry.vendor ?? text(row.cells.vendor);
        }
      }
      byId.set(id, entry);

      if (isUnmeasured(row)) continue;
      const failing = isIssueStatus(row.status, data.healthyStatus);
      const severity = failing ? severityForStatus(row.status, data.findings, data.healthyStatus) : 'healthy';
      const verdict: ItemVerdict = !failing ? 'passing' : severity === 'critical' ? 'critical' : 'warning';
      const owner = failing ? findingForRow(row, data.findings, data.healthyStatus) : undefined;
      const candidate: CatalogCheckResult = {
        key,
        label,
        pillar,
        pillarLabel,
        route: `/${pillar}/${subPillar}`,
        rowId: row.id,
        verdict,
        severity: severity === 'healthy' ? null : severity,
        status: row.status,
        detail: text(row.cells.detail) ?? text(row.cells.issue) ?? text(row.cells.signal !== entry.name ? row.cells.signal : null) ?? null,
        findingTitle: owner?.title ?? null,
        findingId: owner?.id ?? null,
        current: row.current && text(row.current.value) ? row.current : null,
        suggested: row.suggested && text(row.suggested.value) ? row.suggested : null,
        recommendation: text(row.cells.recommendation),
      };
      const existing = perItem.get(id);
      if (!existing || verdictRank[candidate.verdict] > verdictRank[existing.verdict]) perItem.set(id, candidate);
    }
    for (const [id, check] of perItem) byId.get(id)?.checks.push(check);
  });

  const items: CatalogItem[] = [...byId.values()]
    .filter((item) => item.checks.length > 0)
    .map(({ imagePosition: _imagePosition, ...item }) => {
      const critical = item.checks.filter((check) => check.verdict === 'critical').length;
      const warnings = item.checks.filter((check) => check.verdict === 'warning').length;
      const passing = item.checks.filter((check) => check.verdict === 'passing').length;
      // Failing checks first, most severe first; then the passes.
      const checks = [...item.checks].sort((a, b) =>
        verdictRank[b.verdict] - verdictRank[a.verdict]
        || (a.severity && b.severity ? severityRank[a.severity] - severityRank[b.severity] : 0)
        || a.label.localeCompare(b.label));
      return {
        ...item,
        images: [...item.images].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity)),
        checks,
        critical,
        warnings,
        passing,
        passRate: Math.round((passing / item.checks.length) * 100),
      };
    });

  return { items, checksRead, checksUnavailable, lastAnalyzed };
}

// ─── Winning moves ↔ items ───────────────────────────────────────────

const KIND_ROUTES = new Map(CATALOG_KIND_LIST.map((config) => [config.kind, routesOf(config)]));

/**
 * Which kind of item a Winning move (a dashboard finding) is about, so that kind's list can be
 * filtered to it — or null when it is about none: its sub-pillar is one of the kind's checks and
 * what it counted is that kind's items ("11 of 12 products").
 */
export function catalogKindOfMove(move: { route: string; affectedLabel: string }): CatalogKind | null {
  for (const config of CATALOG_KIND_LIST) {
    if (KIND_ROUTES.get(config.kind)?.has(move.route) && config.nounPattern.test(move.affectedLabel)) return config.kind;
  }
  return null;
}

/** The items a move names: those whose row in that check belongs to that same finding. */
export function itemsForMove(items: CatalogItem[], move: { route: string; title: string }): CatalogItem[] {
  return items.filter((item) => item.checks.some((check) => check.route === move.route && check.findingTitle === move.title));
}

/** "/products?area=seo/title-tags&issue=…" — a kind's list filtered to one move, as a link. */
export function catalogLinkForMove(kind: CatalogKind, move: { route: string; title: string }): string {
  const params = new URLSearchParams({ area: move.route.replace(/^\//, ''), issue: move.title });
  return `${CATALOG_KINDS[kind].listPath}?${params.toString()}`;
}
