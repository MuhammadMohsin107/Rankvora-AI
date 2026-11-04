/**
 * Read-only check of guided setup against the REAL stores, accounts and connections.
 *
 *   npm run verify:setup
 *
 * Why this exists: the unit tests prove the setup rules on inputs they build themselves. They cannot
 * show how the rules meet the rows a live database actually holds — which required steps a real
 * store still owes, which capabilities it really has, when its next scan really falls in its own
 * timezone. This reports exactly that, store by store, using the same functions the API uses.
 *
 * READ ONLY, enforced by SQLite: the database is opened read-only (useReadOnlyDatabase), so the
 * database itself refuses a write — from this script or from any service it calls. It does not call
 * Shopify, Google or an AI provider, and prints no email address, token or credential: the database
 * file (so the output says which database it read), store ids, myshopify addresses, and states.
 *
 * Point DATABASE_PATH at the SQLite copy to check — a local database, or an export of the D1 one.
 */
import { asc } from 'drizzle-orm';
import { requireDatabasePath } from '../config/env.js';
import { closeDatabase, db, pingDatabase, useReadOnlyDatabase } from '../db/client.js';
import { onboardingState, stores } from '../db/schema.js';
import { buildCapabilities } from '../services/onboarding-capabilities.service.js';
import { readOnboardingPreferences } from '../services/onboarding-preferences.service.js';
import { stepIsRequired, toAnswers, unansweredSteps } from '../services/onboarding.service.js';
import { eq } from 'drizzle-orm';

// Before the database is first used: every query this process makes — the script's own and every
// service's it calls — then runs on a read-only database.
useReadOnlyDatabase();
console.log(`database: ${requireDatabasePath()} (read-only)`);

if (!(await pingDatabase())) {
  console.error('Could not open the database. Set DATABASE_PATH to the SQLite file to check.');
  closeDatabase();
  process.exit(1);
}

try {
  const rows = await db.select().from(stores).orderBy(asc(stores.id));
  console.log(`stores: ${rows.length}\n`);

  for (const store of rows) {
    const [state] = await db.select().from(onboardingState).where(eq(onboardingState.storeId, store.id)).limit(1);
    const preferences = await readOnboardingPreferences(store.id);

    console.log(`── store ${store.id} · ${store.name || '(no name)'} · timezone ${store.timezone}`);

    if (!state) {
      // Created lazily the first time the merchant opens setup, so a store that never has no row.
      console.log('   guided setup: never opened (no setup row yet) → starts at step 1\n');
      continue;
    }

    const answers = toAnswers(state);
    const owed = unansweredSteps(answers, preferences);
    console.log(
      `   guided setup: ${state.completedAt ? `completed ${state.completedAt.toISOString().slice(0, 10)}` : 'NOT completed'}`
      + ` · required steps still owed: ${owed.length === 0 ? 'none' : owed.join(', ')}`
      + ` (steps that block finishing: ${[1, 2, 3, 4, 5].filter(stepIsRequired).join(', ')})`,
    );
    console.log(
      `   answers: content language=${preferences.contentLanguage ?? '—'} · priority areas=${answers.priorityPillars.join(', ') || '—'}`
      + ` · publishing=${answers.automationConsent ?? 'not answered (reviewed with you)'}`
      + ` · priority pages=${preferences.priorityResources.length} · protected paths=${preferences.protectedPaths.length}`,
    );

    const { capabilities, schedule, firstAuditAt } = await buildCapabilities(
      store.id,
      {
        organizationName: answers.organizationName,
        brandName: answers.brandName,
        industries: answers.industries,
        targetCountries: answers.targetCountries,
        priorityPillars: answers.priorityPillars,
        automationConsent: answers.automationConsent,
      },
      preferences,
    );

    for (const capability of capabilities) {
      console.log(`   · ${capability.label.padEnd(26)} ${capability.status.padEnd(16)} ${capability.detail}`);
    }
    console.log(
      `   schedule: ${schedule.enabled ? `${schedule.frequency}${schedule.preferredHour !== null ? ` at ${String(schedule.preferredHour).padStart(2, '0')}:00` : ''}` : 'off'}`
      + ` · next scan ${schedule.nextScanAt ?? '—'} · last analysed ${schedule.lastAnalyzedAt ?? 'never'} · baseline ${firstAuditAt ?? 'none yet'}\n`,
    );
  }
} finally {
  closeDatabase();
}
