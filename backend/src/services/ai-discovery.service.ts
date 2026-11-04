import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { aiDiscoverySettings, promptChecks, promptQueries, stores } from '../db/schema.js';
import { aiConfigured } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import type {
  SnapshotAiDiscovery,
  SnapshotPromptObservation,
  SnapshotPromptQuery,
} from '../audit-engine/store-data/types.js';

/**
 * ─── AI Discovery configuration ──────────────────────────────────────
 * The merchant-owned inputs the AI Discovery pillar needs, and the only place they are read or
 * written.
 *
 * TWO THINGS LIVE HERE AND THEY ARE DIFFERENT IN KIND
 *
 *   1. The IndexNow key. A credential the merchant publishes at their own storefront root. Rankvora AI
 *      can GENERATE one, because the IndexNow spec says a key is self-generated and carries no
 *      meaning beyond being unguessable — a random string is the correct value, not a fabricated
 *      measurement. What Rankvora AI will never do is assume the key file exists: verification is a
 *      real HTTP request whose result is reported as it came back.
 *
 *   2. Prompt-tracking queries. The merchant's own questions. Rankvora AI does NOT suggest, seed or
 *      infer these. A generated query list would measure Rankvora AI's guess at what shoppers ask and
 *      then report the answer as the store's AI visibility, which is a fabricated number wearing a
 *      real one's clothes. A store with no queries has nothing to measure and says so.
 *
 * How many samples make a rate: see PROMPT_MIN_SAMPLES.
 */

/** IndexNow keys are hexadecimal, 8–128 characters. Shared with the crawler's path guard. */
const INDEXNOW_KEY_PATTERN = /^[a-f0-9]{8,128}$/i;

/** 32 hex characters — the length IndexNow's own documentation uses in its examples. */
const GENERATED_KEY_BYTES = 16;

/** A merchant cannot track more than this many questions. Each one is a recurring API bill. */
export const MAX_PROMPT_QUERIES = 25;

/**
 * Observations kept per query when building a snapshot.
 *
 * Bounded because the whole history would grow without limit and only the recent window describes
 * the store as it is now. Large enough that a rate computed from it is not dominated by one run.
 */
export const PROMPT_OBSERVATION_WINDOW = 30;

export interface AiDiscoveryConfig {
  indexNowKey: string | null;
  indexNowKeySetAt: string | null;
}

/** The store's settings row, or the honest empty state when it has none yet. */
export async function getAiDiscoveryConfig(storeId: number): Promise<AiDiscoveryConfig> {
  const [row] = await db
    .select()
    .from(aiDiscoverySettings)
    .where(eq(aiDiscoverySettings.storeId, storeId))
    .limit(1);

  return {
    indexNowKey: row?.indexNowKey ?? null,
    indexNowKeySetAt: row?.indexNowKeySetAt ? row.indexNowKeySetAt.toISOString() : null,
  };
}

/**
 * Stores an IndexNow key for a store, generating one when the caller supplies none.
 *
 * The key is validated before it is stored because it later becomes a URL path. An invalid key
 * would either be refused by the crawler (reporting a configuration error the merchant cannot see
 * the cause of) or, worse, interpolated into a request. Rejecting it at the boundary means the
 * merchant is told immediately, in the place they typed it.
 */
export async function setIndexNowKey(storeId: number, key?: string | null): Promise<AiDiscoveryConfig> {
  const value = key?.trim() ? key.trim() : randomBytes(GENERATED_KEY_BYTES).toString('hex');
  if (!INDEXNOW_KEY_PATTERN.test(value)) {
    throw new ApiError(400, 'An IndexNow key must be 8–128 hexadecimal characters (0-9, a-f).', 'INDEXNOW_KEY_INVALID');
  }

  const setAt = new Date();
  await db
    .insert(aiDiscoverySettings)
    .values({ storeId, indexNowKey: value, indexNowKeySetAt: setAt, updatedAt: setAt })
    .onConflictDoUpdate({ target: aiDiscoverySettings.storeId, set: { indexNowKey: value, indexNowKeySetAt: setAt, updatedAt: setAt } });

  return { indexNowKey: value, indexNowKeySetAt: setAt.toISOString() };
}

/** Forgets the key. The next audit reports IndexNow as not configured, which is then true. */
export async function clearIndexNowKey(storeId: number): Promise<AiDiscoveryConfig> {
  await db
    .update(aiDiscoverySettings)
    .set({ indexNowKey: null, indexNowKeySetAt: null, updatedAt: new Date() })
    .where(eq(aiDiscoverySettings.storeId, storeId));
  return { indexNowKey: null, indexNowKeySetAt: null };
}

export interface PromptQueryRecord {
  id: number;
  query: string;
  brandTerm: string;
  active: boolean;
  createdAt: string;
  /** Real observations only. An empty list means this question has never been asked. */
  observations: SnapshotPromptObservation[];
}

