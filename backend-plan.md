# Rankvora AI Backend Plan (v2 — Updated)

> Replaces the earlier `plan.md` (removed — its content was written before most of the backend existed and is fully superseded here). This document reflects the **actual current state** of `backend/` and `frontend/` as of 2026-08-25, and plans the remaining work from there.

---

## 1. Executive Summary

The backend is much further along than `plan.md` describes: a full **Route → Controller → Service → Drizzle** layer already exists and works for `users`, `stores`, `integrations`, `audits`, and `findings`, plus complete `dashboard` and `reports` routers that are coded end-to-end but **not mounted** in `server.ts` (a one-line bug, not missing work).

The frontend has also moved on from what `plan.md` assumed. All 30 sub-pillar pages across the 5 pillars (SEO, Content, Speed, CRO, AI Discovery) now render through **one converged contract** — `SubPillarAnalysis` / `EvidenceConfig` / `EvidenceRow` — instead of one bespoke page per sub-pillar. There is also no HTTP client anywhere in the frontend yet; every "fetch" today is a `setTimeout`-simulated mock.

Three scoping decisions drive this plan:
1. **Per-sub-pillar metrics/evidence → flexible JSONB columns**, not 30+ normalized tables. This data will eventually come from an automated audit engine with shapes that will keep evolving; JSONB avoids a schema migration every time a sub-pillar's metrics change.
2. **Auth stays mock/single-tenant.** No login/session work in this plan — only keeping the schema and service layer "auth-ready" (a `storeId`/`userId` boundary already exists via `store.service.getCurrentStoreId()`, flagged there as a TODO for real tenancy).
3. **Page settings get backend persistence** — a new table replaces the current `localStorage`-only implementation.

---

## 2. Current State Audit

### 2.1 Database schema (as built — `backend/src/db/schema.ts`)

| Table | Key columns | Notes |
|---|---|---|
| `users` | fullName, email (unique), jobTitle, role, 6 notification toggles, density, reduceMotion | Single account, no auth table |
| `stores` | workspaceName, name, url, platform, industry, country, timezone, currency, autoAnalysis, analysisFrequency, crawlScope, pageLimit, includeBlog, includeCollections, respectRobots | The analyzed storefront |
| `audits` | storeId → stores (cascade), overallScore (0–100), runAt | One row per analysis run |
| `auditScores` | auditId → audits (cascade), pillar (enum check), subPillar (nullable = pillar-level row), score, checksTotal/checksPassed (pillar rows), analyzedCount/healthyCount (sub-pillar rows) | Unique on (auditId, pillar, subPillar) |
| `findings` | auditId → audits (cascade), pillar, subPillar, title, severity, status (open/reviewed/resolved/ignored), resolutionType, affectedCount, affectedLabel, impact, scoreLift, problem, why, recommendation, evidence (text[]), statusChangedAt | The only entity mutated repeatedly by the UI |
| `integrations` | storeId → stores (cascade), provider, status, accountDetail, lastSyncedAt, notice | Unique on (storeId, provider) |

All relations are one-directional FKs (no Drizzle `relations()` helpers defined yet). Migration `0000_bizarre_agent_zero.sql` matches `schema.ts` exactly — up to date, single migration so far.

### 2.2 API surface (as built)

| Resource | Status | Endpoints |
|---|---|---|
| Health | ✅ mounted | `GET /api/health` |
| Users | ✅ mounted | `GET/PUT /api/users/me` |
| Stores | ✅ mounted | `GET/PUT /api/stores/current` |
| Integrations | ✅ mounted | `GET /api/integrations`, `PATCH /api/integrations/:provider` |
| Audits | ✅ mounted | `GET /api/audits`, `GET /api/audits/latest`, `GET /api/audits/:id/scores` |
| Findings | ✅ mounted | `GET /api/findings`, `GET /api/findings/priority`, `GET /api/findings/:id`, `PATCH /api/findings/:id/status`, `POST /api/findings/bulk-status` |
| **Dashboard** | ⚠️ **built, not mounted** | `GET /summary` (would be `/api/dashboard/summary`) |
| **Reports** | ⚠️ **built, not mounted** | `GET /trend`, `GET /comparison`, `GET /export` (CSV) |

Every route is `authenticate`-gated except health. Controllers are thin pass-throughs to a real service layer that queries Drizzle directly — this is a proper Route→Controller→Service architecture, more complete than `plan.md` specified.

