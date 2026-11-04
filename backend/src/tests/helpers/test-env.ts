/**
 * ─── The environment every test runs in ──────────────────────────────
 *
 * Loaded before each test file (package.json: `tsx --import ./src/tests/helpers/test-env.ts --test`),
 * so it runs before config/env.ts reads the process environment.
 *
 * WHY THIS EXISTS. The tests used to read whatever was in the developer's `.env`. On a machine with
 * no `.env` — a fresh clone, a CI server — 50 of the test files could not even load
 * ("Missing required environment variable: JWT_ACCESS_SECRET"). And on a machine WITH one, the tests
 * ran against that person's real settings: a placeholder TOKEN_ENCRYPTION_KEY failed one test, and
 * the Shopify sign-in tests skipped themselves whenever the Shopify credentials were missing, so
 * "0 skipped" depended on who ran them.
 *
 * Values are ASSIGNED, not defaulted. dotenv (config/env.ts) never overwrites a variable that is
 * already set, so these win over any `.env`, and every run starts from the same place.
 *
 * Nothing here is a real credential, and no test may reach a real service: every Google, PageSpeed and
 * AI variable is REMOVED from the test process, so a developer's own keys and model choices can never be
 * used (or spent) by `npm test`, and each of those settings falls back to its built-in default.
 */

const TEST_ENVIRONMENT: Record<string, string> = {
  // Never 'development', so MOCK_AUTH (every request signed in as user 1) can never switch on.
  NODE_ENV: 'test',
  MOCK_AUTH: 'false',

  // A throwaway database. tests/helpers/database.ts builds the schema in it.
  DATABASE_PATH: ':memory:',

  // Long enough to be valid secrets; worthless anywhere else.
  JWT_ACCESS_SECRET: 'test-access-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  JWT_REFRESH_SECRET: 'test-refresh-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  TOKEN_ENCRYPTION_KEY: '0'.repeat(64),

  // A Shopify app that does not exist. The sign-in tests sign their own requests with this secret.
  SHOPIFY_API_KEY: 'test-client-id',
  SHOPIFY_API_SECRET: 'test-client-secret',
  BACKEND_URL: 'http://localhost:5000',
  FRONTEND_URL: 'http://localhost:5173',
};

for (const [name, value] of Object.entries(TEST_ENVIRONMENT)) process.env[name] = value;

// Real services stay switched off. Removed, not blanked: an empty string is still a value, and a
// setting written as `process.env.X ?? default` would keep it instead of using its default.
const REAL_SERVICE_SETTINGS = /^(GOOGLE_|PAGESPEED_|AI_|OPENAI_|GEMINI_|CRAWL_)/;
for (const name of Object.keys(process.env)) {
  if (REAL_SERVICE_SETTINGS.test(name)) delete process.env[name];
}
