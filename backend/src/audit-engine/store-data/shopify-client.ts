import { StoreDataError } from './types.js';

/**
 * Shopify releases a new Admin API version quarterly and supports each for ~12 months.
 * 2026-07 is the current stable (accessible until 2026-07-16 + 12 months). The version this
 * client previously pinned, 2025-01, stopped being accessible in January 2026.
 *
 * Bump this deliberately, not automatically: a new version can change field names, and the
 * queries in shopify.queries.ts are written against THIS version.
 */
export const SHOPIFY_API_VERSION = '2026-07';

/** Injectable so tests can drive pagination / 429 / malformed-response paths without network. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface ShopifyClientOptions {
  shopDomain: string;
  accessToken: string;
  fetchImpl?: FetchLike;
  /** Overridable so tests don't actually sleep through backoff. */
  sleepImpl?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** How long one request may take before it is given up on and retried. Default 45 seconds. */
  requestTimeoutMs?: number;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

/** Shopify's GraphQL calculated-cost extension, returned on every successful response. */
interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLBody<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }> | string;
  extensions?: { cost?: { throttleStatus?: ThrottleStatus } };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Shopify caps every connection at 250 nodes per page. */
const MAX_PAGE_SIZE = 250;

/**
 * The longest one Shopify request may take. A product page is a few megabytes and normally comes back in
 * a few seconds; with no limit at all, a connection that simply stopped answering held the whole
 * analysis — and the merchant's progress bar — in place until the platform's own hour-long cut-off.
 * Timing out turns it into the ordinary network failure the retry loop below already handles.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

/** Start pausing once the shop's query-cost bucket drops below this fraction of its maximum. */
const THROTTLE_FLOOR = 0.2;

