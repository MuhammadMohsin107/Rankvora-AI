import cors from 'cors';
import express from 'express';
import { env } from './config/env.js';
import { cloudflareEdge } from './middleware/cloudflareEdge.js';
import { REQUEST_ID_HEADER, requestLog } from './middleware/requestLog.js';
import { clientErrorsRouter } from './routes/client-errors.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { shopifyRouter } from './routes/shopify.js';
import { linkScansRouter } from './routes/link-scans.js';
import { googleRouter } from './routes/google.js';
import { pagespeedRouter } from './routes/pagespeed.js';
import { usersRouter } from './routes/users.js';
import { storesRouter } from './routes/stores.js';
import { onboardingRouter } from './routes/onboarding.js';
import { integrationsRouter } from './routes/integrations.js';
import { auditsRouter } from './routes/audits.js';
import { jobsRouter } from './routes/jobs.js';
import { findingsRouter } from './routes/findings.js';
import { aiFixesRouter } from './routes/ai-fixes.js';
import { productImagesRouter } from './routes/product-images.js';
import { dashboardRouter } from './routes/dashboard.js';
import { reportsRouter } from './routes/reports.js';
import { notificationsRouter } from './routes/notifications.js';
import { pageSettingsRouter } from './routes/page-settings.js';
import { schemaRouter } from './routes/schema.js';
import { aiDiscoveryRouter } from './routes/ai-discovery.js';
import { errorHandler, notFound } from './middleware/error.js';

/**
 * ─── The HTTP application, and nothing else ──────────────────────────
 *
 * Every middleware and every route, with no listener, no timer and no start-up work. It is split
 * from server.ts so that two different entry points can run the SAME app:
 *
 *   server.ts   Node: binds a port, starts the schedulers, closes out interrupted audit jobs.
 *   worker.ts   Cloudflare Workers: hands requests to this app; has no port and no process of its own.
 *
 * Anything that must happen once per PROCESS (a listener, a setInterval, a boot-time sweep) belongs
 * in an entry point, never here: a Worker is started and stopped by the platform, many isolates can
 * run at once, and none of them is "the" process.
 */
export const app = express();

// Before any middleware reads `req.ip`: behind the edge proxy and server.cjs every request arrives
// from loopback, which made the sign-in rate limits one bucket shared by every visitor.
app.set('trust proxy', env.trustProxy);

// On Cloudflare only (worker.ts switches it on): the caller's address from CF-Connecting-IP, and the
// security headers nginx adds on the server. Before everything else, so no middleware and no rate
// limiter ever sees the address the request arrived with. A no-op on Node.
app.use(cloudflareEdge);

// Next, so every request — including ones CORS or the JSON parser turn away — gets an id and a
// line in the log.
app.use(requestLog);

// Explicit allow-list instead of reflecting every caller's origin. The app authenticates with
// bearer tokens (not cookies), which limited the practical damage, but an API that answers
// credentialed CORS to any origin is one cookie away from a real problem. FRONTEND_URL covers
// staging/production; the Vite dev origins cover local development.
const allowedOrigins = new Set(
  [env.frontendUrl, 'http://localhost:5173', 'http://127.0.0.1:5173'].filter(Boolean),
);
app.use(cors({
  origin(origin, callback) {
    // Same-origin/off-browser requests (curl, the Vite proxy, server-to-server) have no Origin
    // header — those are allowed; only a cross-origin browser caller must match the list.
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  // Readable by the frontend when it is served from another origin, so a failed request can
  // carry the id of its server log entry.
  exposedHeaders: [REQUEST_ID_HEADER],
}));
// Captures the exact raw bytes alongside the parsed body — Shopify webhook signatures are
// computed over the raw request body, and re-serializing the parsed JSON would not match.
app.use(express.json({ verify: (req, _res, buf) => { (req as express.Request).rawBody = Buffer.from(buf); } }));

// All Rankvora AI APIs mount under /api.
app.use('/api', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/shopify', shopifyRouter);
app.use('/api/link-scans', linkScansRouter);
app.use('/api/google', googleRouter);
// PageSpeed Insights. Its own mount rather than a branch of /api/google: it shares a vendor with
// Search Console and Analytics and nothing else — no OAuth grant, no account, no token — and
// hanging it off that router would imply a connection it neither makes nor needs.
app.use('/api/pagespeed', pagespeedRouter);
app.use('/api/users', usersRouter);
app.use('/api/stores', storesRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/audits', auditsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/findings', findingsRouter);
app.use('/api/ai-fixes', aiFixesRouter);
// The Missing images panel: products with no image, read live, and the upload / AI-drawn image
// that is added to one of them. Its upload route reads raw image bytes itself, so the JSON parser
// above leaves those requests alone.
app.use('/api/product-images', productImagesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/page-settings', pageSettingsRouter);
// Schema / JSON-LD settings. Separate from the SEO schema AUDIT, which reads what the storefront
// already renders — this is what Rankvora AI would generate from the store's own data.
app.use('/api/schema', schemaRouter);
// The AI Discovery pillar's merchant-owned inputs (IndexNow key, tracked questions) and the
// llms.txt / agents.md generator. Separate from the AI Discovery AUDIT, which reads what the
// storefront actually serves — this is what the merchant configures and what Rankvora AI would write.
app.use('/api/ai-discovery', aiDiscoveryRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/reports', reportsRouter);
// Render crashes reported by the frontend's ErrorBoundary, written to this log.
app.use('/api/client-errors', clientErrorsRouter);

app.use(notFound);
app.use(errorHandler);
