import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Info, Loader2, Save } from 'lucide-react';
import {
  ALT_TEXT_CONTENT_TYPES,
  AUTO_FORMATS,
  AUTO_FORMAT_LABELS,
  CONTENT_TYPE_LABELS,
  MAX_CHARACTER_LIMIT,
  MAX_TEMPLATE_LENGTH,
  MIN_CHARACTER_LIMIT,
  PLACEHOLDERS,
  characterLimitError,
  fetchAltTextConfig,
  saveAltTextConfig,
  templateError,
  type AltTextConfig,
  type AltTextContentType,
  type AltTextTypeConfig,
  type AutoFormat,
} from '../../data/seo/altText.repository';
import { ApiError } from '../../lib/api';
import { card, cardHeader, cardTitle, eyebrow } from './subpillar/tone';

/**
 * ─── Alt-text template builder ───────────────────────────────────────
 * Configuration only. Saving a template stores a document against the merchant's store; it never
 * writes to Shopify.
 *
 * THE LIVE PREVIEW WAS REMOVED. It queried the merchant's real catalogue on every settled edit and
 * rendered the result, which sounds useful and was not: "Skip images that already have alt text" is
 * on by default, so on any established store every sampled image was skipped and every row showed
 * the merchant's OWN existing alt text at its own length. The panel demonstrated nothing about the
 * template being edited, while its character counts — 137, 208, 255 against a 125 limit — read as
 * though the limit were being ignored. A Shopify read per keystroke-batch for that is a bad trade.
 *
 * Each content type keeps its own configuration: editing Products cannot alter Articles, because
 * the whole document is held in state and only the active type's slice is replaced.
 */

type LoadState = 'loading' | 'ready' | 'error';

/** Renders the tab strip. Roving focus is left to the browser: these are real buttons. */
function TypeTabs({ active, onSelect }: { active: AltTextContentType; onSelect: (type: AltTextContentType) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-md border border-surface-200 bg-surface-100/70 p-0.5" role="tablist" aria-label="Content type">
      {ALT_TEXT_CONTENT_TYPES.map((type) => {
        const selected = type === active;
        return (
          <button
            key={type}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(type)}
            className={`cursor-pointer rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              selected ? 'bg-surface-0 text-surface-950 shadow-[0_1px_2px_var(--c-shadow-md)]' : 'text-surface-500 hover:text-surface-800'
            }`}
          >
            {CONTENT_TYPE_LABELS[type]}
          </button>
        );
      })}
    </div>
  );
}

