import { format } from 'node:util';

/**
 * ─── Server logging ──────────────────────────────────────────────────
 *
 * The API logs through `console`, and pm2 writes stdout to one file and stderr to another. That
 * stays as it is — every existing `[scorelo-*]` line is written where it always was. What this
 * module fixes is whether those lines can be trusted when something has gone wrong.
 *
 * WHEN. No line carried a time. pm2 is started without --time, so a log file was a list of events
 * with no way to say when any of them happened, or to line one up with a merchant's report of
 * "it failed around three". installLogFormat() puts an ISO timestamp and a level on every line.
 *
 * WHY, WITHOUT WHAT WAS IN IT. Most failures here are database errors, and drizzle's message is
 * "Failed query: <sql>\nparams: <every bound value>". Logged as-is — which is what the
 * `error.message` in every catch block did — a failed write put its values into the log: email
 * addresses, password hashes, encrypted Shopify tokens, notification text, across several lines.
 * And it STILL never said why the query failed: the driver's reason lives on `error.cause`, which
 * nothing printed. A
 * migration that could not reach MySQL logged "Failed query: create table if not exists
 * `__drizzle_migrations`" and nothing else — no ECONNREFUSED anywhere. describeError() keeps the
 * SQL, drops the values, and adds the reason.
 *
 * Logs are read by more people than the database is, so anything that
 * identifies a person — an email address, a row's value quoted back by MySQL — is redacted here,
 * in the one function every failure passes through, rather than at each call site.
 */

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** MySQL quotes the offending row value back in these: "Duplicate entry 'a@b.c' for key …",
 * "Incorrect integer value: 'abc' for column …". The value is the part that must not be logged. */
const QUOTED_ROW_VALUE = /(Duplicate entry |value: )'(?:[^'\\]|\\.)*'/g;

function redact(text: string): string {
  return text.replace(QUOTED_ROW_VALUE, "$1'[redacted]'").replace(EMAIL, '[email]');
}

/** Drizzle appends every bound value after "\nparams:". The SQL before it is kept. */
function withoutParams(message: string): string {
  const index = message.indexOf('\nparams:');
  return index === -1 ? message : message.slice(0, index);
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function errorCode(error: object): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** One error, without its cause: "CODE: message", redacted, on one line. */
function describeOne(error: Error): string {
  const message = oneLine(redact(withoutParams(error.message)));
  const code = errorCode(error);
  if (!message) return code ?? error.name;
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

/**
 * A failure as one safe, readable line: what failed, and — through the `cause` chain — why.
 *
 *   "Failed query: insert into `notifications` … — caused by ER_NO_REFERENCED_ROW_2: Cannot add or
 *    update a child row: a foreign key constraint fails (…)"
 *
 * Never includes drizzle's bound parameters, an email address, or a row value MySQL quoted back.
 * Use it wherever a caught error is written to a log line, instead of `error.message`.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [describeOne(error)];
    let cause: unknown = error.cause;
    // Three levels is every chain this codebase produces (drizzle → database driver → underlying error);
    // the bound stops a cyclic cause from looping.
    for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth += 1) {
      if (cause instanceof Error) {
        parts.push(`caused by ${describeOne(cause)}`);
        cause = cause.cause;
      } else {
        parts.push(`caused by ${oneLine(redact(String(cause)))}`);
        break;
      }
    }
    return parts.join(' — ');
  }
  if (typeof error === 'string') return oneLine(redact(error)) || 'unknown error';
  return 'unknown error';
}

/**
 * describeError plus the stack FRAMES, for the failures nobody anticipated (a 500, a crashed job).
 *
 * Only the "    at …" lines are taken from `error.stack`: its first line repeats the message, and
 * for a query error that is the unredacted SQL with every bound value.
 */
export function describeErrorWithStack(error: unknown): string {
  const summary = describeError(error);
  if (!(error instanceof Error)) return summary;
  const label = errorLabel(error);
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
  return frames.length > 0 ? `${label}: ${summary}\n${frames.join('\n')}` : `${label}: ${summary}`;
}

/**
 * The error's class. `name` first, but drizzle's DrizzleQueryError leaves it as the generic
 * "Error", which says nothing — the constructor name does.
 */
function errorLabel(error: Error): string {
  if (error.name && error.name !== 'Error') return error.name;
  const constructorName = error.constructor?.name;
  return constructorName && constructorName !== 'Object' ? constructorName : 'Error';
}

/**
 * A value that came from outside — a query string, a header, text a browser sent — made safe to
 * put in a log line: quoted, with newlines escaped, and capped. Without this, a value containing
 * "\n2026-09-24T… ERROR [scorelo-api] …" can write a fake line into the log.
 */
export function logValue(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : String(value);
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
}

/**
 * One formatted line: "<ISO time> <LEVEL> <message>". Error arguments are rendered through
 * describeErrorWithStack, so `console.error('…', error)` gets the same redaction as everything else.
 *
 * Exported so the format is tested directly.
 */
export function formatLogLine(level: Level, args: unknown[], now: Date = new Date()): string {
  const rendered = args.map((arg) => (arg instanceof Error ? describeErrorWithStack(arg) : arg));
  return `${now.toISOString()} ${level.padEnd(5)} ${format(...rendered)}`;
}

const LEVEL_BY_METHOD = {
  debug: 'DEBUG',
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
} as const satisfies Record<string, Level>;

let installed = false;

/**
 * Puts a timestamp and level on every console line this process writes — the API's own, and any a
 * library writes. Called once, first thing in server.ts. Calling it twice is a no-op.
 *
 * Not called by tests or the CLI scripts: their output is read in a terminal, as it happens.
 */
export function installLogFormat(): void {
  if (installed) return;
  installed = true;

  const target = console as unknown as Record<keyof typeof LEVEL_BY_METHOD, (...args: unknown[]) => void>;
  for (const [method, level] of Object.entries(LEVEL_BY_METHOD) as Array<[keyof typeof LEVEL_BY_METHOD, Level]>) {
    const original = target[method].bind(console);
    target[method] = (...args: unknown[]) => original(formatLogLine(level, args));
  }
}
