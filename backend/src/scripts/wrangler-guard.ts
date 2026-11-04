/**
 * The check src/scripts/wrangler.ts runs before it lets Wrangler touch an environment: whether the
 * environment still holds a `REPLACE_WITH_…` placeholder. Its own module so it can be tested without
 * a placeholder having to exist in the real config.
 */
export function findPlaceholders(environment: unknown): string[] {
  return [...new Set(JSON.stringify(environment ?? {}).match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? [])];
}
