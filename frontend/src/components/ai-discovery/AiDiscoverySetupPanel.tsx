import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import {
  addPromptQuery,
  deletePromptQuery,
  fetchAgentFiles,
  fetchAiDiscoverySettings,
  mentionRate,
  removeIndexNowKey,
  runPromptSweep,
  saveIndexNowKey,
  setPromptQueryActive,
  type AiDiscoverySettings,
  type GeneratedAgentFiles,
  type GeneratedFile,
  type PromptQuery,
} from '../../data/aiDiscovery.repository';
import { Field, SettingsCard, TextInput } from '../settings/SettingsPrimitives';
import Button from '../../components/polaris/Button';

/**
 * ─── AI Discovery · setup ────────────────────────────────────────────
 * The last panel of the AI Discovery dashboard (it lived in Settings until that page was removed).
 * Where the merchant supplies the two things the AI Discovery pillar cannot discover on its own,
 * and where the generated agent files are previewed.
 *
 * NOTHING ON THIS PAGE IS A PLACEHOLDER. A store that has set nothing up sees an empty state that
 * says so. There is no example key and no suggested question, because a merchant cannot tell a
 * prefilled suggestion apart from something they already configured — and in the prompt-tracking
 * case a suggested question would go on to be measured and reported as their visibility.
 */

/** The panel's element id — PromptTrendPanel scrolls to it when it has nothing to chart. */
export const AI_DISCOVERY_SETUP_ID = 'ai-discovery-setup';

