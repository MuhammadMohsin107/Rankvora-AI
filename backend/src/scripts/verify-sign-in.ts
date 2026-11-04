/**
 * Read-only check of what Shopify sign-in would do with the REAL accounts, stores and connections.
 *
 *   npm run verify:signin
 *
 * Why this exists: the sign-in tests prove the rules on inputs they build themselves. They cannot
 * show how those rules meet the rows a live database actually holds — a connection that never
 * recorded its Shopify id, a store whose connection shop/redact removed, an account the next
 * refresh would end. This reports, store by store, which way sign-in goes (dashboard, resume
 * setup, reopen a remembered store) and what is out of the ordinary, so a problem in the data is
 * found by reading it instead of by a merchant failing to sign in.
 *
 * READ ONLY, enforced by SQLite: the database is opened read-only (useReadOnlyDatabase), so a write
 * — by this script or by a mistake in it — is refused by the database itself. It does not call
 * Shopify. It prints no email address, no token and no credential: the database file (so the output
 * says which database it read), counts, store ids, and each shop's myshopify address, which is a
 * business identifier and not a secret.
 *
 * Point DATABASE_PATH at the SQLite copy to check — a local database, or an export of the D1 one.
 * Timestamps are milliseconds since the epoch (schema.ts), so "now" is `unixepoch() * 1000`.
 */
import { requireDatabasePath } from '../config/env.js';
import { closeDatabase, pingDatabase, queryRows, useReadOnlyDatabase } from '../db/client.js';
import { findRememberedStore } from '../services/shopify-login.service.js';

type Row = Record<string, unknown>;

useReadOnlyDatabase();
console.log(`database: ${requireDatabasePath()} (read-only)`);

if (!(await pingDatabase())) {
  console.error('Could not open the database. Set DATABASE_PATH to the SQLite file to check.');
  closeDatabase();
  process.exit(1);
}

const rows = (sql: string): Row[] => queryRows(sql);
const one = (sql: string): Row => rows(sql)[0] ?? {};
const show = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);
const NOW_MS = '(unixepoch() * 1000)';

try {
  show('engine', one('SELECT sqlite_version() AS sqlite_version'));
  try {
    show('migrations applied (this repo has 1 for D1, 0000)', one('SELECT COUNT(*) AS n FROM __drizzle_migrations'));
  } catch {
    // Applied with `wrangler d1 migrations apply`, which records them in its own table.
    try {
      show('migrations applied (this repo has 1 for D1, 0000)', one('SELECT COUNT(*) AS n FROM d1_migrations'));
    } catch (error) {
      console.log(`migrations applied: no migrations table found (${(error as Error).message.slice(0, 80)})`);
    }
  }

  show('users', one(`
    SELECT COUNT(*) AS total FROM users`));
  show('stores', one('SELECT COUNT(*) AS total, COUNT(DISTINCT owner_id) AS owners FROM stores'));
  show('connections', one(`
    SELECT COUNT(*) AS total,
           SUM(uninstalled_at IS NULL) AS installed,
           SUM(uninstalled_at IS NOT NULL) AS uninstalled,
           SUM(shop_gid IS NULL) AS without_shop_id,
           SUM(refresh_token_expires_at IS NOT NULL AND refresh_token_expires_at < ${NOW_MS}) AS refresh_token_expired
    FROM shopify_connections`));
  show('one Shopify shop on more than one connection row', rows(`
    SELECT shop_gid, COUNT(*) AS connection_rows FROM shopify_connections
    WHERE shop_gid IS NOT NULL GROUP BY shop_gid HAVING COUNT(*) > 1`));
  show('onboarding', one(`
    SELECT COUNT(*) AS rows_total,
           SUM(completed_at IS NOT NULL) AS completed,
           SUM(completed_at IS NULL) AS incomplete,
           SUM(completed_at IS NULL AND deferred_at IS NOT NULL) AS incomplete_and_deferred
    FROM onboarding_state`));
  show('stores whose guided setup has not been opened yet', one(`
    SELECT COUNT(*) AS n FROM stores s LEFT JOIN onboarding_state o ON o.store_id = s.id WHERE o.id IS NULL`));
  show('sessions', one(`
    SELECT COUNT(*) AS total,
           SUM(revoked_at IS NULL AND expires_at > ${NOW_MS}) AS live,
           SUM(revoked_at IS NOT NULL) AS revoked,
           SUM(revoked_at IS NULL AND expires_at <= ${NOW_MS}) AS expired
    FROM user_sessions`));
  show('accounts the next refresh would sign out (no store with an installed connection)', one(`
    SELECT COUNT(*) AS n FROM users u WHERE NOT EXISTS (
      SELECT 1 FROM stores s JOIN shopify_connections c ON c.store_id = s.id
      WHERE s.owner_id = u.id AND c.uninstalled_at IS NULL)`));

  console.log('\nper store — what signing in through Shopify does:');
  const perStore = rows(`
    SELECT s.id AS store_id, s.owner_id, c.shop_domain, (c.shop_gid IS NOT NULL) AS has_shop_id,
           CASE WHEN c.id IS NULL THEN 'none' WHEN c.uninstalled_at IS NULL THEN 'installed' ELSE 'uninstalled' END AS connection,
           o.id IS NOT NULL AS has_setup_row, o.completed_at IS NOT NULL AS setup_done, o.current_step,
           json_extract(s.shopify_profile, '$.shopDomain') AS remembered_domain,
           (SELECT COUNT(*) FROM user_sessions x WHERE x.user_id = s.owner_id AND x.revoked_at IS NULL AND x.expires_at > ${NOW_MS}) AS live_sessions
    FROM stores s
    LEFT JOIN shopify_connections c ON c.store_id = s.id
    LEFT JOIN onboarding_state o ON o.store_id = s.id
    ORDER BY s.id`);

  for (const r of perStore) {
    let outcome: string;
    if (r.connection === 'none') {
      const domain = r.remembered_domain as string | null;
      if (!domain) {
        outcome = 'no connection and no remembered address: Shopify sign-in cannot reach this store';
      } else {
        // The real function, on the real rows: what a returning merchant would meet after shop/redact.
        try {
          const found = await findRememberedStore(domain);
          outcome = found?.id === r.store_id
            ? `connection row gone; sign-in through ${domain} reopens THIS store (remembered-store path)`
            : `connection row gone; remembered-store lookup for ${domain} returned ${found ? `store ${found.id}` : 'nothing'}`;
        } catch (error) {
          outcome = `connection row gone; remembered-store lookup refused: ${(error as Error).message}`;
        }
      }
    } else if (Number(r.setup_done) === 1) {
      outcome = 'setup complete → dashboard';
    } else if (Number(r.has_setup_row) === 1) {
      outcome = `setup incomplete → resumes at the first unanswered step (stored step ${r.current_step})`;
    } else {
      outcome = 'setup not opened yet → starts at step 1';
    }
    console.log(
      ` store ${r.store_id} (owner ${r.owner_id}) ${r.shop_domain ?? '—'}`
      + ` | connection=${r.connection} | shop id on file=${Number(r.has_shop_id) === 1 ? 'yes' : 'NO'}`
      + ` | live sessions=${r.live_sessions} | ${outcome}`,
    );
  }
  if (perStore.length === 0) console.log(' (no stores)');
} finally {
  closeDatabase();
}