### 2.3 Middleware & config

- `asyncHandler` — generic async error forwarder.
- `authenticate` — **mock only**: `req.user = { id: 1 }` when `MOCK_AUTH=true` outside production, else 401. No JWT/session/password anywhere. `MOCK_AUTH` is not documented in `.env.example`.
- `validateRequest` — Zod-based `{ body, params, query }` validator, throws `RequestValidationError` → 400.
- `error.ts` — `ApiError`, `notFound`, `errorHandler` (dev-only message exposure).
- `env.ts` — validates `NODE_ENV`, `PORT`, the JWT secrets (required), `MOCK_AUTH`; `DATABASE_PATH` (the SQLite file) is required when a Node process opens its database.

### 2.4 Known gaps / defects

- **`dashboardRouter` and `reportsRouter` are never imported/mounted in `server.ts`** — despite full implementation, `/api/dashboard/*` and `/api/reports/*` 404 today. This is the single highest-value quick fix available.
- `integration.service.ts` defines its own local `getCurrentStoreId()` instead of reusing the shared one in `store.service.ts` — duplicated logic, should be deduped.
- No `cors` package/middleware — will block the frontend once it makes real cross-origin requests in dev.
- No request logging (morgan/pino/etc.).
- **No seed script anywhere** in the repo — every service assumes at least one `stores` row and one `audits` row exist, or throws 404. The DB currently has schema only, no data.
- No test framework (jest/vitest), no `test`/`lint`/`build` npm scripts.
- No auth libraries (expected, given mock-auth decision).

---

## 3. Frontend Data Contracts (what the backend must serve)

### 3.1 The converged sub-pillar contract — the most important one

All 30 sub-pillar pages (8 SEO + 6 Content + 4 Speed + 11 CRO + 4 AI Discovery, minus schema which is bespoke) render through one shape, defined in `frontend/src/data/seo/subpillar.model.ts`:

```ts
SubPillarAnalysis {
  slug, title, description, supportsBulkFix?, bulkFixMode?,
  summary, healthChip,
  totals: { score, analyzed, healthy, issues, critical, ...labels, contextLabel, contextValue },
  findings: SubPillarFinding[],   // id, issueType, title, severity, affected, impact, effort, whatIsWrong, whyItMatters, recommendation
  evidence: EvidenceConfig,       // search/facet/sort/status-filter over EvidenceRow[]
  relatedAreas: RelatedArea[],
  lastAnalyzed
}
```

- SEO (`SeoSubPillarPage.tsx`) currently gets this from hand-authored files in `frontend/src/data/seo/analyses/*.ts`.
- Content/Speed/CRO/AI Discovery (`NonSeoSubPillarPage.tsx`) currently *build* this at runtime from `pillarCatalogs/*Catalog.ts` (`GenericSubPillarConfig`) + `pillarCatalogs/*Tables.ts` (`GenericSubPillarDetails`) + the pillar's `findings` array, via a client-side `buildAnalysis()`.
- The Schema/JSON-LD sub-pillar (`SchemaJsonLdPage.tsx`) is bespoke — not on this contract — with its own 15-schema-type catalog and JSON-LD preview generator. Plan: keep it bespoke; still needs its own data endpoint but not the shared `SubPillarAnalysis` shape.

**Backend goal**: one aggregate endpoint that assembles this shape server-side for any `(pillar, subPillar)`, so the frontend's `buildAnalysis()` and hand-authored SEO analysis files become deletable.

**Important nuance for implementation**: `EvidenceConfig.sorts: SortOption[]` embeds actual JS comparator *functions* (`compare: (a, b) => number`) — these are not serializable over JSON and must **not** be part of the API response. Split the contract in two:
- **Data** (comes from the backend, changes every audit): `summary`, `healthChip`, `totals`, `findings`, `evidence.rows` (`EvidenceRow[]`), `relatedAreas`, `lastAnalyzed`.
- **Presentation config** (stays in a small frontend catalog per slug, structural/rarely changes): `evidence.columns`, `evidence.sorts`, `evidence.facet`, `evidence.searchKeys`, `evidence.title/caption/searchPlaceholder/sampleNoun`, plus `supportsBulkFix`/`bulkFixMode`.

The frontend merges backend data with its local per-slug config to build the final `SubPillarAnalysis` object passed to `SeoSubPillarPage`/`NonSeoSubPillarPage` — this keeps the generic-page components unchanged while still moving all real data server-side.