export class ShopifyClient {
  private readonly shopDomain: string;
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  /** Serializes calls so we never burst past Shopify's leaky bucket. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: ShopifyClientOptions) {
    this.shopDomain = options.shopDomain;
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private endpoint(): string {
    return `https://${this.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  }

  /** All requests funnel through one promise chain: Shopify's cost budget is per-shop, so
   * issuing them serially (plus cost-driven throttling) is what keeps us inside it. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * One GraphQL request, with transport-level retries. Returns the parsed `data` payload.
   *
   * Retries cover the genuinely transient conditions only — network failure, HTTP 429, HTTP 5xx,
   * and a THROTTLED GraphQL error. A revoked token or a rejected query is permanent and is
   * surfaced immediately rather than retried three times first.
   */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.enqueue(async () => {
      let attempt = 0;

      for (;;) {
        let response: Response;
        try {
          response = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': this.accessToken,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
        } catch (error) {
          // Network-level failure (DNS, timeout, connection reset) — transient by nature.
          if (attempt >= this.maxRetries) {
            throw new StoreDataError('API_UNAVAILABLE', `Shopify request failed: ${error instanceof Error ? error.message : 'network error'}`, true);
          }
          attempt += 1;
          await this.sleepImpl(250 * 2 ** attempt);
          continue;
        }

        if (response.status === 401) {
          throw new StoreDataError('TOKEN_REVOKED', 'Shopify access token is invalid or was revoked — the merchant must reconnect the store', false);
        }
        if (response.status === 403) {
          throw new StoreDataError('MISSING_SCOPES', 'Shopify denied access to this resource — the app is missing a required scope', false);
        }
        if (response.status === 429) {
          if (attempt >= this.maxRetries) throw new StoreDataError('RATE_LIMITED', 'Shopify rate limit exceeded after retries', true);
          const retryAfter = Number(response.headers.get('Retry-After') ?? '2');
          attempt += 1;
          await this.sleepImpl(Math.max(1000, retryAfter * 1000));
          continue;
        }
        if (response.status >= 500) {
          if (attempt >= this.maxRetries) throw new StoreDataError('API_UNAVAILABLE', `Shopify API error ${response.status}`, true);
          attempt += 1;
          await this.sleepImpl(250 * 2 ** attempt);
          continue;
        }
        if (!response.ok) {
          throw new StoreDataError('API_UNAVAILABLE', `Shopify API error ${response.status}`, false);
        }

        let body: GraphQLBody<T>;
        try {
          body = (await response.json()) as GraphQLBody<T>;
        } catch {
          throw new StoreDataError('MALFORMED_RESPONSE', 'Shopify returned a non-JSON GraphQL body', false);
        }

        const errors = normalizeErrors(body.errors);
        if (errors.length > 0) {
          if (errors.some((error) => error.code === 'THROTTLED')) {
            if (attempt >= this.maxRetries) throw new StoreDataError('RATE_LIMITED', 'Shopify rate limit exceeded after retries', true);
            attempt += 1;
            await this.sleepImpl(this.throttleWaitMs(body.extensions?.cost?.throttleStatus, attempt));
            continue;
          }
          if (errors.some((error) => error.code === 'ACCESS_DENIED')) {
            throw new StoreDataError('MISSING_SCOPES', `Shopify denied access: ${errors.map((error) => error.message).join('; ')}`, false);
          }
          // A schema/field error is our bug, not the merchant's — surface the message so it is
          // diagnosable. These messages describe the QUERY, never the merchant's data.
          throw new StoreDataError('MALFORMED_RESPONSE', `Shopify GraphQL error: ${errors.map((error) => error.message).join('; ')}`, false);
        }

        if (!body.data) throw new StoreDataError('MALFORMED_RESPONSE', 'Shopify GraphQL response contained no data', false);

        // Stay well inside the cost bucket: if the shop's budget is nearly spent, pause for
        // roughly as long as it takes the leaky bucket to refill to a comfortable level.
        const throttle = body.extensions?.cost?.throttleStatus;
        if (throttle && throttle.maximumAvailable > 0 && throttle.currentlyAvailable / throttle.maximumAvailable < THROTTLE_FLOOR) {
          await this.sleepImpl(this.refillMs(throttle));
        }

        return body.data;
      }
    });
  }

  /** How long to wait after a THROTTLED error, floored so a missing cost extension still backs off. */
  private throttleWaitMs(throttle: ThrottleStatus | undefined, attempt: number): number {
    if (!throttle || throttle.restoreRate <= 0) return Math.max(1000, 250 * 2 ** attempt);
    return Math.max(1000, this.refillMs(throttle));
  }

  /** Milliseconds for the leaky bucket to refill back to THROTTLE_FLOOR of its maximum. */
  private refillMs(throttle: ThrottleStatus): number {
    if (throttle.restoreRate <= 0) return 1000;
    const target = throttle.maximumAvailable * THROTTLE_FLOOR;
    const deficit = Math.max(0, target - throttle.currentlyAvailable);
    return Math.min(10_000, Math.ceil((deficit / throttle.restoreRate) * 1000));
  }

  /**
   * Walks a cursor-paginated connection until the requested limit is reached or Shopify says
   * there are no more pages.
   *
   * `limit` caps TOTAL nodes returned (scope control for large stores). The caller learns whether
   * it stopped early via the returned `truncated` flag rather than silently receiving a partial
   * list. The query MUST accept `$first: Int!` and `$after: String` and return `pageInfo
   * { hasNextPage endCursor }` alongside `nodes`.
   */
  async paginate<T, D>(
    query: string,
    select: (data: D) => Connection<T> | null | undefined,
    limit: number,
    variables: Record<string, unknown> = {},
    /** Called after each page with the number of items read so far — for progress reporting. */
    onPage?: (itemsRead: number) => Promise<void> | void,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    // A cursor that never advances would loop forever; Shopify has no reason to do that, but a
    // proxy or a shape change could, and an unbounded loop in a worker is not recoverable.
    const seenCursors = new Set<string>();

    while (hasNextPage && items.length < limit) {
      const first: number = Math.min(MAX_PAGE_SIZE, limit - items.length);
      const data: D = await this.graphql<D>(query, { ...variables, first, after: cursor });
      const connection = select(data);

      if (!connection || !Array.isArray(connection.nodes)) {
        throw new StoreDataError('MALFORMED_RESPONSE', 'Shopify GraphQL response did not contain the expected connection', false);
      }

      items.push(...connection.nodes);
      await onPage?.(Math.min(items.length, limit));
      hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
      cursor = connection.pageInfo?.endCursor ?? null;

      if (!cursor) break;
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }

    return { items: items.slice(0, limit), truncated: hasNextPage && items.length >= limit };
  }
}

/** Shopify returns `errors` either as a GraphQL error array or, for auth failures, a bare string. */
function normalizeErrors(errors: GraphQLBody<unknown>['errors']): Array<{ message: string; code?: string }> {
  if (!errors) return [];
  if (typeof errors === 'string') return [{ message: errors }];
  if (!Array.isArray(errors)) return [];
  return errors.map((error) => ({ message: error.message ?? 'unknown error', code: error.extensions?.code }));
}
