import { useCallback, useEffect, useState } from 'react';
import { scrollChaining } from '../../lib/scrollChaining';
import { AlertCircle, Bot, CheckCircle2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import {
  fetchTestableBots,
  runBotTest,
  type BotTestResult,
  type TestableBot,
} from '../../data/aiDiscovery.repository';
import { ApiError } from '../../lib/api';
import { cardClass } from '../dashboard/scoreTone';
import { Button, StatusBadge } from '../workflows/WorkflowPrimitives';

/**
 * ─── Test as a bot ───────────────────────────────────────────────────
 *
 * Really requests one of the store's own URLs with a named crawler's real User-Agent, right now,
 * and shows both what robots.txt said and what the server actually returned.
 *
 * ─── The two facts are shown separately, always ──────────────────────
 * robots.txt permission and the HTTP response are independent, and they disagree more often than
 * merchants expect: a CDN can serve a challenge page to a crawler robots.txt admits, and a store
 * can be perfectly crawlable while robots.txt forbids it. Showing one as the other would hide
 * exactly the case worth finding, so this panel renders them as two rows that can contradict.
 *
 * ─── A crawler with no User-Agent is offered but not faked ───────────
 * Google-Extended and anthropic-ai are robots.txt tokens with no header of their own. They appear
 * in the list, disabled, with the reason stated — rather than silently missing (which reads as an
 * oversight) or probed with an invented string (which would be a fabricated result).
 */

const DEFAULT_PATH = '/';

function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not reach the Rankvora AI API. Check that the backend is running.';
  if (error.status === 404 && error.code !== 'STORE_NOT_FOUND') {
    return 'This server has no bot-test endpoint. The API is running an older build — redeploy and restart it.';
  }
  if (error.status === 401) return 'Your session has expired. Sign in again, then reopen this page.';
  return error.message;
}