### 3.2 Dashboard (`dashboard.mock.ts` → `DashboardData`)

`overallScore` (+trend), `keyMetrics[]`, `pillars[]` (score/status/subPillars), `priorityIssues[]`, `recommendedActions[]`, `scoreTrend[]` (date/score), `lastUpdated`, `storeName/storeUrl`. Already covered by the (unmounted) `dashboard.service.ts`, which reuses `finding.service.listPriorityFindings`.

### 3.3 Fix Center (`workflows.mock.ts` → `FixFinding[]`)

Already maps directly onto the `findings` table + existing `GET /api/findings` (filterable) and `POST /api/findings/bulk-status`. The client-side `BulkFixWorkflow` (generate → validate → apply/undo, in `EvidenceTable.tsx`) is in-memory only today.

**Decision**: don't build a new persisted workflow/audit-trail table for this in MVP. "Apply" reduces to the existing bulk-status update (+ `scoreLift` bookkeeping already on `findings`); "generate/validate" can stay a client-side preview computed from `evidenceRows` (see §4.1) without a server round trip.

### 3.4 Integrations (`workflows.mock.ts` → `integrationRecords`)

Already covered by `GET /api/integrations` / `PATCH /api/integrations/:provider`. No changes needed.

### 3.5 Reports (`workflows.mock.ts` → `reportPillars`, `reportTrend`)

Already covered by the (unmounted) `reports.service.ts` (`/trend`, `/comparison`, `/export`).

### 3.6 Settings (`settings.mock.ts` → `SettingsState`)

`profile`, `workspace`, `analysis`, `notifications`, `appearance` already map onto `users`/`stores` and the existing `GET/PUT /api/users/me`, `GET/PUT /api/stores/current`. `planInfo` (billing) has no backend concept and should stay static/frontend-only (explicitly deferred, §3.9).

### 3.7 Notifications — currently not backed by any data file

`Header.tsx` and `Notifications.tsx` each hardcode their **own copy** of the same 5-item notification list (`{ id: number, title, description, time, read: boolean, icon: LucideIcon }`) — there is no shared source today. Needs one real table + endpoint so both consume the same data.

Note: `icon` is a Lucide component reference — not serializable. The backend should send a `type` string (e.g. `analysis_complete`, `critical_issue`, `score_change`, `integration_alert`, `product_update` — mirroring the six toggles already on `users`) and the frontend keeps a small `type → icon` lookup map, same split as the evidence-config nuance above. Send `createdAt` as an ISO timestamp; the frontend already knows how to render relative time (`"10 min ago"`) — no need to compute/store that string server-side.

### 3.8 Page Settings (`pageSettings.registry.ts`)

Per-sub-pillar merchant-config forms (30 sub-pillars + schema page), currently persisted only to `localStorage` (`scorelo-page-settings-{slug}`, `scorelo-page-schema-settings`). Per the approved decision, this moves to backend persistence — see new `page_settings` table below.

### 3.9 Explicitly deferred / out of scope for this plan

- Real authentication, multi-user, multi-store tenancy (schema stays auth-ready via the existing `storeId` boundary, nothing more).
- SEO-only extras: `topPages`, `keywords`, `competitors` (from `seo-8pillars.mock.ts`) — no other pillar has an analog, no schema modeled yet.
- Billing / plan info (`planInfo` in `settings.mock.ts`) — stays static frontend content.
- Server-side bulk-fix "generate/validate" preview as a persisted workflow — reuses existing bulk-status endpoint instead (§3.3).
- Recent-activity feeds — recommend **deriving** these from `findings.statusChangedAt` / `audits.runAt` at query time rather than introducing a new activity-log table (avoids a second source of truth).

---

## 4. Updated Database Schema Plan

### 4.1 Modify existing tables

**`auditScores`** — add:
```ts
details: jsonb('details')   // nullable; per-sub-pillar bespoke metrics
```
Holds whatever shape a given sub-pillar's `*.mock.ts` object currently hand-authors (e.g. Core Web Vitals numbers, image-weight totals, schema-type coverage map). Read/written as opaque JSON by the service layer — no per-field columns, by design (decision in §1).

**`findings`** — add:
```ts
evidenceRows: jsonb('evidence_rows')   // nullable array of structured EvidenceRow objects
```
Replaces the current plain `evidence: text[]` for anything that needs the full `EvidenceRow` shape (cells, current/suggested before-after pairs, note) used by `EvidenceTable.tsx`. Keep the existing `evidence: text[]` column as-is for the simple cases already using it; `evidenceRows` is additive for sub-pillars whose evidence table needs structured rows.

