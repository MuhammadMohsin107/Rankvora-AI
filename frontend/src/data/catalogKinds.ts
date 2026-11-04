import { isCheckVisible, isPillarVisible } from '../config/modules';
import type { PillarKey } from './dashboard/dashboard.types';

/**
 * ─── The store's catalog, three kinds ────────────────────────────────
 *
 * Products, Collections and Blog articles are ONE feature configured three times: the same
 * repository regroups the audit's rows, the same list page and the same detail page show them. What
 * differs between the kinds is written down here and nowhere else — which checks record a verdict
 * for that kind, what its evidence-row ids look like, how its detail page is sectioned, and the
 * words the page uses. Nothing in this file is a measurement: it is structure and copy.
 */

export type CatalogKind = 'product' | 'collection' | 'article';

export interface CatalogSectionConfig {
  id: string;
  title: string;
  /** Check keys ("seo/title-tags") that belong in this section. None for a section made of facts. */
  checks: string[];
}

export interface CatalogKindConfig {
  kind: CatalogKind;
  /** The evidence rows' id prefix — `product:123`, `collection:45`, `article:6`. */
  rowPrefix: 'product' | 'collection' | 'article';
  /**
   * The checks that record a verdict per item of this kind: the endpoints to read, not data. The
   * SEO checks also record other kinds of page; only this kind's own rows are read from them.
   */
  checks: { pillar: PillarKey; subPillar: string }[];

  // ── words ──
  noun: string;
  nouns: string;
  /** Sidebar label, list-page crumb and "Back to …". */
  navLabel: string;
  listPath: string;
  /** Matches what a finding counted ("11 of 12 products"), to tell a move about this kind. */
  nounPattern: RegExp;
  overviewTitle: string;
  overviewSubtitle: string;
  /** The tab that shows every item: "All products". */
  allTab: string;
  searchPlaceholder: string;
  /** Column heading of the list. */
  column: string;
  emptyTitle: string;
  emptyBody: string;
  noRowsBody: string;
  /** One item's page. */
  errorTitle: string;
  notFoundTitle: string;
  notFoundBody: string;
  resultTitle: string;
  /** How the detail page is sectioned. */
  sections: CatalogSectionConfig[];
  /** Check keys whose `current` value is the item's own text, shown as a read-only field. */
  fieldChecks: string[];
}

/** A check whose finding Rankvora AI can fix from inside the app. */
export interface FixableCheck {
  /** The field it writes, in the merchant's words. */
  field: string;
  /** Where a draft value comes from: a model, or the merchant's own template. */
  draft: 'ai' | 'template';
  /** Fixed image by image in the gallery, not in the check's own callout. */
  perImage?: boolean;
}

/**
 * The checks whose finding Rankvora AI can FIX from inside the app. A check is offered an editor only
 * when it is listed here AND the server says its sub-pillar is writable (audits.capabilities →
 * FIELD_RULES): this is only the wording and the draft source, so a field added on the server needs
 * one line here to be named, and nothing here can claim a write the server does not allow. Every
 * other check is diagnosed on the page and not repaired — the page says so.
 */
export const FIXABLE_CHECKS: Record<string, FixableCheck> = {
  'seo/title-tags': { field: 'SEO title', draft: 'ai' },
  'seo/meta-descriptions': { field: 'SEO meta description', draft: 'ai' },
  'seo/image-alt-text': { field: 'Image alt text', draft: 'template', perImage: true },
};

/** The bare sub-pillar of a check key: "seo/title-tags" → "title-tags", as the server's capability list names it. */
export const subPillarOfCheck = (key: string): string => key.slice(key.indexOf('/') + 1);

const SEO_PAIR = ['seo/title-tags', 'seo/meta-descriptions'];