/** One of the two independent facts. `ok` drives only the icon; the detail carries the meaning. */
function FactRow({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  const Icon = ok === null ? AlertCircle : ok ? CheckCircle2 : XCircle;
  const tone = ok === null ? 'text-surface-400' : ok ? 'text-success-600' : 'text-critical-600';
  return (
    <div className="flex items-start gap-2 px-3 py-1.5">
      <Icon size={14} className={`mt-0.5 flex-shrink-0 ${tone}`} />
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-surface-900">{label}</p>
        <p className="text-[11.5px] leading-[1.45] text-surface-600">{detail}</p>
      </div>
    </div>
  );
}

export default function BotTestPanel() {
  const [bots, setBots] = useState<TestableBot[]>([]);
  const [bot, setBot] = useState('');
  const [path, setPath] = useState(DEFAULT_PATH);
  const [result, setResult] = useState<BotTestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await fetchTestableBots();
        setBots(list);
        // Default to the first crawler that can actually be probed, so the form is usable without
        // the merchant first discovering that some entries are rules-only.
        setBot(list.find((entry) => entry.probeable)?.name ?? '');
      } catch (caught) {
        setError(describeFailure(caught));
      }
    })();
  }, []);

  const run = useCallback(async () => {
    if (!bot) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await runBotTest(bot, path || DEFAULT_PATH));
    } catch (caught) {
      setResult(null);
      setError(describeFailure(caught));
    } finally {
      setRunning(false);
    }
  }, [bot, path]);

  const selected = bots.find((entry) => entry.name === bot);

  return (
    <section className={cardClass} aria-labelledby="bot-test-title">
      <div className="border-b border-surface-100 px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-surface-500">Diagnostic</p>
        <h2 id="bot-test-title" className="mt-1 flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-surface-950">
          <Bot size={15} className="text-brand-500" />
          Test as a bot
        </h2>
        <p className="mt-1 text-[12px] leading-[1.45] text-surface-500">
          Fetches one of your pages with a crawler’s real User-Agent and shows exactly what it receives.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2.5 px-3 py-2.5">
        <label className="min-w-[180px] flex-1">
          <span className="mb-1 block text-[11px] font-medium text-surface-600">Crawler</span>
          <select
            value={bot}
            onChange={(event) => setBot(event.target.value)}
            className="w-full rounded-lg border border-surface-200 bg-surface-0 px-2.5 py-1.5 text-[12.5px] text-surface-900"
          >
            {bots.map((entry) => (
              <option key={entry.name} value={entry.name} disabled={!entry.probeable}>
                {entry.name} — {entry.vendor}
                {entry.probeable ? '' : ' (robots.txt token only)'}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-[180px] flex-1">
          <span className="mb-1 block text-[11px] font-medium text-surface-600">Path on your store</span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/"
            className="w-full rounded-lg border border-surface-200 bg-surface-0 px-2.5 py-1.5 text-[12.5px] text-surface-900"
          />
        </label>

        <Button onClick={() => void run()} disabled={running || !bot || !selected?.probeable}>
          {running ? 'Fetching…' : 'Run test'}
        </Button>
      </div>

      {selected && (
        <p className="px-3 pb-2 text-[11.5px] leading-[1.45] text-surface-500">{selected.effect}</p>
      )}

      {running && (
        <div className="flex items-center gap-2 border-t border-surface-100 px-3 py-3.5 text-[12.5px] text-surface-500">
          <Loader2 size={14} className="animate-spin" />
          Requesting as {bot}…
        </div>
      )}

      {!running && error && (
        <div className="flex items-start gap-2 border-t border-surface-100 px-3 py-3">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-warning-600" />
          <p className="text-[12.5px] leading-[1.5] text-surface-700">{error}</p>
        </div>
      )}

      {!running && !error && result && (
        <div className="border-t border-surface-100">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <p className="min-w-0 break-all text-[12px] text-surface-600">{result.url}</p>
            <StatusBadge
              label={result.response.status === null ? 'No response' : `HTTP ${result.response.status}`}
              // Keyed off the status itself, not off `error`. A null status means no response came
              // back at all — reading that through `?? 0` would compute 0 < 300 and paint a failed
              // request green, which is the one thing this badge must never do.
              tone={
                result.response.status === null
                  ? 'critical'
                  : result.response.status < 300
                    ? 'success'
                    : 'warning'
              }
            />
          </div>

          <p className="border-y border-surface-100 bg-surface-50 px-3 py-2 text-[12.5px] leading-[1.5] text-surface-800">
            {result.summary}
          </p>

          {/* The two independent facts. See the header for why they are never merged. */}
          <FactRow
            ok={result.robots.allowed}
            label={result.robots.allowed ? 'robots.txt allows this crawler' : 'robots.txt blocks this crawler'}
            detail={[
              result.robots.fetched ? 'Read from your live robots.txt.' : 'robots.txt could not be fetched, so the spec default (allow) was applied.',
              result.robots.hasSpecificGroup
                ? `A rule group names ${result.bot.name} exactly.`
                : `No group names ${result.bot.name}; it falls through to the “*” rules, so a rule meant for another bot can change this.`,
              result.robots.crawlDelaySeconds !== null ? `Crawl-delay: ${result.robots.crawlDelaySeconds}s.` : '',
            ].filter(Boolean).join(' ')}
          />

          <FactRow
            // null = could not be measured, which is neither a pass nor a fail. Never inferred
            // from a substituted status code.
            ok={result.response.status === null ? null : result.response.status >= 200 && result.response.status < 300}
            label="What your server returned"
            detail={
              result.response.error
                ? result.response.error
                : `HTTP ${result.response.status} · ${result.response.contentType ?? 'no content-type'} · ${result.response.bytes.toLocaleString()} bytes`
            }
          />

          {result.response.passwordGated && (
            <div className="flex items-start gap-2 border-t border-surface-100 bg-warning-50 px-3 py-2">
              <ShieldAlert size={14} className="mt-0.5 flex-shrink-0 text-warning-700" />
              <p className="text-[12px] leading-[1.45] text-warning-800">
                Your storefront is password protected. This crawler received the password page, not your content — and so
                does every other bot, right now.
              </p>
            </div>
          )}

          {/* What the crawler could actually read. Truncated server-side; the length is stated so the
              preview is never mistaken for the whole page. */}
          {result.content.textPreview && (
            <div className="border-t border-surface-100 px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-surface-500">
                  What {result.bot.name} can read
                </p>
                <p className="text-[11px] tabular-nums text-surface-500">
                  {result.content.textLength.toLocaleString()} characters of visible text
                </p>
              </div>
              {result.content.title && (
                <p className="mt-1.5 text-[12.5px] font-medium text-surface-900">{result.content.title}</p>
              )}
              <p ref={scrollChaining} className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-[1.5] text-surface-600">
                {result.content.textPreview}
              </p>
            </div>
          )}

          <p className="border-t border-surface-100 px-3 py-1.5 text-[11px] text-surface-500">
            User-Agent sent: <code className="break-all text-surface-600">{result.bot.userAgent}</code>
          </p>
        </div>
      )}
    </section>
  );
}