/** Every tracked question for a store, each with its recent real observations. */
export async function listPromptQueries(storeId: number): Promise<PromptQueryRecord[]> {
  const queries = await db
    .select()
    .from(promptQueries)
    .where(eq(promptQueries.storeId, storeId))
    .orderBy(promptQueries.id);

  if (queries.length === 0) return [];

  // One read for every query's observations, then grouped in memory. A per-query round trip would
  // be N+1 queries for a page that renders them all together.
  const checks = await db
    .select()
    .from(promptChecks)
    .where(eq(promptChecks.storeId, storeId))
    .orderBy(desc(promptChecks.checkedAt));

  const byQuery = new Map<number, SnapshotPromptObservation[]>();
  for (const check of checks) {
    const bucket = byQuery.get(check.queryId) ?? [];
    if (bucket.length >= PROMPT_OBSERVATION_WINDOW) continue;
    bucket.push({
      model: check.model,
      mentioned: check.mentioned,
      mentionContext: check.mentionContext,
      checkedAt: check.checkedAt.toISOString(),
    });
    byQuery.set(check.queryId, bucket);
  }

  return queries.map((query) => ({
    id: query.id,
    query: query.query,
    brandTerm: query.brandTerm,
    active: query.active,
    createdAt: query.createdAt.toISOString(),
    observations: byQuery.get(query.id) ?? [],
  }));
}

/**
 * Adds a question to track.
 *
 * `brandTerm` defaults to the store's own name because that is the only value Rankvora AI actually
 * knows — but it is stored per query and editable, since a merchant may trade under a name that
 * differs from their Shopify store name. Matching on the wrong string would under-report every
 * single run while looking perfectly healthy.
 */
export async function addPromptQuery(storeId: number, query: string, brandTerm?: string): Promise<PromptQueryRecord> {
  const text = query.trim();
  if (text.length < 3) {
    throw new ApiError(400, 'Enter the question you want checked — at least 3 characters.', 'PROMPT_QUERY_INVALID');
  }

  const existing = await db
    .select({ id: promptQueries.id })
    .from(promptQueries)
    .where(eq(promptQueries.storeId, storeId));
  if (existing.length >= MAX_PROMPT_QUERIES) {
    throw new ApiError(400, `You can track up to ${MAX_PROMPT_QUERIES} questions. Remove one to add another.`, 'PROMPT_QUERY_LIMIT');
  }

  let term = brandTerm?.trim();
  if (!term) {
    const [store] = await db.select({ name: stores.name }).from(stores).where(eq(stores.id, storeId)).limit(1);
    term = store?.name?.trim();
  }
  if (!term) {
    throw new ApiError(400, 'Set the brand name to look for — Rankvora AI cannot tell whether an answer mentions you without it.', 'PROMPT_BRAND_REQUIRED');
  }

  // The same question twice, ignoring case (MySQL's unique index did). SQLite's own unique index
  // compares case-sensitively, so the check is made here.
  const [duplicate] = await db
    .select({ id: promptQueries.id })
    .from(promptQueries)
    .where(and(eq(promptQueries.storeId, storeId), sql`lower(${promptQueries.query}) = lower(${text})`))
    .limit(1);
  if (duplicate) throw new ApiError(409, 'You are already tracking that question.', 'PROMPT_QUERY_DUPLICATE');

  let created;
  try {
    [created] = await db.insert(promptQueries).values({ storeId, query: text, brandTerm: term, active: true }).returning();
  } catch (error) {
    // Two requests adding the same question at once: the unique index refuses the second.
    if (isUniqueViolation(error)) throw new ApiError(409, 'You are already tracking that question.', 'PROMPT_QUERY_DUPLICATE');
    throw error;
  }
  if (!created) throw new ApiError(500, 'The question could not be saved.', 'PROMPT_QUERY_NOT_SAVED');

  // A brand-new question has no observations — and is reported that way rather than as a zero.
  return {
    id: created.id,
    query: created.query,
    brandTerm: created.brandTerm,
    active: created.active,
    createdAt: created.createdAt.toISOString(),
    observations: [],
  };
}

/** Pauses or resumes a question. History is kept either way. */
export async function setPromptQueryActive(storeId: number, queryId: number, active: boolean): Promise<void> {
  const result = await db
    .update(promptQueries)
    .set({ active })
    .where(and(eq(promptQueries.id, queryId), eq(promptQueries.storeId, storeId)));
  if (!result) throw new ApiError(404, 'That question is not tracked for this store.', 'PROMPT_QUERY_NOT_FOUND');
}

/** Deletes a question and, by cascade, every observation recorded for it. */
export async function deletePromptQuery(storeId: number, queryId: number): Promise<void> {
  await db
    .delete(promptQueries)
    .where(and(eq(promptQueries.id, queryId), eq(promptQueries.storeId, storeId)));
}

/**
 * Everything the AI Discovery checks need that is not readable from Shopify or the storefront.
 *
 * Loaded once per audit in store-data/index.ts and handed to the provider, so the checks stay pure
 * functions of a snapshot.
 */
export async function loadAiDiscoveryInputs(storeId: number): Promise<SnapshotAiDiscovery> {
  const [config, queries] = await Promise.all([getAiDiscoveryConfig(storeId), listPromptQueries(storeId)]);

  const promptQueryList: SnapshotPromptQuery[] = queries.map((query) => ({
    id: query.id,
    query: query.query,
    brandTerm: query.brandTerm,
    active: query.active,
    observations: query.observations,
  }));

  return {
    indexNowKey: config.indexNowKey,
    indexNowKeySetAt: config.indexNowKeySetAt,
    promptQueries: promptQueryList,
    aiConfigured: aiConfigured(),
  };
}
