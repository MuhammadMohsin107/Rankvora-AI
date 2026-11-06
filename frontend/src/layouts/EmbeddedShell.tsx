import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import AnalysisBanner from '../components/audit/AnalysisBanner';
import { CATALOG_KIND_LIST } from '../data/catalogKinds';
import { pillarList, pillarRoutes } from '../data/pillarMeta';

/**
 * ─── The app's frame inside the Shopify admin ────────────────────────
 *
 * Inside the admin, Shopify draws the chrome: the sidebar, the app's name and the page frame around
 * it. The app's own sidebar and header (Sidebar.tsx, Header.tsx) would sit inside that, duplicating
 * navigation and spending a third of a small screen on it — so in the admin this shell replaces them.
 *
 * NAVIGATION is Shopify's: `<s-app-nav>` hands the links to the admin, which shows them in its own
 * sidebar (a dropdown on Shopify mobile) and marks the one that matches the current URL. Clicking one
 * pushes the new path onto the history and fires `popstate`, which is what the router already
 * listens for — nothing here navigates by hand. It is one flat list: the admin allows no nesting.
 *
 * The app's name already links to `/`, the dashboard, so no "Dashboard" entry is added. The links are
 * the ones Sidebar.tsx lists, built from the same sources, so the two cannot drift apart.
 *
 * Shopify's own scrolling replaces the app's: the page scrolls as the iframe's document, instead of
 * inside an inner container that exists to keep a fixed sidebar in place. index.css releases html, body
 * and #root from the fixed height the standalone shell gives them, for exactly this case.
 */
interface NavLinkItem {
  to: string;
  label: string;
}

const NAV_LINKS: NavLinkItem[] = [
  ...pillarList.map((pillar) => ({ to: pillarRoutes[pillar.key], label: pillar.label })),
  ...CATALOG_KIND_LIST.map((config) => ({ to: config.listPath, label: config.navLabel })),
  { to: '/integrations', label: 'Integrations' },
];

export default function EmbeddedShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  // A new page starts at the top, as it did when the app's own scroll container reset itself.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname, location.search, location.hash]);

  return (
    <>
      <s-app-nav>
        {NAV_LINKS.map((link) => (
          <s-link key={link.to} href={link.to}>
            {link.label}
          </s-link>
        ))}
      </s-app-nav>

      {/* The analysis running, finished or failed — the same on every page. Renders nothing when no
          analysis is going and there is nothing to report. */}
      <AnalysisBanner />

      {/* No background of its own: the admin's shows through (see data-embedded in index.css). */}
      <main className="min-h-screen">{children}</main>
    </>
  );
}