export default function AltTextTemplateBuilder() {
  const [config, setConfig] = useState<AltTextConfig | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contentType, setContentType] = useState<AltTextContentType>('products');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** True only after a save this session. Loading an already-saved configuration is not a save,
   * and showing "Template saved" for it would report something that did not happen. */
  const [justSaved, setJustSaved] = useState(false);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    fetchAltTextConfig()
      .then((response) => {
        if (!active) return;
        setConfig(response.config);
        setState('ready');
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof ApiError ? error.message : 'Alt-text settings could not be loaded.');
        setState('error');
      });
    return () => { active = false; };
  }, []);

  const current: AltTextTypeConfig | null = config ? config[contentType] : null;

  const update = useCallback((patch: Partial<AltTextTypeConfig>) => {
    // Only the active content type's slice is replaced, which is what keeps the other type's
    // configuration intact while the merchant edits this one.
    setConfig((previous) => (previous ? { ...previous, [contentType]: { ...previous[contentType], ...patch } } : previous));
    setJustSaved(false);
    setSaveError(null);
  }, [contentType]);

  const templateIssue = current ? templateError(current.template, contentType) : null;
  const limitIssue = current ? characterLimitError(current.characterLimit) : null;
  const canSave = Boolean(current) && !templateIssue && !limitIssue && !saving;

  // Switching content type is not an edit — it reveals the other type's own saved configuration.
  const selectContentType = (type: AltTextContentType) => {
    setContentType(type);
    setJustSaved(false);
    setSaveError(null);
  };

  const insertPlaceholder = (key: string) => {
    const field = templateRef.current;
    if (!field || !current) return;
    const token = `{{${key}}}`;
    const start = field.selectionStart ?? current.template.length;
    const end = field.selectionEnd ?? start;
    const next = `${current.template.slice(0, start)}${token}${current.template.slice(end)}`.slice(0, MAX_TEMPLATE_LENGTH);
    update({ template: next });
    // Restore the caret after the inserted token so the merchant can keep typing where they were.
    window.requestAnimationFrame(() => {
      field.focus();
      const caret = start + token.length;
      field.setSelectionRange(caret, caret);
    });
  };

  const save = async () => {
    if (!config || !canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await saveAltTextConfig(config);
      setConfig(response.config);
      setJustSaved(true);
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : 'The template could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (state === 'loading') {
    return (
      <section className={`${card} px-3.5 py-6`} aria-busy="true">
        <p className="flex items-center gap-1.5 text-[12.5px] text-surface-500">
          <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Loading alt-text settings…
        </p>
      </section>
    );
  }

  if (state === 'error' || !config || !current) {
    return (
      <section className={`${card} px-3.5 py-5 text-center`}>
        <AlertCircle size={16} className="mx-auto text-critical-600" aria-hidden="true" />
        <p className="mt-1.5 text-[12.5px] text-surface-700">{loadError}</p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ── Builder ───────────────────────────────────────────────── */}
      <section className={`${card} overflow-hidden`} aria-labelledby="alt-template-title">
        <div className={`${cardHeader} flex flex-wrap items-center justify-between gap-2`}>
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <p className={eyebrow}>Configuration</p>
            <h2 id="alt-template-title" className={cardTitle}>Alt-Text Template Builder</h2>
          </div>
          <TypeTabs active={contentType} onSelect={selectContentType} />
        </div>

        {/* The card header names this thing once. A description paragraph under it repeated that
            in longer words and read as a second heading, so it is gone — what a placeholder does
            is explained where placeholders are, on the chips themselves. */}
        <div className="px-3.5 py-3">
          <div>
            <label htmlFor="alt-template" className="block text-[12px] font-semibold text-surface-800">
              Template
            </label>
            <textarea
              ref={templateRef}
              id="alt-template"
              value={current.template}
              rows={2}
              maxLength={MAX_TEMPLATE_LENGTH}
              onChange={(event) => update({ template: event.target.value })}
              aria-invalid={templateIssue ? true : undefined}
              aria-describedby={templateIssue ? 'alt-template-error' : 'alt-template-hint'}
              className={`mt-1 w-full resize-y rounded-md border bg-surface-50 px-2.5 py-1.5 font-mono text-[12px] leading-[1.5] text-surface-900 outline-none transition-colors focus:bg-surface-0 focus:ring-2 ${
                templateIssue
                  ? 'border-critical-300 focus:border-critical-500 focus:ring-critical-100'
                  : 'border-surface-200 focus:border-brand-400 focus:ring-brand-100'
              }`}
            />
            {templateIssue ? (
              <p id="alt-template-error" className="mt-1 flex items-start gap-1 text-[11px] font-medium text-critical-700">
                <AlertCircle size={11} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                {templateIssue}
              </p>
            ) : (
              <p id="alt-template-hint" className="mt-1 text-[10.5px] text-surface-400">
                Mix plain text with placeholders — for example <span className="font-mono">{'{{product_title}} by {{vendor}}'}</span>.
              </p>
            )}
          </div>

          <div className="mt-2.5">
            <p className="text-[12px] font-semibold text-surface-800">Available fields</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {PLACEHOLDERS[contentType].map((placeholder) => (
                <button
                  key={placeholder.key}
                  type="button"
                  onClick={() => insertPlaceholder(placeholder.key)}
                  title={`${placeholder.hint} — inserts {{${placeholder.key}}}`}
                  aria-label={`Insert ${placeholder.label} placeholder`}
                  className="cursor-pointer rounded border border-surface-200 bg-surface-0 px-1.5 py-0.5 text-[11px] font-medium text-surface-700 transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {placeholder.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <div>
              <label htmlFor="alt-character-limit" className="block text-[12px] font-semibold text-surface-800">
                Character limit
              </label>
              <input
                id="alt-character-limit"
                type="number"
                inputMode="numeric"
                min={MIN_CHARACTER_LIMIT}
                max={MAX_CHARACTER_LIMIT}
                value={current.characterLimit}
                onChange={(event) => update({ characterLimit: Number.parseInt(event.target.value, 10) || 0 })}
                aria-invalid={limitIssue ? true : undefined}
                aria-describedby={limitIssue ? 'alt-character-limit-error' : undefined}
                className={`mt-1 w-full rounded-md border bg-surface-0 px-2.5 py-1.5 text-[12.5px] text-surface-900 outline-none transition-colors focus:ring-2 ${
                  limitIssue
                    ? 'border-critical-300 focus:border-critical-500 focus:ring-critical-100'
                    : 'border-surface-200 focus:border-brand-400 focus:ring-brand-100'
                }`}
              />
              {limitIssue && (
                <p id="alt-character-limit-error" className="mt-1 text-[11px] font-medium text-critical-700">{limitIssue}</p>
              )}
            </div>

            <div>
              <label htmlFor="alt-auto-format" className="block text-[12px] font-semibold text-surface-800">
                Auto format
              </label>
              <select
                id="alt-auto-format"
                value={current.autoFormat}
                onChange={(event) => update({ autoFormat: event.target.value as AutoFormat })}
                className="mt-1 w-full cursor-pointer rounded-md border border-surface-200 bg-surface-0 px-2 py-1.5 text-[12.5px] text-surface-900 outline-none transition-colors focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              >
                {AUTO_FORMATS.map((format) => (
                  <option key={format} value={format}>{AUTO_FORMAT_LABELS[format]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3 space-y-1.5">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={current.skipExisting}
                onChange={(event) => update({ skipExisting: event.target.checked })}
                className="mt-0.5 h-3.5 w-3.5 cursor-pointer rounded border-surface-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-surface-800">Skip images that already have alt text</span>
                <span className="block text-[10.5px] leading-[1.4] text-surface-500">Existing merchant-written alt text is preserved, never overwritten.</span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={current.removeDuplicateWords}
                onChange={(event) => update({ removeDuplicateWords: event.target.checked })}
                className="mt-0.5 h-3.5 w-3.5 cursor-pointer rounded border-surface-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-surface-800">Remove duplicate words</span>
                <span className="block text-[10.5px] leading-[1.4] text-surface-500">Drops a repeated word, keeping connecting words like "and" and "the".</span>
              </span>
            </label>

            {/* Disabled, with the reason stated. A toggle the merchant could switch on that quietly
                did nothing would be worse than not offering it. */}
            <div className="flex items-start gap-2 rounded-md border border-surface-200 bg-surface-50 px-2 py-1.5">
              <input
                type="checkbox"
                checked={false}
                disabled
                aria-describedby="alt-auto-generate-note"
                className="mt-0.5 h-3.5 w-3.5 cursor-not-allowed rounded border-surface-300"
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-surface-500">Automatically generate for new image uploads</span>
                <span id="alt-auto-generate-note" className="mt-0.5 flex items-start gap-1 text-[10.5px] leading-[1.4] text-surface-500">
                  <Info size={11} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                  {/* The reason was half out of date: Rankvora AI now requests write_products, so
                      "no write access" is no longer true. What is still missing is real — media
                      webhooks to hear about an upload, and a media-specific mutation, since alt
                      text is not written through productUpdate like the SEO fields are. Stating
                      the wrong reason for a correct limitation is its own kind of inaccuracy. */}
                  Not available yet — this needs Shopify media webhooks to hear about an upload, and
                  image alt text is written through a different Shopify mutation than the SEO fields
                  Rankvora AI already saves. Your template is stored and ready for when it lands.
                </span>
              </span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-surface-100 pt-2.5">
            <p className="text-[10.5px] leading-[1.4] text-surface-500">
              Saving stores this template only. Nothing is written to your Shopify store.
            </p>
            <div className="flex items-center gap-2">
              {justSaved && !saving && (
                <span role="status" className="inline-flex items-center gap-1 text-[11px] font-medium text-success-700">
                  <Check size={12} aria-hidden="true" />
                  Template saved
                </span>
              )}
              <button type="button" onClick={save} disabled={!canSave} className="btn-primary btn-xs">
                {saving ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save size={12} aria-hidden="true" />}
                {saving ? 'Saving…' : 'Save template'}
              </button>
            </div>
          </div>

          {saveError && (
            <p role="alert" className="mt-2 flex items-start gap-1 rounded-md border border-critical-100 bg-critical-50 px-2 py-1.5 text-[11.5px] text-critical-700">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              {saveError}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
