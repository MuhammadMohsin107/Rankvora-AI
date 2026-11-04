import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Header from '../components/Header';
import AnalysisBanner from '../components/audit/AnalysisBanner';
import { isEmbedded } from '../lib/embedded';
import EmbeddedShell from './EmbeddedShell';

interface AppShellProps {
  children: React.ReactNode;
}

/**
 * The frame around every in-app page. Inside the Shopify admin the admin supplies the chrome, so the
 * app draws none (EmbeddedShell); anywhere else — local development — it draws its own sidebar and
 * header as it always has. Which one is fixed for the life of the page, so the choice is made once
 * here rather than inside the hooks of either.
 */
export default function AppShell({ children }: AppShellProps) {
  if (isEmbedded()) return <EmbeddedShell>{children}</EmbeddedShell>;
  return <StandaloneShell>{children}</StandaloneShell>;
}

function StandaloneShell({ children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scorelo-sidebar-collapsed') === 'true';
  });
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    window.localStorage.setItem('scorelo-sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname, location.search, location.hash]);

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-surface-50">
      {/* Sidebar */}
      <Sidebar
        isOpen={sidebarOpen}
        isCollapsed={sidebarCollapsed}
        onClose={() => setSidebarOpen(false)}
        onToggleCollapse={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      {/* Main Content Area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header */}
        <Header onMenuClick={() => setSidebarOpen(true)} />

        {/* The analysis running, finished or failed — the same on every page. Renders nothing when
            no analysis is going and there is nothing to report. */}
        <AnalysisBanner />

        {/* Page Content. This is the app's one outer scroll container, so it alone contains
            overscroll: the pull stops here instead of reaching the browser. Scrollers INSIDE a page
            (the priority-issues list, the Google data lists, the catalog table) must NOT set
            overscroll-behavior themselves — with the default, a wheel or trackpad that reaches the
            top or bottom of one carries on into this container instead of stopping dead at the edge. */}
        <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </main>
      </div>
    </div>
  );
}