/** "1 policy", "3 policies" — every count on this page is read by a person. */
function countOf(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * Puts a control with no label of its own on the same line as the inputs beside it.
 *
 * Field renders `label`, then `mt-1`, then the control, so a bare button dropped into the same row
 * sits one label-height too high. These rows used `items-end` instead, which lines up the BOTTOMS —
 * and a field carrying a hint is taller at the bottom than one without, so "Brand name to look for"
 * and the Track button floated above the question input they belong beside.
 *
 * Mirroring Field's own spacing with an empty label keeps everything on the input line whatever the
 * labels and hints do, without a magic pixel margin that breaks the first time a label wraps.
 */
function OnTheInputLine({ children }: { children: ReactNode }) {
  return (
    <div>
      <span aria-hidden="true" className="block select-none text-[12.5px] font-semibold">&nbsp;</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused (insecure context, permissions). The textarea below is
      // selectable, so the merchant is never stuck — but we must not claim a copy that failed.
      setCopied(false);
    }
  };

  return (
    <Button variant="secondary" onClick={copy} accessibilityLabel={`Copy ${label}`}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function FilePreview({ file }: { file: GeneratedFile }) {
  const download = () => {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.path.replace(/^\//, '');
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-lg border border-surface-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-200 px-2.5 py-1.5">
        <div>
          <span className="font-mono text-[11.5px] font-semibold text-surface-900">{file.path}</span>
          <span className="ml-2 text-[11px] text-surface-500">{file.bytes.toLocaleString()} bytes</span>
        </div>
        <div className="flex items-center gap-1.5">
          <CopyButton value={file.content} label={file.path} />
          <Button variant="secondary" onClick={download}>
            Download
          </Button>
        </div>
      </div>
      <textarea
        readOnly
        value={file.content}
        rows={8}
        spellCheck={false}
        className="w-full resize-y border-0 bg-surface-50/50 p-2.5 font-mono text-[11px] leading-[1.5] text-surface-800 focus:outline-none"
        aria-label={`${file.path} contents`}
      />
      {(file.includes.length > 0 || file.omitted.length > 0) && (
        <div className="space-y-1 border-t border-surface-200 px-2.5 py-1.5 text-[11px] leading-[1.45]">
          {file.includes.length > 0 && (
            <p className="text-surface-600">
              <span className="font-semibold text-surface-800">Built from:</span> {file.includes.join(' · ')}
            </p>
          )}
          {/* Stated rather than hidden: the merchant should know exactly why a section is absent. */}
          {file.omitted.map((reason) => (
            <p key={reason} className="text-warning-700">
              <span className="font-semibold">Not included:</span> {reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function PromptQueryRow({
  query,
  minSamples,
  healthyRate,
  onToggle,
  onDelete,
  busy,
}: {
  query: PromptQuery;
  minSamples: number;
  /** The check's own band, from the API. This used to be a retyped copy of it (0.4). */
  healthyRate: number;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const rate = mentionRate(query, minSamples);
  const samples = query.observations.length;
  const mentions = query.observations.filter((observation) => observation.mentioned).length;
  const quoted = query.observations.find((observation) => observation.mentioned)?.mentionContext;

  // Three genuinely different states, never collapsed into one another.
  const status =
    samples === 0
      ? { text: 'Not checked yet', tone: 'text-surface-500' }
      : rate === null
        ? { text: `${mentions} of ${samples} checks — too few for a rate`, tone: 'text-surface-500' }
        : { text: `Mentioned in ${mentions} of ${samples} checks (${Math.round(rate * 100)}%)`, tone: rate >= healthyRate ? 'text-success-700' : 'text-warning-700' };

  return (
    <li className="flex flex-col gap-1 border-b border-surface-200 py-2 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`truncate text-[12px] font-semibold ${query.active ? 'text-surface-900' : 'text-surface-400 line-through'}`}>
            {query.query}
          </p>
          <p className={`text-[11px] ${status.tone}`}>{status.text}</p>
          <p className="text-[10.5px] text-surface-400">Looking for “{query.brandTerm}”</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" disabled={busy} onClick={() => onToggle(!query.active)}>
            {query.active ? 'Pause' : 'Resume'}
          </Button>
          <Button variant="danger" disabled={busy} onClick={onDelete} accessibilityLabel={`Delete question: ${query.query}`} icon="delete" />
        </div>
      </div>
      {quoted && (
        <p className="rounded bg-surface-50 px-2 py-1 text-[10.5px] italic leading-[1.45] text-surface-600">
          “{quoted}”
        </p>
      )}
    </li>
  );
}

export default function AiDiscoverySetupPanel() {
  const [settings, setSettings] = useState<AiDiscoverySettings | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualKey, setManualKey] = useState('');
  const [newQuery, setNewQuery] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [files, setFiles] = useState<GeneratedAgentFiles | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await fetchAiDiscoverySettings());
      setState('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Setup could not be loaded.');
      setState('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Wraps a mutation so one failure never leaves the page claiming success. */
  const mutate = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return <div className="py-6 text-center text-[12px] text-surface-500" aria-busy="true">Loading…</div>;
  }
  if (state === 'error' || !settings) {
    return (
      <div className="rounded-lg border border-critical-200 bg-critical-50 px-3 py-2 text-[12px] text-critical-800">
        {error ?? 'Setup could not be loaded.'}
      </div>
    );
  }

  const { indexNow, promptTracking } = settings;
  const keyUrl = indexNow.indexNowKey ? `/${indexNow.indexNowKey}.txt` : null;

  return (
    <div id={AI_DISCOVERY_SETUP_ID} className="scroll-mt-3 space-y-3">
      {error && (
        <div className="flex items-start gap-1.5 rounded-lg border border-critical-200 bg-critical-50 px-3 py-2 text-[12px] text-critical-800">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── IndexNow ──────────────────────────────────────────── */}
      <SettingsCard title="IndexNow key">
        {indexNow.indexNowKey ? (
          <div className="space-y-2">
            <Field label="Your key" htmlFor="indexnow-key" hint={indexNow.indexNowKeySetAt ? `Set ${new Date(indexNow.indexNowKeySetAt).toLocaleDateString()}` : undefined}>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded border border-surface-200 bg-surface-50 px-2 py-1.5 font-mono text-[11.5px] text-surface-800">
                  {indexNow.indexNowKey}
                </code>
                <CopyButton value={indexNow.indexNowKey} label="IndexNow key" />
              </div>
            </Field>

            <div className="rounded-lg border border-surface-200 bg-surface-50/60 px-2.5 py-2 text-[11.5px] leading-[1.5] text-surface-700">
              <p className="font-semibold text-surface-900">Publish at</p>
              <code className="mt-1 block font-mono text-[11px] text-surface-800">{keyUrl}</code>
              <p className="mt-1">The file must contain only the key.</p>
              {/* The Shopify constraint, said plainly — and only what is actually known. This used to
                  state that a CDN-hosted file "will not satisfy IndexNow" (unverified: the spec does
                  not say) and to recommend an app proxy, which Shopify serves only under /apps/ and
                  so can never cover /products/. */}
              <p className="mt-1.5 text-warning-700">
                Shopify cannot host root files: upload under Content → Files and redirect this path to it.
              </p>
            </div>

            <Button variant="danger" disabled={busy} onClick={() => mutate(async () => { setSettings({ ...settings, indexNow: await removeIndexNowKey() }); })}>
              Remove key
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Same idiom as the prompt-tracking row below: the two bare controls are pushed onto
                the input line rather than bottom-aligned against a field whose height depends on
                whether it happens to carry a hint. */}
            <div className="grid gap-2 sm:grid-cols-[auto_auto_minmax(0,1fr)] sm:items-start">
              <OnTheInputLine>
                <Button loading={busy} variant="primary" disabled={busy} onClick={() => mutate(async () => { setSettings({ ...settings, indexNow: await saveIndexNowKey() }); })}>
                  Generate key
                </Button>
              </OnTheInputLine>
              <OnTheInputLine>
                <span className="block py-1.5 text-center text-[11px] text-surface-500 sm:text-left">or</span>
              </OnTheInputLine>
              <Field label="Use an existing key" htmlFor="manual-key">
                <div className="flex gap-1.5">
                  <TextInput id="manual-key" value={manualKey} onChange={setManualKey} placeholder="32 hexadecimal characters" />
                  <Button variant="secondary" disabled={busy || !manualKey.trim()} onClick={() => mutate(async () => {
                      setSettings({ ...settings, indexNow: await saveIndexNowKey(manualKey.trim()) });
                      setManualKey('');
                    })}>
                    Save
                  </Button>
                </div>
              </Field>
            </div>
          </div>
        )}
      </SettingsCard>

      {/* ── Prompt tracking ───────────────────────────────────── */}
      <SettingsCard title="Prompt tracking">
        {!promptTracking.aiConfigured && (
          <div className="mb-2 rounded-lg border border-warning-200 bg-warning-50 px-2.5 py-2 text-[11.5px] leading-[1.5] text-warning-800">
            No AI provider configured. Set
            <code className="mx-1 font-mono">AI_PROVIDER</code> and its API key.
          </div>
        )}

        <div className="space-y-2">
          {/* Two equal columns, not `flex-1` against a bare min-width: the question field used to
              take every spare pixel and leave the brand field at its 160px floor, so one input was
              three times the other for no reason either of them could explain. */}
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
            <Field label="Shopper question" htmlFor="new-query">
              {/* An instruction, not an example. The old placeholder was a sample question about dog
                  coats — for every store, whatever it sells — on the one input this page promises
                  never to pre-fill with a suggestion. */}
              <TextInput id="new-query" value={newQuery} onChange={setNewQuery} placeholder="Type it the way a shopper would" />
            </Field>
            <Field label="Brand name" htmlFor="new-brand">
              <TextInput id="new-brand" value={newBrand} onChange={setNewBrand} placeholder="Defaults to your store name" />
            </Field>
            <OnTheInputLine>
              <Button variant="primary" disabled={busy || !newQuery.trim() || promptTracking.queries.length >= promptTracking.maxQueries} onClick={() => mutate(async () => {
                  await addPromptQuery(newQuery.trim(), newBrand.trim() || undefined);
                  setNewQuery('');
                  setNewBrand('');
                  await load();
                })}>
                Track
              </Button>
            </OnTheInputLine>
          </div>

          <p className="text-[11px] text-surface-500">
            {promptTracking.queries.length} of {promptTracking.maxQueries} questions tracked
            {promptTracking.model && <> · <code className="font-mono">{promptTracking.model}</code></>}
          </p>

          {promptTracking.queries.length === 0 ? (
            <p className="rounded-lg border border-dashed border-surface-300 px-3 py-3 text-center text-[11.5px] text-surface-500">
              No questions tracked yet.
            </p>
          ) : (
            <>
              <ul className="rounded-lg border border-surface-200 px-2.5">
                {promptTracking.queries.map((query) => (
                  <PromptQueryRow
                    key={query.id}
                    query={query}
                    minSamples={promptTracking.minSamples}
                    healthyRate={promptTracking.healthyRate}
                    busy={busy}
                    onToggle={(active) => mutate(async () => {
                      await setPromptQueryActive(query.id, active);
                      await load();
                    })}
                    onDelete={() => mutate(async () => {
                      await deletePromptQuery(query.id);
                      await load();
                    })}
                  />
                ))}
              </ul>

              <Button loading={busy} variant="secondary" disabled={busy || !promptTracking.aiConfigured || promptTracking.queries.every((query) => !query.active)} onClick={() => mutate(async () => {
                  setSweepNote(null);
                  const result = await runPromptSweep();
                  await load();
                  setSweepNote(
                    result.failures.length > 0
                      ? `Asked ${result.checked}; ${result.mentioned} named your store. ${result.failures.length} failed.`
                      : `Asked ${result.checked}; ${result.mentioned} named your store.`,
                  );
                })}>
                Check all now
              </Button>
              {sweepNote && <p className="text-[11px] text-surface-600">{sweepNote}</p>}
            </>
          )}
        </div>
      </SettingsCard>

      {/* ── Generated agent files ─────────────────────────────── */}
      <SettingsCard title="llms.txt and agents.md">
        <div className="space-y-2">
          <Button loading={generating} variant="primary" disabled={generating} onClick={async () => {
              setGenerating(true);
              setError(null);
              try {
                setFiles(await fetchAgentFiles());
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'The files could not be generated.');
              } finally {
                setGenerating(false);
              }
            }}>
            {files ? 'Regenerate' : 'Generate files'}
          </Button>

          {files && (
            <>
              <p className="text-[11px] text-surface-500">
                Built from {countOf(files.source.products, 'published product', 'published products')},{' '}
                {countOf(files.source.collections, 'collection', 'collections')}, {countOf(files.source.pages, 'page', 'pages')} and{' '}
                {countOf(files.source.policies, 'policy', 'policies')}, read {new Date(files.source.capturedAt).toLocaleString()}.
                {files.source.unpublishedProducts > 0 && ` ${countOf(files.source.unpublishedProducts, 'unpublished product', 'unpublished products')} left out.`}
                {files.source.productsTruncated && ' Catalog only partly read.'}
              </p>
              <FilePreview file={files.llmsTxt} />
              <FilePreview file={files.agentsMd} />
              <FilePreview file={files.llmsFullTxt} />
            </>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