### 4.2 New tables

**`notifications`**
```ts
id, storeId → stores (cascade),
type,                               // e.g. analysis_complete/critical_issue/score_change/integration_alert/product_update — frontend maps type → Lucide icon
title, message,
tone,                                // CHECK IN ('neutral','success','warning','critical','info') — matches StatusBadge/MetricTile tone prop exactly
isRead: boolean default false,
createdAt: timestamptz default now()
```

**`page_settings`**
```ts
id, storeId → stores (cascade),
slug,                               // e.g. "content/product-descriptions", "seo/schema"
values: jsonb,                      // arbitrary field values keyed by PageSettingField.id
updatedAt: timestamptz default now()
-- unique index (storeId, slug)
```

### 4.3 Migration notes

Use the existing toolchain — `npm run db:generate` (drizzle-kit) then `npm run db:migrate` — no new tooling needed. Expect one new migration covering both column additions and both new tables.

---

## 5. Updated API Endpoint Plan

| Method | Path | Status | Notes |
|---|---|---|---|
| — | `dashboardRouter`, `reportsRouter` | **fix** | Mount in `server.ts` at `/api/dashboard`, `/api/reports` — code already exists |
| GET | `/api/audits/latest/:pillar/:subPillar` | **new** | Returns the *data* slice of `SubPillarAnalysis` (see §3.1 split — no `sorts`/`columns`) for the latest audit — the one endpoint that serves all 30 generic sub-pillar pages, assembled server-side from `auditScores.details` + `findings` (+ `evidenceRows`) |
| GET | `/api/notifications` | new | List, most recent first |
| PATCH | `/api/notifications/:id/read` | new | Mark one read |
| PATCH | `/api/notifications/read-all` | new | Mark all read |
| GET | `/api/page-settings/:slug` | new | Fetch stored values for a sub-pillar's settings form |
| PUT | `/api/page-settings/:slug` | new | Upsert values |
| — | everything else | unchanged | Users, stores, integrations, audits, findings (incl. bulk-status) stay exactly as built |

### 5.1 Example response payloads (for implementers)

`GET /api/audits/latest/:pillar/:subPillar` — data-only slice per the §3.1 split (no `sorts`/`columns`):
```json
{
  "slug": "title-tags",
  "summary": "94.5% of analyzed pages have a healthy title tag.",
  "healthChip": "94.5% healthy",
  "totals": { "score": 87, "analyzed": 412, "healthy": 389, "issues": 23, "critical": 4,
    "analyzedLabel": "Pages analyzed", "healthyLabel": "Healthy titles", "issuesLabel": "Issues found",
    "criticalLabel": "Critical", "contextLabel": "Average length", "contextValue": "58 chars" },
  "findings": [ { "id": "too-long", "issueType": "Too Long", "title": "Title exceeds recommended length",
    "severity": "medium", "affected": 18, "impact": "Medium", "effort": "Low",
    "whatIsWrong": "...", "whyItMatters": "...", "recommendation": "..." } ],
  "evidenceRows": [ { "id": "row-1", "status": "Too Long", "cells": { "url": "/products/x", "length": 72 },
    "facet": "product", "current": { "label": "Current title", "value": "..." },
    "suggested": { "label": "Suggested title", "value": "..." }, "note": null } ],
  "relatedAreas": [ { "label": "Meta Descriptions", "href": "/seo/meta-descriptions", "hint": "..." } ],
  "lastAnalyzed": "2026-08-24T09:00:00.000Z"
}
```

`GET /api/notifications`:
```json
[ { "id": 1, "type": "analysis_complete", "title": "SEO analysis completed",
    "message": "Your latest SEO analysis has finished successfully.",
    "tone": "success", "isRead": false, "createdAt": "2026-08-25T08:12:00.000Z" } ]
```

`GET /api/page-settings/:slug`:
```json
{ "slug": "seo/title-tags", "values": { "titleTemplate": "{product_title} | {brand}", "titleFallback": true } }
```

---

## 6. Middleware / Infra Fixes

