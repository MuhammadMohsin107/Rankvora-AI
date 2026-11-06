import { useEffect, useMemo, useState } from 'react';
import { scrollChaining } from '../lib/scrollChaining';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Clock3, Info } from 'lucide-react';
import { fetchCatalog, type Catalog, type CatalogCheckResult, type CatalogItem } from '../data/catalog.repository';
import { CATALOG_KINDS, FIXABLE_CHECKS, subPillarOfCheck, type CatalogKind } from '../data/catalogKinds';
import { isSubPillarFixable } from '../data/audits.capabilities';
import { isNotAuditedYet } from '../data/seo/subpillar.repository';
import { formatLastUpdated } from '../data/dashboard/dashboard.repository';
import AppPage from '../components/polaris/AppPage';
import Badge from '../components/polaris/Badge';
import Banner from '../components/polaris/Banner';
import PillarTag from '../components/dashboard/PillarTag';
import { IssueBadges, Thumbnail, formatCatalogDate, verdictStyle } from '../components/catalog/CatalogBits';
import FixEditor from '../components/catalog/FixEditor';
import MissingImagesPanel from '../components/images/MissingImagesPanel';
import { useAuditCompletion } from '../data/useAuditRun';
import { cardClass } from '../components/dashboard/scoreTone';
import Button from '../components/polaris/Button';

const uniq = (values: (string | null | undefined)[]) =>
  [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()))];

/**
 * A collapsible section. Every section is OPEN when the page loads, so all of the item's details are
 * on screen without a click; a section can still be folded away, and opened again, from its header.
 */
function SectionCard({ id, title, aside, open, onToggle, children }: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section id={`section-${id}`} className={`${cardClass} scroll-mt-3 overflow-hidden`} aria-labelledby={`section-${id}-title`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-surface-50/60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span id={`section-${id}-title`} className="text-[14px] font-semibold text-surface-950">{title}</span>
          {aside}
        </span>
        {open ? <ChevronUp size={16} className="text-surface-400" aria-hidden="true" /> : <ChevronDown size={16} className="text-surface-400" aria-hidden="true" />}
      </button>
      {open && <div className="space-y-3 border-t border-surface-200/70 px-4 py-3">{children}</div>}
    </section>
  );
}

/**
 * One check's result as a tinted callout: what it found, why, and how it is fixed — in Rankvora AI. A
 * check Rankvora AI can write gets its editor right here (`editor`); a failing one it cannot write says
 * so plainly (`readOnly`) instead of sending the merchant elsewhere to do it.
 */
