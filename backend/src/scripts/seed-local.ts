/**
 * LOCAL DEVELOPMENT ONLY: gives MOCK_AUTH someone to be.
 *
 *   npm run db:migrate && npm run db:seed:local
 *
 * With MOCK_AUTH=true every request is treated as user 1, but a fresh local database has no user 1
 * and no store, so every page would answer "not found". This creates one account and one workspace
 * for it — an account with nothing in it, exactly as a shop that has just opened the app has before
 * its first audit. It writes no audit, no finding, no score and no sample data of any kind: the
 * dashboard shows its real empty state, and real numbers appear only once a real store is connected.
 *
 * It refuses to run unless the API itself would accept MOCK_AUTH (NODE_ENV=development and
 * MOCK_AUTH=true), so it cannot be pointed at a real database by accident. It does nothing if user 1
 * already exists, and it is safe to run twice.
 */
import { eq } from 'drizzle-orm';
import { env, requireDatabasePath } from '../config/env.js';
import { closeDatabase, db } from '../db/client.js';
import { stores, users } from '../db/schema.js';
import { describeError } from '../lib/logger.js';

if (!env.mockAuthEnabled) {
  console.error('Refusing to seed: this is for local development only. Set NODE_ENV=development and MOCK_AUTH=true in backend/.env.');
  process.exit(1);
}

try {
  console.log(`database: ${requireDatabasePath()}`);

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.id, 1)).limit(1);
  if (existing) {
    console.log('user 1 already exists — nothing to do.');
  } else {
    const [user] = await db.insert(users).values({ fullName: 'Local Developer', email: 'dev@localhost.test' }).returning({ id: users.id });
    if (!user) throw new Error('the account was not saved');
    if (user.id !== 1) {
      console.warn(`The account was created as user ${user.id}, not 1, because this database already had users. MOCK_AUTH signs in as user 1, so use a fresh database (delete the file at DATABASE_PATH and run db:migrate again).`);
    }
    await db.insert(stores).values({
      ownerId: user.id,
      workspaceName: 'Local development',
      name: 'Local development',
      url: '',
      platform: 'Shopify',
      // Not something anyone has told the app yet — the same explicit "Unspecified" a store created
      // from a shop gets for what Shopify did not report.
      industry: 'Unspecified',
      country: 'Unspecified',
      timezone: 'Unspecified',
      currency: 'Unspecified',
    });
    console.log(`created user ${user.id} (dev@localhost.test) and its workspace.`);
  }
} catch (error) {
  console.error(`seed failed: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