const KIND_CONFIGS: Record<CatalogKind, CatalogKindConfig> = {
  product: {
    kind: 'product',
    rowPrefix: 'product',
    checks: [
      { pillar: 'seo', subPillar: 'title-tags' },
      { pillar: 'seo', subPillar: 'meta-descriptions' },
      { pillar: 'seo', subPillar: 'image-alt-text' },
      { pillar: 'content', subPillar: 'product-descriptions' },
      { pillar: 'content', subPillar: 'dup-templated' },
      { pillar: 'content', subPillar: 'media-richness' },
      { pillar: 'cro', subPillar: 'options' },
      { pillar: 'cro', subPillar: 'subscription' },
      { pillar: 'ai-discovery', subPillar: 'agentic-attrs' },
      { pillar: 'ai-discovery', subPillar: 'feed' },
      { pillar: 'ai-discovery', subPillar: 'answerable-qa' },
    ],
    noun: 'product',
    nouns: 'products',
    navLabel: 'Products',
    listPath: '/products',
    nounPattern: /product/i,
    overviewTitle: 'Product issues overview',
    overviewSubtitle: 'Stay on top of your catalog’s health — review what each product is missing, then open it to fix.',
    allTab: 'All products',
    searchPlaceholder: 'Search products',
    column: 'Product',
    emptyTitle: 'No product results yet',
    emptyBody: 'Once an audit has run, every product it checked appears here with what it is missing. Nothing on this page is estimated.',
    noRowsBody: 'The latest audit recorded no product rows. Run an audit once your store has products.',
    errorTitle: 'Unable to load products',
    notFoundTitle: 'Product not in the latest audit',
    notFoundBody: 'The latest audit did not record this product. It may have been removed, or fallen outside the checks’ sample on a large catalog.',
    resultTitle: 'Product checks passed',
    // The product's checks, grouped the way a store-health app's product page groups them.
    sections: [
      { id: 'basic', title: 'Basic information', checks: ['content/product-descriptions', 'content/dup-templated'] },
      { id: 'seo', title: 'Search engine listing', checks: SEO_PAIR },
      { id: 'media', title: 'Media', checks: ['seo/image-alt-text', 'content/media-richness'] },
      { id: 'organization', title: 'Product organization', checks: [] },
      { id: 'offer', title: 'Options & offers', checks: ['cro/options', 'cro/subscription'] },
      { id: 'ai', title: 'AI visibility & structured data', checks: ['ai-discovery/agentic-attrs', 'ai-discovery/feed', 'ai-discovery/answerable-qa'] },
    ],
    fieldChecks: ['content/product-descriptions'],
  },

  collection: {
    kind: 'collection',
    rowPrefix: 'collection',
    checks: [
      { pillar: 'seo', subPillar: 'title-tags' },
      { pillar: 'seo', subPillar: 'meta-descriptions' },
      { pillar: 'content', subPillar: 'collection-descriptions' },
    ],
    noun: 'collection',
    nouns: 'collections',
    navLabel: 'Collections',
    listPath: '/collections',
    nounPattern: /collection/i,
    overviewTitle: 'Collection issues overview',
    overviewSubtitle: 'Stay on top of your collections’ health — review what each one is missing, then open it to fix.',
    allTab: 'All collections',
    searchPlaceholder: 'Search collections',
    column: 'Collection',
    emptyTitle: 'No collection results yet',
    emptyBody: 'Once an audit has run, every collection it checked appears here with what it is missing. Nothing on this page is estimated.',
    noRowsBody: 'The latest audit recorded no collection rows. Run an audit once your store has collections.',
    errorTitle: 'Unable to load collections',
    notFoundTitle: 'Collection not in the latest audit',
    notFoundBody: 'The latest audit did not record this collection. It may have been removed, or fallen outside the checks’ sample on a large store.',
    resultTitle: 'Collection checks passed',
    sections: [
      { id: 'basic', title: 'Description', checks: ['content/collection-descriptions'] },
      { id: 'seo', title: 'Search engine listing', checks: SEO_PAIR },
    ],
    fieldChecks: ['content/collection-descriptions'],
  },

  article: {
    kind: 'article',
    rowPrefix: 'article',
    checks: [
      { pillar: 'seo', subPillar: 'title-tags' },
      { pillar: 'seo', subPillar: 'meta-descriptions' },
      { pillar: 'content', subPillar: 'blog-freshness' },
    ],
    noun: 'article',
    nouns: 'articles',
    navLabel: 'Blog articles',
    listPath: '/blog-articles',
    nounPattern: /article|post/i,
    overviewTitle: 'Blog article issues overview',
    overviewSubtitle: 'Stay on top of your blog’s health — review what each article is missing or has let go stale, then open it to fix.',
    allTab: 'All articles',
    searchPlaceholder: 'Search articles',
    column: 'Article',
    emptyTitle: 'No blog article results yet',
    emptyBody: 'Once an audit has run, every blog article it checked appears here with what it is missing. Nothing on this page is estimated.',
    noRowsBody: 'The latest audit recorded no blog article rows. Run an audit once your store has blog articles.',
    errorTitle: 'Unable to load blog articles',
    notFoundTitle: 'Article not in the latest audit',
    notFoundBody: 'The latest audit did not record this article. It may have been removed, or fallen outside the checks’ sample on a large blog.',
    resultTitle: 'Article checks passed',
    sections: [
      { id: 'freshness', title: 'Freshness', checks: ['content/blog-freshness'] },
      { id: 'seo', title: 'Search engine listing', checks: SEO_PAIR },
    ],
    fieldChecks: [],
  },
};

/**
 * A kind's config as the customer may see it: the checks of a pillar switched off in
 * config/modules.ts are not read, and a section that held only such checks is not shown. The
 * listing above is untouched, so switching the pillar back on restores them with no other change.
 */
function visibleOnly(config: CatalogKindConfig): CatalogKindConfig {
  return {
    ...config,
    checks: config.checks.filter(({ pillar }) => isPillarVisible(pillar)),
    sections: config.sections
      .map((section) => ({ ...section, checks: section.checks.filter(isCheckVisible) }))
      .filter((section, index) => section.checks.length > 0 || config.sections[index].checks.length === 0),
    fieldChecks: config.fieldChecks.filter(isCheckVisible),
  };
}

export const CATALOG_KINDS: Record<CatalogKind, CatalogKindConfig> = {
  product: visibleOnly(KIND_CONFIGS.product),
  collection: visibleOnly(KIND_CONFIGS.collection),
  article: visibleOnly(KIND_CONFIGS.article),
};

export const CATALOG_KIND_LIST: CatalogKindConfig[] = [CATALOG_KINDS.product, CATALOG_KINDS.collection, CATALOG_KINDS.article];

/** The check routes ("/seo/title-tags") of a kind, for matching a dashboard fix to it. */
export function routesOf(config: CatalogKindConfig): Set<string> {
  return new Set(config.checks.map(({ pillar, subPillar }) => `/${pillar}/${subPillar}`));
}