function CheckCallout({ check, showCurrent, editor, readOnly }: {
  check: CatalogCheckResult;
  showCurrent: boolean;
  /** The in-app editor for this check's field, when Rankvora AI can write it. */
  editor?: React.ReactNode;
  /** The check is failing and Rankvora AI has no way to write its field yet. */
  readOnly?: boolean;
}) {
  const style = verdictStyle[check.verdict];
  const Icon = style.icon;
  const bullets = uniq([
    check.detail !== check.status ? check.detail : null,
    showCurrent && check.current && check.current.value !== check.detail ? `${check.current.label}: ${check.current.value}` : null,
    check.verdict !== 'passing' ? check.recommendation : null,
  ]);
  return (
    <div className={`rounded-lg px-3 py-2.5 ring-1 ring-inset ${style.callout}`}>
      <p className="flex flex-wrap items-center gap-1.5">
        <Icon size={15} className={`flex-shrink-0 ${style.text}`} aria-hidden="true" />
        <span className="text-[12.5px] font-semibold text-surface-950">{check.label}</span>
        <span className={`text-[12px] font-semibold ${style.text}`}>· {check.status}</span>
        <PillarTag pillar={check.pillar} label={check.pillarLabel} />
      </p>
      {bullets.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-6 text-[12px] leading-[1.5] text-surface-700">
          {bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
        </ul>
      )}
      {/* The check's own suggestion is what the editor starts from, so it is shown only when there is no editor. */}
      {check.verdict !== 'passing' && !editor && check.suggested && (
        <p className="mt-1.5 rounded-md bg-surface-0/70 px-2 py-1 text-[12px] text-surface-700 ring-1 ring-inset ring-surface-200">
          <span className="font-semibold text-surface-900">{check.suggested.label}:</span> {check.suggested.value}
        </p>
      )}
      {editor && <div className="mt-2 rounded-lg bg-surface-0/80 p-2.5 ring-1 ring-inset ring-surface-200">{editor}</div>}
      {readOnly && check.verdict !== 'passing' && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-surface-0/70 px-2 py-1.5 text-[11.5px] leading-[1.5] text-surface-600 ring-1 ring-inset ring-surface-200">
          <Info size={13} className="mt-0.5 flex-shrink-0 text-surface-400" aria-hidden="true" />
          Rankvora AI can’t change this yet.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Link
          to={check.route}
          className="inline-flex items-center gap-1 rounded-md border border-surface-200 bg-surface-0 px-2.5 py-1 text-[11.5px] font-semibold text-surface-800 shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
        >
          {editor ? `Fix many at once in ${check.label}` : `View in ${check.label}`}
          <ArrowRight size={12} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

/** The item's own text a check read (its title, meta description, description), read-only. */
function ReadOnlyField({ check }: { check: CatalogCheckResult }) {
  if (!check.current) return null;
  return (
    <div>
      <p className="mb-1 text-[12px] font-medium text-surface-700">{check.current.label.replace(/^Current /, '').replace(/^./, (c) => c.toUpperCase())}</p>
      <p ref={scrollChaining} className="max-h-32 overflow-y-auto rounded-lg border border-surface-200 bg-surface-50/60 px-3 py-2 text-[12.5px] leading-[1.5] text-surface-900">
        {check.current.value}
      </p>
    </div>
  );
}

/**
 * How the item reads as a search result: its URL, title tag and meta description, exactly as the
 * title-tag and meta-description checks read them. A part a check did not record says so.
 */
function SearchPreview({ url, title, description }: { url: string | null; title: string | null; description: string | null }) {
  return (
    <div className="rounded-lg border border-surface-200 bg-surface-0 px-3.5 py-3">
      <p className="text-[11px] font-medium text-surface-500">Search result preview</p>
      <p className="mt-1.5 truncate text-[12px] text-surface-600">{url ?? 'URL not recorded'}</p>
      <p className={`mt-0.5 line-clamp-1 text-[16px] leading-snug ${title ? 'font-medium text-brand-700' : 'italic text-surface-400'}`}>
        {title ?? 'Title tag not recorded'}
      </p>
      <p className={`mt-0.5 line-clamp-2 text-[12.5px] leading-[1.5] ${description ? 'text-surface-600' : 'italic text-surface-400'}`}>
        {description ?? 'Meta description not recorded'}
      </p>
    </div>
  );
}

/**
 * A product's images and their alt text, as the alt-text check recorded them. An image the check
 * flagged can be given its alt text right here (`canFix`): one field per image, written to the store
 * through the same call as every other fix.
 */
function MediaTable({ item, name, canFix, savedAlts, onSaved, onAddImage, imageAdded }: {
  item: CatalogItem;
  name: string;
  canFix: boolean;
  /** Alt text written from this page, by image id — shown in place of what the audit read. */
  savedAlts: Record<string, string>;
  onSaved: (imageId: string, alt: string) => void;
  /** Opens the Missing images panel on this product. */
  onAddImage: () => void;
  /** An image was added to this product from this page; the audit this page shows predates it. */
  imageAdded: boolean;
}) {
  if (item.images.length === 0) {
    if (item.imageCount === 0 && imageAdded) {
      return (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-success-200 bg-success-50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-1.5 text-[12.5px] text-success-800">
            <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            Image added. This page updates after the next analysis.
          </p>
          <Button variant="secondary" onClick={onAddImage} className="flex-shrink-0">
            
            Add another image
          </Button>
        </div>
      );
    }
    return item.imageCount === 0 ? (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-warning-300 bg-warning-50/60 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[12.5px] text-surface-800">This product has no images.</p>
        <Button variant="primary" onClick={onAddImage} className="flex-shrink-0">
          
          Add an image
        </Button>
      </div>
    ) : (
      <p className="text-[12px] text-surface-500">Images not recorded in this audit.</p>
    );
  }
  const total = item.imageCount ?? item.images.length;
  const altCheck = FIXABLE_CHECKS['seo/image-alt-text'];
  return (
    <div className="overflow-hidden rounded-lg border border-surface-200/80">
      <div className="grid grid-cols-[56px_minmax(0,1fr)_28px] gap-3 border-b border-surface-200/70 bg-surface-50 px-3 py-1.5 text-[11px] font-semibold text-surface-500">
        <span>Image</span>
        <span>Alt text</span>
        <span className="text-right">Status</span>
      </div>
      <ul ref={scrollChaining} className="max-h-96 divide-y divide-surface-200/60 overflow-y-auto">
        {item.images.map((image) => {
          const savedHere = savedAlts[image.id] !== undefined;
          const alt = savedAlts[image.id] ?? image.alt;
          const hasAlt = alt.trim() !== '';
          const editable = canFix && image.findingId !== null && Number.isInteger(Number(image.findingId));
          // An image the audit flagged stays flagged until the next audit re-reads it — unless it was
          // just written from this page.
          const described = hasAlt && (image.findingId === null || savedHere);
          return (
            <li key={image.id} className="grid grid-cols-[56px_minmax(0,1fr)_28px] items-start gap-3 px-3 py-2">
              <Thumbnail src={image.src} name={`${name}, image ${image.position ?? ''}`} size="md" />
              <div className="min-w-0 space-y-1">
                <p className="text-[10.5px] font-medium tabular-nums text-surface-500">Image {image.position ?? '—'}{total ? ` of ${total}` : ''}</p>
                {editable && image.findingId ? (
                  <FixEditor
                    key={image.id}
                    rowId={image.id}
                    findingId={image.findingId}
                    label={altCheck.field}
                    current={image.alt}
                    suggested={null}
                    draft={altCheck.draft}
                    multiline={false}
                    compact
                    onSaved={(value) => onSaved(image.id, value)}
                  />
                ) : (
                  <p className={`truncate rounded-md border px-2 py-1 text-[12px] ${hasAlt ? 'border-surface-200 text-surface-800' : 'border-warning-200 bg-warning-50 font-semibold text-warning-700'}`} title={hasAlt ? alt : undefined}>
                    {hasAlt ? alt : 'No alt text'}
                  </p>
                )}
              </div>
              <span className="flex justify-end pt-4">
                {described
                  ? <CheckCircle2 size={16} className="text-success-600" aria-label="Described" />
                  : <AlertCircle size={16} className="text-warning-600" aria-label="Not described" />}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One item's own page — /products/:id, /collections/:id or /blog-articles/:id — laid out like the
 * detail page of a store-health app. ONE page for all three kinds; data/catalogKinds.ts says how
 * each is sectioned.
 *
 * Left, the item's sections, all open when the page loads, each showing how many of its checks need
 * attention in its header. Each shows the item's own values and a callout per check saying
 * what it found and where it is fixed. Right, the item's result: the share of its checks it passed
 * with Passed / Warning / Critical, and the validation details grouped by section.
 *
 * A product's page has two things the others do not, because only products have them: an image
 * gallery with alt text, and product organization (type and vendor).
 *
 * Everything is the latest audit's own record of this item (data/catalog.repository.ts). Fixes are
 * made HERE, in Rankvora AI: the SEO title, the SEO meta description and each image's alt text have an
 * editor that writes to the connected store when the merchant applies it (components/catalog/
 * FixEditor.tsx). A check whose field Rankvora AI cannot write yet says so — it never sends the merchant
 * to another site to do the work.
 */
export default function CatalogDetail({ kind }: { kind: CatalogKind }) {
  const config = CATALOG_KINDS[kind];
  const { itemId } = useParams<{ itemId: string }>();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /** `silent` reloads without the loading skeleton, so a panel open over the page is not torn down. */
  const load = async (fresh = false, silent = false) => {
    if (!silent) setState('loading');
    try {
      setCatalog(await fetchCatalog(kind, { fresh }));
      setState('ready');
    } catch (error) {
      // A silent reload that fails keeps showing what the page already has.
      if (silent) return;
      setErrorMessage(error instanceof Error ? error.message : null);
      setState(isNotAuditedYet(error) ? 'empty' : 'error');
    }
  };

  useEffect(() => { void load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // The analysis queued when an image is added (or a fix saved) finishes: show what it found.
  useAuditCompletion(() => load(true, true));

  // The Missing images panel, opened on this product from its Media section, and the products an
  // image was added to from it — the audit this page shows predates those images.
  const [imagesOpen, setImagesOpen] = useState(false);
  const [imageAddedFor, setImageAddedFor] = useState<Set<string>>(() => new Set());

  const item = useMemo(() => catalog?.items.find((candidate) => candidate.id === itemId) ?? null, [catalog, itemId]);

  // Which of the fixable checks the SERVER will write, asked once. Until it answers no editor is
  // offered and no "can't change this" note is shown: neither claim is made before it is known.
  const [writable, setWritable] = useState<Set<string> | null>(null);
  useEffect(() => {
    let live = true;
    const keys = Object.keys(FIXABLE_CHECKS);
    void Promise.all(keys.map(async (key) => [key, await isSubPillarFixable(subPillarOfCheck(key))] as const)).then((entries) => {
      if (live) setWritable(new Set(entries.filter(([, ok]) => ok).map(([key]) => key)));
    });
    return () => { live = false; };
  }, []);

  // What was written to the store from this page, so the preview and the gallery show it at once
  // instead of the audit's older reading. Cleared when another item is opened.
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});
  const [savedAlts, setSavedAlts] = useState<Record<string, string>>({});
  useEffect(() => { setSavedValues({}); setSavedAlts({}); }, [itemId]);

  // Every section starts OPEN, so the item's details show without a click; folding one is the
  // merchant's choice. The validation list on the right brings the section it points to into view.
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(config.sections.map((section) => section.id)));
  // Opening another item shows its sections open too, whatever was folded on the last one.
  useEffect(() => { setOpenSections(new Set(config.sections.map((section) => section.id))); }, [itemId, config.sections]);
  const toggleSection = (id: string) => setOpenSections((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const openSection = (id: string) => {
    setOpenSections((current) => new Set(current).add(id));
    // After the section has rendered open.
    requestAnimationFrame(() => document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  // The page frame's back link (the arrow before the title, in the admin's title bar), and the title it
  // shows until the item has loaded and has a name of its own: "Product", "Collection", "Article".
  const back = { label: config.navLabel, to: config.listPath };
  const kindTitle = `${config.noun.charAt(0).toUpperCase()}${config.noun.slice(1)}`;

  if (state === 'loading') {
    return (
      <AppPage heading={kindTitle} back={back}>
      <div className="page-shell space-y-3 pt-3" aria-busy="true" aria-label={`Loading ${config.noun}`}>
        <div className="flex items-center gap-3"><div className="skeleton h-16 w-16 rounded-xl" /><div className="skeleton h-6 w-80" /></div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-48 rounded-2xl" />)}</div>
          <div className="space-y-3"><div className="skeleton h-40 rounded-2xl" /><div className="skeleton h-72 rounded-2xl" /></div>
        </div>
      </div>
      </AppPage>
    );
  }

  if (state !== 'ready' || !catalog || !item) {
    const title = state === 'empty' ? config.emptyTitle : state === 'error' ? config.errorTitle : config.notFoundTitle;
    const body = state === 'error' ? errorMessage : null;
    return (
      <AppPage heading={kindTitle} back={back}>
      <div className="page-shell pt-3">
        <div className={`${cardClass} mx-auto mt-6 flex max-w-lg flex-col items-center p-6 text-center`}>
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-100 text-surface-500"><Info size={18} /></span>
          <h2 className="mt-2.5 text-[15px] font-semibold text-surface-900">{title}</h2>
          {body && <p className="mt-1 text-[12.5px] leading-[1.5] text-surface-500">{body}</p>}
          {state === 'error' && <Button variant="primary" onClick={() => void load(true)} className="mt-3">Retry</Button>}
        </div>
      </div>
      </AppPage>
    );
  }

  const name = item.name ?? `${config.noun[0].toUpperCase()}${config.noun.slice(1)} ${item.id}`;
  const path = item.url ? item.url.replace(/^https?:\/\/[^/]+/, '') : null;
  const byKey = new Map(item.checks.map((check) => [check.key, check]));
  const sectionChecks = (keys: string[]) => keys.map((key) => byKey.get(key)).filter((check): check is CatalogCheckResult => Boolean(check));
  const updated = formatCatalogDate(item.updatedAt);
  const published = formatCatalogDate(item.publishedAt);
  const rateTone = item.passRate >= 90 ? 'text-success-700' : item.passRate >= 50 ? 'text-warning-700' : 'text-critical-700';
  const failingIn = (checks: CatalogCheckResult[]) => checks.filter((check) => check.verdict !== 'passing').length;
  const fieldChecks = new Set(config.fieldChecks);

  const needsAttention = (checks: CatalogCheckResult[]) => {
    const failing = failingIn(checks);
    return failing > 0
      ? <Badge tone="warning">{failing} need attention</Badge>
      : checks.length > 0
        ? <Badge tone="success">All passing</Badge>
        : null;
  };

  const sectionProps = (id: string) => ({ id, open: openSections.has(id), onToggle: () => toggleSection(id) });
  const altWritable = writable?.has('seo/image-alt-text') ?? false;

  /**
   * How one check is fixed, from what the server says it can write: an editor here for a field
   * Rankvora AI writes, an honest "can't yet" for a failing check it does not, and nothing for a passing
   * one. Image alt text is edited image by image in the gallery, so its callout has neither.
   */
  const fixFor = (check: CatalogCheckResult): Pick<Parameters<typeof CheckCallout>[0], 'editor' | 'readOnly'> => {
    if (check.verdict === 'passing' || writable === null) return {};
    const fixable = FIXABLE_CHECKS[check.key];
    if (fixable?.perImage) return {};
    if (fixable && writable.has(check.key) && check.findingId !== null && Number.isInteger(Number(check.findingId))) {
      return {
        editor: (
          <FixEditor
            key={check.rowId}
            rowId={check.rowId}
            findingId={check.findingId}
            label={fixable.field}
            current={check.current?.value ?? ''}
            suggested={check.suggested?.value ?? null}
            draft={fixable.draft}
            multiline={check.key === 'seo/meta-descriptions'}
            onSaved={(value) => setSavedValues((current) => ({ ...current, [check.key]: value }))}
          />
        ),
      };
    }
    return { readOnly: true };
  };

  /**
   * One section's body. The checks come from the kind's config; the few things only some sections
   * have — the search preview, a product's gallery and organization — are added here by section, so
   * what a section shows is decided in one place.
   */
  const renderSection = (section: { id: string; title: string; checks: string[] }) => {
    const checks = sectionChecks(section.checks);

    if (section.id === 'organization') {
      if (kind !== 'product' || !(item.productType || item.vendor)) return null;
      return (
        <SectionCard key={section.id} {...sectionProps(section.id)} title={section.title}>
          <Banner tone="info"><s-text>View only.</s-text></Banner>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[12px] font-medium text-surface-700">Type</p>
              <p className="rounded-lg border border-surface-200 bg-surface-50/60 px-3 py-2 text-[12.5px] text-surface-900">{item.productType ?? <span className="italic text-surface-400">Not set</span>}</p>
            </div>
            <div>
              <p className="mb-1 text-[12px] font-medium text-surface-700">Vendor</p>
              <p className="rounded-lg border border-surface-200 bg-surface-50/60 px-3 py-2 text-[12.5px] text-surface-900">{item.vendor ?? <span className="italic text-surface-400">Not set</span>}</p>
            </div>
          </div>
        </SectionCard>
      );
    }

    // A product's media section is always there — its gallery says what was and was not recorded.
    const always = kind === 'product' && section.id === 'media';
    if (checks.length === 0 && !always) return null;

    return (
      <SectionCard key={section.id} {...sectionProps(section.id)} title={section.title} aside={needsAttention(checks)}>
        {section.id === 'seo' && (
          <SearchPreview
            url={item.url}
            title={savedValues['seo/title-tags'] ?? byKey.get('seo/title-tags')?.current?.value ?? null}
            description={savedValues['seo/meta-descriptions'] ?? byKey.get('seo/meta-descriptions')?.current?.value ?? null}
          />
        )}
        {always && (
          <MediaTable
            item={item}
            name={name}
            canFix={altWritable}
            savedAlts={savedAlts}
            onSaved={(imageId, alt) => setSavedAlts((current) => ({ ...current, [imageId]: alt }))}
            onAddImage={() => setImagesOpen(true)}
            imageAdded={imageAddedFor.has(item.id)}
          />
        )}
        {checks.map((check) => (
          <div key={check.key} className="space-y-2">
            {fieldChecks.has(check.key) && <ReadOnlyField check={check} />}
            <CheckCallout
              check={check}
              // The search-listing checks' own values are already in the preview above; the alt-text
              // check's is one image's text, and the gallery above already shows every image's.
              showCurrent={section.id !== 'seo' && !fieldChecks.has(check.key) && check.key !== 'seo/image-alt-text'}
              {...fixFor(check)}
            />
          </div>
        ))}
      </SectionCard>
    );
  };

  return (
    // The item's name is the page frame's title (the Shopify admin's title bar), with the back arrow to
    // its list. What is left is the content, on the admin's own background.
    <AppPage heading={name} back={back}>
    <div className="page-shell mx-auto max-w-[1180px] space-y-3 pt-3">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Thumbnail src={item.imageSrc} name={name} size="lg" kind={kind} />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-surface-500">
              {path && <span className="truncate font-mono">{path}</span>}
            </p>
            <div className="mt-1.5"><IssueBadges item={item} /></div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {catalog.lastAnalyzed && (
            <span className="meta-chip">
              <Clock3 size={12} className="text-surface-400" aria-hidden="true" />
              Analyzed <span className="font-medium text-surface-800">{formatLastUpdated(catalog.lastAnalyzed)}</span>
            </span>
          )}
          {item.productCount !== null && (
            <span className="meta-chip"><span className="font-medium text-surface-800">{item.productCount.toLocaleString()}</span> {item.productCount === 1 ? 'product' : 'products'}</span>
          )}
          {published && <span className="meta-chip">Published <span className="font-medium text-surface-800">{published}</span></span>}
          {updated && <span className="meta-chip">Updated in Shopify <span className="font-medium text-surface-800">{updated}</span></span>}
        </div>
      </header>

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── The item's sections ── */}
        <div className="min-w-0 space-y-3">
          {config.sections.map((section) => renderSection(section))}
        </div>

        {/* ── The item's result ── */}
        <aside className="space-y-3 lg:sticky lg:top-3">
          <section className={`${cardClass} overflow-hidden`} aria-labelledby="item-result-title">
            <div className="px-4 pt-3.5 text-center">
              <h2 id="item-result-title" className="text-[13px] font-semibold text-surface-900">{config.resultTitle}</h2>
              <p className={`mt-2 text-[38px] font-semibold leading-none tracking-[-0.04em] tabular-nums ${rateTone}`}>
                {item.passRate}<span className="text-[18px] text-surface-400">%</span>
              </p>
              <p className="mt-1 text-[11px] tabular-nums text-surface-500">{item.passing} of {item.checks.length} checks</p>
            </div>
            <dl className="mt-3 grid grid-cols-3 divide-x divide-surface-200/70 border-t border-surface-200/70 text-center">
              {([
                ['Passed', item.passing, 'text-success-700'],
                ['Warning', item.warnings, 'text-warning-700'],
                ['Critical', item.critical, 'text-critical-700'],
              ] as const).map(([label, value, tone]) => (
                <div key={label} className="px-2 py-2.5">
                  <dt className="text-[11.5px] font-medium text-surface-600">{label}</dt>
                  <dd className={`mt-0.5 text-[20px] font-semibold tabular-nums ${value > 0 ? tone : 'text-surface-400'}`}>{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className={`${cardClass} overflow-hidden`} aria-labelledby="validation-title">
            <h2 id="validation-title" className="border-b border-surface-200/70 px-4 py-3 text-[13px] font-semibold text-surface-950">Validation details</h2>
            <div ref={scrollChaining} className="max-h-[calc(100vh_-_22rem)] min-h-[12rem] space-y-3 overflow-y-auto px-4 py-3 [scrollbar-color:var(--c-surface-300)_transparent] [scrollbar-width:thin]">
              {config.sections.map((section) => {
                const checks = sectionChecks(section.checks);
                if (checks.length === 0) return null;
                return (
                  <div key={section.id}>
                    <p className="text-[11.5px] font-semibold text-surface-500">{section.title}</p>
                    <ul className="mt-1 space-y-0.5">
                      {checks.map((check) => {
                        const style = verdictStyle[check.verdict];
                        const Icon = style.icon;
                        return (
                          <li key={check.key}>
                            {/* Opens the section and brings it into view. A button, not an #anchor:
                                the app shell scrolls to the top on every change of address. */}
                            <button
                              type="button"
                              onClick={() => openSection(section.id)}
                              className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12.5px] text-surface-800 hover:bg-surface-50"
                            >
                              <Icon size={15} className={`flex-shrink-0 ${style.text}`} aria-label={style.label} />
                              <span className="min-w-0 flex-1 truncate">{check.label}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>
        </aside>
      </div>

      {kind === 'product' && (
        <MissingImagesPanel
          open={imagesOpen}
          onClose={() => setImagesOpen(false)}
          initialProductId={item.id}
          onImageAdded={() => setImageAddedFor((current) => new Set(current).add(item.id))}
        />
      )}
    </div>
    </AppPage>
  );
}
