import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import PolarisNotice from './components/PolarisNotice';
import { ToastProvider } from './components/Toast';
import AppShell from './layouts/AppShell';
import Dashboard from './pages/Dashboard';
import NotFound from './pages/NotFound';
import RequireAuth from './components/auth/RequireAuth';
import OnboardingGate from './components/onboarding/OnboardingGate';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { isEmbedded } from './lib/embedded';
import { isPillarVisible } from './config/modules';
import { lazyPage } from './lib/lazyPage';

// Every page below is downloaded when its route is first opened, not with the first screen. Dashboard
// stays in the main bundle because it is where nearly every visit starts; NotFound is tiny.
const SeoDashboard = lazyPage(() => import('./pages/seo/SeoDashboard'));
const ContentDashboard = lazyPage(() => import('./pages/content/ContentDashboard'));
const SpeedDashboard = lazyPage(() => import('./pages/speed/SpeedDashboard'));
const AiDiscoveryDashboard = lazyPage(() => import('./pages/ai-discovery/AiDiscoveryDashboard'));
const CroDashboard = lazyPage(() => import('./pages/cro/CroDashboard'));
const NonSeoSubPillarPage = lazyPage(() => import('./pages/NonSeoSubPillarPage'));
// All 8 SEO sub-pillars render through the shared master template established on Title Tags; each
// supplies its own analysis data.
const SeoSubPillarRoute = lazyPage(() => import('./pages/seo/SeoSubPillarRoute'));
const CatalogList = lazyPage(() => import('./pages/CatalogList'));
const CatalogDetail = lazyPage(() => import('./pages/CatalogDetail'));
const Integrations = lazyPage(() => import('./pages/Integrations'));
const OpenFromShopify = lazyPage(() => import('./pages/auth/OpenFromShopify'));
const Onboarding = lazyPage(() => import('./pages/onboarding/Onboarding'));

/** Shown for the moment a page's file is on its way. Matches the skeleton the pages themselves use. */
function PageLoading() {
  return (
    <div className="page-shell pt-3" role="status" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-7 w-64 rounded-lg" />
    </div>
  );
}

/**
 * What /login is now: where a visitor lands who is not inside the Shopify admin.
 *
 * Rankvora AI runs inside the Shopify admin, where Shopify says which store is opening it, so there
 * is no sign-in to offer. Inside the admin this address leads straight to the app; on the bare site it
 * says how to reach it. (An already-open session is sent on to the dashboard.)
 */
function SignedOutEntry() {
  const { status } = useAuth();
  if (isEmbedded() || status === 'authenticated') return <Navigate to="/" replace />;
  return <OpenFromShopify />;
}

export default function App() {
  return (
    // Outermost, so a render crash anywhere below shows a recoverable screen instead of unmounting
    // the tree and leaving a blank page. See components/ErrorBoundary.tsx.
    <ErrorBoundary>
    <PolarisNotice />
    <ThemeProvider>
    <ToastProvider>
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<PageLoading />}>
        <Routes>
          {/* No sign-in page: the shop that opens the app is identified by Shopify itself (see
              SignedOutEntry). These render outside AppShell — no sidebar or header around them. */}
          <Route path="/login" element={<SignedOutEntry />} />
          {/* Guided setup renders outside AppShell: a merchant answering these five questions has
              no populated dashboard to navigate to yet, and a sidebar of empty pillars competes
              with the only task on screen. Still behind RequireAuth — it reads their store. */}
          <Route path="/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
          <Route path="*" element={<AuthenticatedApp />} />
          </Routes>
        </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </ToastProvider>
    </ThemeProvider>
    </ErrorBoundary>
  );
}

function AuthenticatedApp() {
  return (
    <RequireAuth>
      {/* Sends a merchant with a connected, un-started setup to /onboarding once per app mount.
          Fails open — see OnboardingGate. */}
      <OnboardingGate>
      {/* ─── Reload stays on the page you were on ──────────────────────
          A refresh re-renders the route in the address bar and nothing redirects it.

          A `ResetRouteOnReload` component used to sit here and send every refresh back to the
          dashboard. It is gone by product decision: pressing F5 on /seo/title-tags is how a
          person reloads the data in front of them, and answering that by throwing away the page
          they were reading costs them the scroll position, the filters and the row they had open.

          Deep links, bookmarks and the back/forward buttons behaved correctly under that
          component too — this simply makes reload behave the same as all three. */}
      <AppShell>
        <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          {/* The store's catalog, one list per kind — products, collections, blog articles: the
              latest audit's item-level checks, one row per item. ONE page for all three (see
              data/catalogKinds.ts); it reads the same sub-pillar endpoints as the pages above, see
              data/catalog.repository.ts. `key` gives each kind its own state. */}
          <Route path="/products" element={<CatalogList key="product" kind="product" />} />
          <Route path="/collections" element={<CatalogList key="collection" kind="collection" />} />
          <Route path="/blog-articles" element={<CatalogList key="article" kind="article" />} />
          {/* One item from a list, on its own page — the same catalog, one item's record. */}
          <Route path="/products/:itemId" element={<CatalogDetail key="product" kind="product" />} />
          <Route path="/collections/:itemId" element={<CatalogDetail key="collection" kind="collection" />} />
          <Route path="/blog-articles/:itemId" element={<CatalogDetail key="article" kind="article" />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/seo" element={<SeoDashboard />} />
          {/* /seo/schema used to be served by a bespoke page that rendered a hard-coded score,
              three invented findings and fourteen fabricated evidence rows without ever calling
              the API. It now falls through to the same real-data route as the other seven SEO
              sub-pillars. */}
          <Route path="/seo/:subPillar" element={<SeoSubPillarRoute />} />

          {/* Content / Speed / CRO / AI Discovery all use one `:subPillar` wildcard, matching
              how /seo already worked. Enumerating each slug meant an unknown one (a typo, a stale
              link) matched NO route and rendered a blank page inside the shell; NonSeoSubPillarPage
              now owns that case and redirects to the pillar dashboard, exactly as
              SeoSubPillarRoute does. The valid slugs are defined once, in the pillar catalogs. */}
          <Route path="/content" element={<ContentDashboard />} />
          <Route path="/content/:subPillar" element={<NonSeoSubPillarPage />} />

          <Route path="/speed" element={<SpeedDashboard />} />
          <Route path="/speed/:subPillar" element={<NonSeoSubPillarPage />} />

          {/* A pillar switched off in config/modules.ts has no routes at all, so its address falls
              through to "Page not found" like any other. Nothing here is removed — set the pillar's
              visibility back to true and these two routes are served again. */}
          {isPillarVisible('cro') && <Route path="/cro" element={<CroDashboard />} />}
          {isPillarVisible('cro') && <Route path="/cro/:subPillar" element={<NonSeoSubPillarPage />} />}

          <Route path="/ai-discovery" element={<AiDiscoveryDashboard />} />
          <Route path="/ai-discovery/:subPillar" element={<NonSeoSubPillarPage />} />

          {/* Anything else. Without this, an unmatched in-app URL rendered the shell with an
              empty main area and only a console warning to explain it. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </AppShell>
      </OnboardingGate>
    </RequireAuth>
  );
}
