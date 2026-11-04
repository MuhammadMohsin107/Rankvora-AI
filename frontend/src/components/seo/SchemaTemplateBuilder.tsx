import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrollChaining } from '../../lib/scrollChaining';
import { AlertCircle, Check, ChevronRight, Code2, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import {
  fetchSchemaCatalog,
  fetchSchemaTemplate,
  fetchSchemaTemplates,
  previewSchemaTemplate,
  saveSchemaTemplate,
  type SchemaCatalog,
  type SchemaContextKind,
  type SchemaPreview,
  type SchemaTypeDefinition,
  type ValueSource,
} from '../../data/schema.repository';
import { ApiError } from '../../lib/api';
import { settingsCard } from '../settings/SettingsPrimitives';

/**
 * ─── Schema / JSON-LD settings ───────────────────────────────────────
 *
 * Two levels, because the job has two halves: pick a built-in template for a kind of page, then
 * decide where each of its properties gets its value from.
 *
 * EVERYTHING SHOWN HERE IS REAL. The type list, the properties and their Google requirements come
 * from the server's library; the Shopify field picker offers only fields the resolver can
 * genuinely read; and the preview is rendered against ONE REAL RECORD from the merchant's own
 * catalogue — not an example product. A preview built from a fabricated sample would answer a
 * different question from the one a merchant is asking.
 *
 * What is NOT here yet: publishing. Generated schema reaches a storefront through a theme app
 * extension, which this app does not have, so this screen generates, previews and validates —
 * and says so rather than offering a button that would do nothing.
 */

const CONTEXTS: Array<{ kind: SchemaContextKind; label: string; hint: string }> = [
  { kind: 'product', label: 'Product pages', hint: 'Rendered for every product' },
  { kind: 'collection', label: 'Collection pages', hint: 'Rendered for every collection' },
  { kind: 'article', label: 'Blog articles', hint: 'Rendered for every article' },
  { kind: 'page', label: 'Pages', hint: 'Rendered for every page' },
  { kind: 'shop', label: 'Store-wide', hint: 'Rendered once, on the homepage' },
];

const requirementStyle: Record<string, string> = {
  required: 'bg-critical-50 text-critical-700 border-critical-100',
  recommended: 'bg-warning-50 text-warning-700 border-warning-100',
  optional: 'bg-surface-100 text-surface-500 border-surface-200',
};

/** The source kinds a merchant picks between for one property. */
type SourceKind = 'none' | 'shopify' | 'static' | 'metafield';

function sourceKindOf(source: ValueSource | undefined): SourceKind {
  if (!source) return 'none';
  if (source.kind === 'shopify' || source.kind === 'static' || source.kind === 'metafield') return source.kind;
  // `object` and `array` come from the library's defaults (Product.brand, Product.offers). They
  // are shown read-only rather than pretended to be a simple picker — editing nested objects is
  // the Custom Schema Builder's job, and a dropdown that silently flattened one would destroy it.
  return 'none';
}

export default function SchemaTemplateBuilder() {
  const [context, setContext] = useState<SchemaContextKind>('product');
  const [catalog, setCatalog] = useState<SchemaCatalog | null>(null);
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(new Set());
  const [openType, setOpenType] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; properties: Record<string, ValueSource> } | null>(null);
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<'saving' | 'previewing' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  // ── Catalog + which types this store already switched on ───────────
  useEffect(() => {
    let active = true;
    setStatus('loading');
    setOpenType(null);
    setPreview(null);
    Promise.all([fetchSchemaCatalog(context), fetchSchemaTemplates()])
      .then(([catalogData, templates]) => {
        if (!active) return;
        setCatalog(catalogData);
        setEnabledTypes(new Set(templates.filter((entry) => entry.enabled).map((entry) => `${entry.type}:${entry.context}`)));
        setStatus('ready');
      })
      .catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [context]);

  const builtIn = useMemo(
    () => (catalog?.types ?? []).filter((type) => type.builtIn),
    [catalog],
  );

  const definition: SchemaTypeDefinition | undefined = useMemo(
    () => catalog?.types.find((type) => type.type === openType),
    [catalog, openType],
  );

  const openTemplate = useCallback(async (type: string) => {
    setOpenType(type);
    setPreview(null);
    setNotice(null);
    try {
      const template = await fetchSchemaTemplate(type, context);
      setDraft({ enabled: template.enabled, properties: template.properties });
    } catch {
      setNotice({ tone: 'error', text: 'That template could not be loaded.' });
    }
  }, [context]);

  const runPreview = useCallback(async () => {
    if (!openType || !draft) return;
    setBusy('previewing');
    setNotice(null);
    try {
      setPreview(await previewSchemaTemplate(openType, context, draft));
    } catch (error) {
      // The backend distinguishes "this store has no such record" from a real failure, and its
      // wording is already merchant-safe.
      setNotice({
        tone: 'error',
        text: error instanceof ApiError ? error.message : 'The preview could not be generated.',
      });
    } finally {
      setBusy(null);
    }
  }, [context, draft, openType]);

  const save = async () => {
    if (!openType || !draft) return;
    setBusy('saving');
    setNotice(null);
    try {
      await saveSchemaTemplate(openType, context, draft);
      setEnabledTypes((current) => {
        const next = new Set(current);
        const key = `${openType}:${context}`;
        if (draft.enabled) next.add(key); else next.delete(key);
        return next;
      });
      setNotice({ tone: 'success', text: 'Saved. Nothing is on your storefront yet — see the note below.' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof ApiError ? error.message : 'That template could not be saved.' });
    } finally {
      setBusy(null);
    }
  };

  const setSource = (property: string, source: ValueSource) => {
    setDraft((current) => (current ? { ...current, properties: { ...current.properties, [property]: source } } : current));
  };

  if (status === 'loading') {
    return (
      <div className={`${settingsCard} p-3 text-[12px] text-surface-500`}>
        <span className="inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin" />Loading schema types…</span>
      </div>
    );
  }

  if (status === 'error') {
    return <div className={`${settingsCard} p-3 text-[12px] text-critical-700`}>Schema types could not be loaded.</div>;
  }

  return (
    <div className="space-y-2">
      {/* ── Context switcher ─────────────────────────────────────── */}
      <div className={`${settingsCard} p-3`}>
        <p className="text-[12.5px] font-semibold text-surface-900">Schema / JSON-LD settings</p>
        <p className="mt-0.5 text-[11.5px] leading-[1.45] text-surface-500">
          Choose what structured data Rankvora AI should generate from your Shopify data, for each kind of page.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CONTEXTS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              onClick={() => setContext(entry.kind)}
              title={entry.hint}
              className={`rounded-md border px-2 py-1 text-[11.5px] font-medium transition-colors ${
                context === entry.kind
                  ? 'border-brand-300 bg-brand-50 text-brand-800'
                  : 'border-surface-200 bg-surface-0 text-surface-600 hover:border-brand-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Built-in templates for this context ──────────────────── */}
      <div className={`${settingsCard} overflow-hidden`}>
        <div className="border-b border-surface-200 px-3 py-2">
          <p className="text-[12px] font-semibold text-surface-900">Built-in templates</p>
          <p className="mt-0.5 text-[11px] text-surface-500">
            {builtIn.length} type{builtIn.length === 1 ? '' : 's'} available for {CONTEXTS.find((entry) => entry.kind === context)?.label.toLowerCase()}.
          </p>
        </div>
        <ul className="divide-y divide-surface-100">
          {builtIn.map((type) => {
            const on = enabledTypes.has(`${type.type}:${context}`);
            return (
              <li key={type.type}>
                <button
                  type="button"
                  onClick={() => void openTemplate(type.type)}
                  className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-50 ${openType === type.type ? 'bg-brand-50/50' : ''}`}
                >
                  <span className={`mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${on ? 'border-success-200 bg-success-50 text-success-700' : 'border-surface-200 bg-surface-0 text-surface-300'}`}>
                    {on ? <Check size={10} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12.5px] font-semibold text-surface-900">{type.type}</span>
                      <span className="rounded bg-surface-100 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.08em] text-surface-500">{type.category}</span>
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-[1.4] text-surface-500">{type.description}</span>
                  </span>
                  <ChevronRight size={13} className="mt-1 flex-shrink-0 text-surface-300" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ── Property mapping for the open type ───────────────────── */}
      {definition && draft && (
        <div className={`${settingsCard} p-3`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-surface-900">{definition.type}</p>
              <p className="mt-0.5 text-[11px] leading-[1.45] text-surface-500">{definition.description}</p>
              {definition.googleDocs && (
                <a href={definition.googleDocs} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-brand-600 hover:text-brand-700">
                  Google's requirements <ExternalLink size={10} />
                </a>
              )}
            </div>
            <label className="flex flex-shrink-0 cursor-pointer items-center gap-2 text-[11.5px] font-medium text-surface-700">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                className="h-3.5 w-3.5 cursor-pointer rounded border-surface-300 text-brand-600 focus:ring-brand-500"
              />
              Generate this schema
            </label>
          </div>

          <div className="mt-2.5 space-y-2">
            {definition.properties.map((property) => {
              const source = draft.properties[property.name];
              const kind = sourceKindOf(source);
              const nested = source?.kind === 'object' || source?.kind === 'array';
              return (
                <div key={property.name} className="rounded-md border border-surface-200 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="flex items-center gap-1.5">
                      <code className="text-[12px] font-semibold text-surface-900">{property.name}</code>
                      <span className={`rounded border px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.08em] ${requirementStyle[property.requirement]}`}>
                        {property.requirement}
                      </span>
                    </span>
                    <span className="text-[10.5px] text-surface-400">{property.expects}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-[1.4] text-surface-500">{property.description}</p>

                  {nested ? (
                    // The library preconfigures these as real nested objects (Product.brand,
                    // Product.offers). Shown as-is: a dropdown that flattened one would silently
                    // destroy a correct mapping.
                    <p className="mt-1.5 rounded bg-surface-50 px-2 py-1 font-mono text-[10.5px] text-surface-600">
                      Nested {source?.kind === 'object' ? source.type : 'list'} — preconfigured from your Shopify data
                    </p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <select
                        value={kind}
                        onChange={(event) => {
                          const next = event.target.value as SourceKind;
                          if (next === 'none') setSource(property.name, { kind: 'none' });
                          else if (next === 'static') setSource(property.name, { kind: 'static', value: '' });
                          else if (next === 'metafield') setSource(property.name, { kind: 'metafield', namespace: 'custom', key: '' });
                          else setSource(property.name, { kind: 'shopify', path: catalog?.fields[0]?.path ?? '' });
                        }}
                        className="h-7 rounded-md border border-surface-200 bg-surface-0 px-1.5 text-[11.5px] text-surface-800"
                      >
                        <option value="none">Not used</option>
                        <option value="shopify">Shopify field</option>
                        <option value="metafield">Metafield</option>
                        <option value="static">Fixed value</option>
                      </select>

                      {kind === 'shopify' && (
                        <select
                          value={source?.kind === 'shopify' ? source.path : ''}
                          onChange={(event) => setSource(property.name, { kind: 'shopify', path: event.target.value })}
                          className="h-7 min-w-[14rem] flex-1 rounded-md border border-surface-200 bg-surface-0 px-1.5 text-[11.5px] text-surface-800"
                        >
                          {(catalog?.fields ?? []).map((field) => (
                            <option key={field.path} value={field.path}>{field.label}</option>
                          ))}
                        </select>
                      )}

                      {kind === 'static' && (
                        <input
                          value={source?.kind === 'static' ? String(source.value) : ''}
                          onChange={(event) => setSource(property.name, { kind: 'static', value: event.target.value })}
                          placeholder="Type the value"
                          className="h-7 min-w-[12rem] flex-1 rounded-md border border-surface-200 px-2 text-[11.5px] text-surface-900"
                        />
                      )}

                      {kind === 'metafield' && (
                        <>
                          <input
                            value={source?.kind === 'metafield' ? source.namespace : ''}
                            onChange={(event) => setSource(property.name, { kind: 'metafield', namespace: event.target.value, key: source?.kind === 'metafield' ? source.key : '' })}
                            placeholder="namespace"
                            className="h-7 w-28 rounded-md border border-surface-200 px-2 text-[11.5px] text-surface-900"
                          />
                          <input
                            value={source?.kind === 'metafield' ? source.key : ''}
                            onChange={(event) => setSource(property.name, { kind: 'metafield', namespace: source?.kind === 'metafield' ? source.namespace : 'custom', key: event.target.value })}
                            placeholder="key"
                            className="h-7 w-28 rounded-md border border-surface-200 px-2 text-[11.5px] text-surface-900"
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button type="button" onClick={save} disabled={busy !== null} className="btn-primary btn-xs">
              {busy === 'saving' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}Save template
            </button>
            <button type="button" onClick={() => void runPreview()} disabled={busy !== null} className="btn-secondary btn-xs">
              {busy === 'previewing' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}Preview with my data
            </button>
          </div>

          {notice && (
            <p className={`mt-2 rounded-md px-2 py-1.5 text-[11.5px] ${notice.tone === 'success' ? 'bg-success-50 text-success-800' : 'bg-critical-50 text-critical-800'}`}>
              {notice.text}
            </p>
          )}
        </div>
      )}

      {/* ── Preview against a real record ────────────────────────── */}
      {preview && (
        <div className={`${settingsCard} p-3`}>
          <div className="flex items-center gap-1.5">
            <Code2 size={13} className="text-surface-400" />
            <p className="text-[12px] font-semibold text-surface-900">Generated JSON-LD</p>
          </div>
          {preview.sample && (
            <p className="mt-0.5 text-[11px] text-surface-500">
              Rendered against your real {preview.sample.kind}: <span className="font-medium text-surface-700">{preview.sample.title}</span>
            </p>
          )}

          <pre ref={scrollChaining} className="mt-2 max-h-80 overflow-auto rounded-md bg-surface-950 p-2.5 font-mono text-[10.5px] leading-[1.5] text-surface-100">
{preview.jsonLd ? JSON.stringify(preview.jsonLd, null, 2) : 'Nothing resolved — every property is either unused or empty in your Shopify data.'}
          </pre>

          {/* Why a property is absent, stated per property. An empty box with no explanation is
              the one answer this screen must never give. */}
          {preview.omissions.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] font-semibold text-surface-700">Left out ({preview.omissions.length})</p>
              <ul className="mt-1 space-y-0.5">
                {preview.omissions.map((entry) => (
                  <li key={entry.property} className="text-[11px] leading-[1.4] text-surface-500">
                    <code className="font-semibold text-surface-700">{entry.property}</code> — {entry.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-2 border-t border-surface-100 pt-2">
            <p className={`text-[11.5px] font-semibold ${preview.validation.valid ? 'text-success-700' : 'text-critical-700'}`}>
              {preview.validation.valid ? 'Valid structured data' : 'Not valid yet'}
            </p>
            <ul className="mt-1 space-y-0.5">
              {preview.validation.issues.map((issue, index) => (
                <li key={`${issue.property}-${index}`} className="flex items-start gap-1.5 text-[11px] leading-[1.4]">
                  <AlertCircle size={11} className={`mt-0.5 flex-shrink-0 ${issue.severity === 'error' ? 'text-critical-500' : 'text-warning-500'}`} />
                  <span className="text-surface-600"><code className="font-semibold text-surface-700">{issue.property}</code> {issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── What this does not do yet ────────────────────────────── */}
      <div className="rounded-md border border-info-100 bg-info-50 px-2.5 py-2 text-[11px] leading-[1.45] text-info-800">
        <span className="font-semibold">Nothing here is on your storefront yet.</span> Rankvora AI generates, previews and
        validates this schema from your real Shopify data. Putting it on the page needs a Shopify theme app extension,
        which is the next piece of work — until it ships, the Schema audit above still reports what your theme renders
        on its own.
      </div>
    </div>
  );
}
