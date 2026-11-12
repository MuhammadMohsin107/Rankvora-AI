# Rankvora AI

Store optimization for Shopify merchants. A merchant installs Rankvora AI from the Shopify App Store
and opens it from Apps in their Shopify admin; Rankvora AI audits the store across SEO, Content, Speed,
CRO and AI Discovery, scores each area, lists what to fix (the Fix Center), tracks changes over time
(Reports, notifications, a weekly summary) and can re-run the analysis on a schedule.

- **A public app, embedded in the Shopify admin.** It runs in an iframe inside the admin, and Shopify
  itself says which store is opening it — see [Running inside the Shopify admin](#running-inside-the-shopify-admin).
  There is no sign-up, password, sign-in page or stored session, and the app sends no email.
- **Runs on Cloudflare Workers.** One Worker serves the website and the API; data is in Cloudflare D1
  (SQLite); each audit runs as a Cloudflare Workflow; a cron trigger runs the scheduled work.

## Stack

| Part | Built with |
| --- | --- |
| Frontend | React 19, TypeScript, Vite 6, Tailwind CSS 4, React Router 7 |
| API | Express 4, TypeScript, Zod, Drizzle ORM |
| Database | Cloudflare D1 (SQLite). Locally: a SQLite file through Node's built-in `node:sqlite` |
| Background work | Cloudflare Workflows (audits), Cron Triggers (every 30 minutes), a Durable Object (shared rate limits) |
| Integrations | Shopify (App Bridge ID tokens + token exchange, Admin GraphQL API), Google Search Console, PageSpeed Insights, OpenAI or Gemini (optional) |

## Requirements

- Node.js 22.13 or newer (the API uses Node's built-in SQLite)
- npm
- No database server. Locally the API opens a SQLite file; on Cloudflare it uses D1.

## Repository layout

```text
frontend/                   React app
  src/                      pages, components, data access (src/data), API client (src/lib/api.ts)
  public/_headers           security and cache headers Cloudflare sends with the website's files
  server.cjs                Node static server + /api proxy (the old single-server setup only)
backend/                    API
  src/app.ts                the Express app (no listener)
  src/server.ts             Node entry point: listens on PORT, runs the scheduled work on timers
  src/worker.ts             Cloudflare entry point: the same app, plus the audit Workflow and the cron
  src/cloudflare/           the rate-limit Durable Object, shell.ts (serves the website inside the Shopify
                            admin's iframe), and a stand-in for iconv-lite on Workers
  src/db/schema.ts          the database schema (D1 / SQLite)
  src/audit-engine/         reads a store and runs the checks behind every score
  src/services/             everything the routes call
  src/tests/                the test suite (npm test)
  drizzle-d1/               D1 migrations
  wrangler.jsonc            Cloudflare configuration: local development, staging, and the public app (production)
  .env.example              every setting, for running on Node
shopify.app.toml            the Shopify app's configuration (read by the Shopify CLI only)
```

## Running it locally

### The usual way: Node API + Vite

Create `backend/.env` (start from `backend/.env.example`). The minimum:

```env
NODE_ENV=development
PORT=5000
DATABASE_PATH=./local.db
MOCK_AUTH=true          # signs every request in as user 1 (development only)
JWT_ACCESS_SECRET=<a long random string>
```

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
Shopify also needs `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `BACKEND_URL` and
`TOKEN_ENCRYPTION_KEY` (see `.env.example`).

```bash
cd backend
npm ci
npm run db:migrate      # creates/updates the SQLite file at DATABASE_PATH
npm run db:seed:local   # development only: the one account and empty workspace MOCK_AUTH signs in as
npm run dev             # API on http://localhost:5000

cd ../frontend
npm ci
npm run dev             # website on http://localhost:5173, /api proxied to the API
```

### The Cloudflare way: the real Worker, locally

Runs exactly what Cloudflare runs — static website, API, local D1, the audit Workflow, the rate-limit
Durable Object — on `http://localhost:8787`. Put `JWT_ACCESS_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` in `backend/.dev.vars` (same format as `.env`; git ignores it —
Wrangler passes the Worker only the secrets `wrangler.jsonc` lists), then:

```bash
cd backend
npm run cf:dev          # builds the website, applies D1 migrations locally, starts wrangler dev
```

To fire the 30-minute cron by hand while it runs, open `http://localhost:8787/__scheduled`.
Local data lives in `backend/.wrangler/` (git ignores it; delete it to start fresh).

## Running inside the Shopify admin

Shopify opens the app in an iframe in the merchant's admin. What that changes:

- **Who is calling** is proved by an *ID token* — a short-lived JWT Shopify signs — that App Bridge adds
  to every request the page makes to this site. The API checks it on each request
  (`backend/src/lib/shopify-id-token.ts`, `middleware/authenticate.ts`) and the caller is the account that
  owns that shop. Nothing is stored in the browser, as the App Store requires.
- **The first time a shop opens the app**, the page calls `POST /api/auth/shopify/embedded`. The API
  exchanges the ID token for an expiring offline access token (token exchange — no redirect, no consent
  screen; the scopes in `shopify.app.toml` are granted at install) and creates the account and store from
  the shop's own records. Later opens call Shopify for nothing.
- **The chrome is Shopify's.** `layouts/EmbeddedShell.tsx` gives Shopify the app's links (`<s-app-nav>`)
  instead of drawing the app's own sidebar and header, and the app is always light.
- **Pages carry a per-shop framing policy.** The Worker (`backend/src/cloudflare/shell.ts`) answers every
  page request and adds `Content-Security-Policy: frame-ancestors` naming the shop that is showing the app.
- **A content policy, in report-only mode.** The same page response carries `Content-Security-Policy-Report-Only`
  (`contentSecurityPolicy()` in `shell.ts`): scripts only from this site, `cdn.shopify.com` and the page's own
  inline script (named by hash, computed per response). The browser blocks nothing; it POSTs what it *would*
  have blocked to `/api/csp-report` (`routes/csp-report.ts`), which logs one line per report with the query
  string removed (the page address carries Shopify's `id_token`). **To enforce it:** open the app in a real
  embedded session on staging, read the `[scorelo-csp] would block …` lines (`npm run cf:logs:staging`), add
  whatever legitimate source they name to the policy, and once they stay quiet change the header name in
  `serveWebsite()` to `Content-Security-Policy` (merging it with the `frame-ancestors` value).
- **Outside the admin** (local development with `MOCK_AUTH`, a visit to the bare site) none of this applies;
  the bare site only says to open the app from the Shopify admin. Nothing on it asks for a store address.

**Testing it.** App Bridge needs a real HTTPS address, a dev store and Shopify's iframe, so embedded behaviour
is tested on a deployment (staging or production), not on `localhost`. `vite dev` also puts its own script
ahead of App Bridge's, which App Bridge refuses ("must be the first script"). The build must be given the
app's public client id: `VITE_SHOPIFY_API_KEY` (see `frontend/.env.example`) — `npm run build` stops without it.

## Tests and checks

```bash
cd backend
npm test                # the whole suite; needs no .env and no database server
npm run typecheck
npm run build           # Node build into dist/

cd ../frontend
npm run lint            # oxlint; config and the reason each rule is off are in .oxlintrc.json
npm test                # Vitest + Testing Library in jsdom (npm run test:watch while developing)
npm run build           # type-check + production build into dist/
```

`npm test` runs on an in-memory SQLite database built from the real D1 migrations, and with its own
fixed settings (`src/tests/helpers/test-env.ts`), so it behaves the same on every machine and never
touches a real service. The local database also refuses what D1 refuses (more than 100 values in one
statement, statements over 100 KB), so a query D1 would reject fails in the tests first.

Read-only checks against a real database or service (`backend/src/scripts`):
`verify:signin`, `verify:setup` (point `DATABASE_PATH` at a SQLite copy), `verify:shopify`,
`verify:google`, `verify:pagespeed`, and `verify:ai` (makes one real, billed AI request).

## Database changes

1. Edit `backend/src/db/schema.ts`.
2. `npm run db:generate` writes a new migration into `backend/drizzle-d1/`.
3. Apply it: `npm run db:migrate` (Node SQLite file), `npm run cf:migrate:local` (local D1),
   `npm run cf:migrate:staging` (the staging D1 — always before deploying code that needs it).

D1 is SQLite: at most 100 bound values per statement (`backend/src/db/limits.ts` splits long id
lists), no interactive transactions (writes that belong together go in `db.batch()`), text compared
case-sensitively unless wrapped in `lower()`, and 1,000 queries per request or Workflow step.

## Deploying to Cloudflare (staging)

Staging is `scorelo-staging.tlxapps.com`, the `staging` environment in `backend/wrangler.jsonc`, on the
company Cloudflare account (pinned in the config).

**Always the company account.** The login on a developer's machine can often reach more than one
account, and not every Wrangler command reads the account written in `wrangler.jsonc` (`d1 migrations`
with `--env` ignores it and asks). So every command that touches staging goes through
`src/scripts/wrangler.ts`, which prints the account it will use and makes Wrangler use exactly that one.
The `cf:*` npm scripts already do; for anything else, run `npx tsx src/scripts/wrangler.ts <wrangler arguments>`.

**Once, before the first deploy:**

```bash
cd backend
npx wrangler login
# The staging database exists already (created 2026-10-28 in Western Europe; its id is in wrangler.jsonc).
npm run cf:migrate:staging                                              # creates the tables
npx tsx src/scripts/wrangler.ts secret put JWT_ACCESS_SECRET --env staging
npx tsx src/scripts/wrangler.ts secret put TOKEN_ENCRYPTION_KEY --env staging   # the SAME key as the old server
npx tsx src/scripts/wrangler.ts secret put SHOPIFY_API_KEY --env staging
npx tsx src/scripts/wrangler.ts secret put SHOPIFY_API_SECRET --env staging
# optional, when used: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PAGESPEED_API_KEY, AI_PROVIDER, AI_API_KEY
```

`TOKEN_ENCRYPTION_KEY` must be the one the old server uses: the Shopify tokens copied from its database
were encrypted with it, and with a different key every store would have to reconnect.

A deploy refuses to run while a required secret is missing. Secrets never go in `wrangler.jsonc` or in git.

**Each release:**

```bash
cd backend
npm run cf:check            # builds the website and does a full dry run — uploads nothing
npm run cf:status:staging   # lists D1 migrations not yet applied to staging — changes nothing
npm run cf:migrate:staging  # applies any new D1 migration
npm run cf:deploy:staging   # builds the website and deploys the Worker
npm run cf:logs:staging     # live logs
```

The website must be built with `VITE_API_BASE_URL` unset, so it calls the same-origin `/api`.

## Deploying the public app (Worker `rankvora-ai`)

The `production` environment in `backend/wrangler.jsonc` is the public, embedded app: the Worker
`rankvora-ai` on the company Cloudflare account, served at `https://rankvora-ai.cp-chahmad.workers.dev`
(Cloudflare's own HTTPS address, so no domain is needed to go live). Every URL in `shopify.app.toml`
points at that address, and a test fails if the two ever disagree.

**The account is on the Workers Free plan.** The website, the health check and start-up work, but an
audit and a new store's first sign-in need more than Free's 10 ms of CPU and 50 database queries per
request or Workflow step, so they fail until the account is on **Workers Paid**. When it is, add
`"limits": { "cpu_ms": 300000 }` to `env.production` and redeploy.

Moving to a custom domain later: set `workers_dev` to `false`, add a `routes` entry for the domain (a zone
on this account; it must not contain "shopify" or "example"), change `BACKEND_URL`, `FRONTEND_URL` and every
URL in `shopify.app.toml`, deploy the Worker, then run `shopify app deploy`.

**1. Nothing to fill in.** `wrangler.jsonc` holds the account, the address and the database id
(created 2026-11-04 in Asia-Pacific). A new environment would start with `REPLACE_WITH_…` placeholders, and
every `cf:*` command refuses to run while one is left.

**2. The database (already created).** `CLOUDFLARE_ACCOUNT_ID` makes Wrangler use that account and no other
(in PowerShell: `$env:CLOUDFLARE_ACCOUNT_ID = "<id>"`):

```bash
cd backend
npx wrangler login
CLOUDFLARE_ACCOUNT_ID=4a36991256542f145b006329cb04abd3 npx wrangler d1 create rankvora-production   # prints database_id
```

**3. Set the secrets** — new random values for this account, not the staging ones:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # for JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # for TOKEN_ENCRYPTION_KEY
npx tsx src/scripts/wrangler.ts secret put JWT_ACCESS_SECRET --env production
npx tsx src/scripts/wrangler.ts secret put TOKEN_ENCRYPTION_KEY --env production
npx tsx src/scripts/wrangler.ts secret put SHOPIFY_API_KEY --env production      # the app's client id
npx tsx src/scripts/wrangler.ts secret put SHOPIFY_API_SECRET --env production   # its client secret
```

**4. Migrate and deploy.** The website is built with the same client id (it is public):

```bash
npm run cf:migrate:production
VITE_SHOPIFY_API_KEY=<client id> npm run cf:deploy:production     # PowerShell: $env:VITE_SHOPIFY_API_KEY = "<client id>"
npm run cf:logs:production
```

**5. Release the Shopify configuration, from the repository root** (it replaces what the Dev Dashboard
holds, so check `shopify.app.toml` first):

```bash
shopify app deploy
```

Then install the app on a development store, open it from **Apps** in that store's admin, and uninstall and
reinstall it once. The app's distribution must be **Public** (Dev Dashboard → the app → Distribution; it
cannot be changed once chosen). The App Store review page runs Shopify's automated checks before you submit.

## Configuration

On Node, every setting is an environment variable — `backend/.env.example` lists and explains them.
On Cloudflare the same names are used: plain values in `wrangler.jsonc` (`vars`), secrets with
`wrangler secret put`. `NODE_ENV` must be `production` anywhere reachable from the internet;
`MOCK_AUTH` (every request signed in as user 1) only works when `NODE_ENV=development`.

## The old single-server setup

Before Cloudflare the app ran as two Node processes on one server behind nginx:
`frontend/server.cjs` (website + `/api` proxy) and the API from `backend/dist/server.js` under pm2.
That still works for a Node host — the API keeps its data in a SQLite file (`DATABASE_PATH`):
`backend/deploy.sh` builds, migrates and starts it, and `backend/verify.sh` checks a running server.
It is being replaced by the Cloudflare deployment above.

## Known limitations

- The cron sweeps check every connected store in one run. At about 3 database queries per store, one
  run reaches roughly 300 stores before D1's 1,000-query limit; weekly summaries reach about 100 due
  stores per run. Fine at today's size; past that the sweep needs to hand each store its own run.
- Search ignores letter case for English letters only (SQLite's `lower()`).
- Cloudflare's Local Explorer button for firing the cron does not reach the Worker in Wrangler 4.153;
  use `/__scheduled` as described above.

## License

No license file is currently included.