- Add `cors` package + middleware (frontend and backend will be separate origins in dev).
- Document `MOCK_AUTH` in `backend/.env.example`.
- Add a `db:seed` npm script + a seed file that populates `stores`, `audits`, `auditScores` (incl. `details`), `findings` (incl. `evidenceRows`), `integrations`, `notifications`, and `page_settings` from the current frontend mock data, so the app has real data to render as soon as the frontend is wired up.
- Dedupe `integration.service.ts`'s local `getCurrentStoreId()` to import the shared helper from `store.service.ts`.
- Optional, not blocking: basic request logging (morgan or a lightweight pino setup).

---

## 7. Frontend Integration Plan

- Add a small HTTP client at `frontend/src/lib/api/client.ts`, base URL from a new `VITE_API_BASE_URL` env var. Today there is **no HTTP client at all** — no axios/ofetch, no `lib/api`/`services`/`api` directory, zero real network calls; every page fetch is a `setTimeout`-simulated mock.
- Replace each `*.repository.ts` / `fetchX()` function (`dashboard.repository.ts`'s `fetchDashboardData`, `subpillar.model.ts`'s `fetchAnalysis`, `settings.mock.ts`'s `fetchSettings`/`persistSettings`, etc.) with a real call to the matching endpoint, **preserving existing return types** so components don't need to change.
- Once `/api/audits/latest/:pillar/:subPillar` returns pre-assembled `SubPillarAnalysis`, delete the frontend's `buildAnalysis()` logic and the hand-authored `data/seo/analyses/*.ts` files.
- Point `Header.tsx`, `Sidebar.tsx`, and `Notifications.tsx` at `GET /api/users/me` and `GET /api/notifications` instead of their current independently-hardcoded copies, so user identity and notifications each have one source of truth.

---

## 8. Phased Roadmap

- **Phase 0** (minutes, no schema changes): mount `dashboardRouter`/`reportsRouter`, add `cors`, document `MOCK_AUTH`, dedupe `integration.service.ts` helper.
- **Phase 1**: schema changes — `auditScores.details`, `findings.evidenceRows`, `notifications`, `page_settings` — generate + run migration.
- **Phase 2**: new services/controllers/routes/schemas for the sub-pillar-analysis aggregate endpoint, notifications, and page-settings, following the existing pattern (thin controller → service → Drizzle, Zod-validated).
- **Phase 3**: seed script populated from current frontend mock data across all 5 pillars/30 sub-pillars, findings, evidence, integrations, notifications.
- **Phase 4**: frontend API client + wire up Dashboard, Fix Center, Integrations, Reports, Settings, and every sub-pillar page to real endpoints; remove simulated-latency mocks.
- **Phase 5**: cleanup — delete orphaned frontend files no longer referenced (`ProductDescriptionsPage.tsx`, and `PillarSubPillarPage.tsx` once confirmed fully superseded by `NonSeoSubPillarPage.tsx`), add basic backend tests.

---

## 9. Open Items / Deferred

- Real auth / multi-user / multi-store tenancy.
- SEO-only `topPages` / `keywords` / `competitors`.
- Billing / plan info.
- Server-side bulk-fix "generate/validate" as a persisted workflow (MVP reuses bulk-status).
- A dedicated activity-log table (MVP derives recent activity from existing timestamps).

---

## 10. Definition of Ready

Confirms this plan has no unresolved unknowns blocking Phase 0:

- [x] Every existing table/route/service/middleware verified by reading the actual files, not assumed from `plan.md`.
- [x] Every frontend data contract that needs a backend source has been traced to its exact TypeScript shape (`DashboardData`, `FixFinding`, `SubPillarAnalysis`, `SettingsState`, `NotificationItem`, `PageSettingField`) by reading the frontend source, not the mock file names alone.
- [x] The one non-obvious technical blocker (non-serializable `compare` functions in `EvidenceConfig.sorts`) is identified and resolved via the data/presentation split in §3.1 — implementers won't discover this mid-build.
- [x] Every new table has concrete column definitions; every new endpoint has an example request/response payload (§5.1).
- [x] Nothing in Phase 0–1 depends on an undecided question — auth, JSONB-vs-normalized, and page-settings persistence were all explicitly decided before this doc was written.
- [x] Deferred items (§9) are named explicitly so they aren't silently rediscovered later as "missing" work.

Recommended first PR: Phase 0 (mount the two missing routers + `cors` + env doc + service dedupe) — it's a same-day, low-risk change that immediately unblocks manual testing of `/api/dashboard` and `/api/reports` against Postman/curl before any schema work begins.
