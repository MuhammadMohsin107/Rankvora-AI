import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Search,
  FileText,
  Zap,
  Target,
  Sparkles,
  Puzzle,
  BarChart3,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { pillarList, pillarRoutes } from '../data/pillarMeta';
import { fetchCurrentUser, initialsFor, subscribeCurrentUser } from '../data/user.repository';
import { planInfo } from '../data/plan';
import { CATALOG_KIND_LIST } from '../data/catalogKinds';
import { KIND_ICON } from './catalog/CatalogBits';
import type { UserRow } from '../data/api.types';

interface SidebarProps {
  isOpen: boolean;
  isCollapsed: boolean;
  onClose: () => void;
  onToggleCollapse: () => void;
}

// Map pillar keys to icons
const pillarIcons: Record<string, React.ReactNode> = {
  seo: <Search size={16} strokeWidth={2} />,
  content: <FileText size={16} strokeWidth={2} />,
  speed: <Zap size={16} strokeWidth={2} />,
  cro: <Target size={16} strokeWidth={2} />,
  'ai-discovery': <Sparkles size={16} strokeWidth={2} />,
};

interface GroupLink {
  to: string;
  label: string;
  icon: React.ReactNode;
}

// Core: the five audit pillars, one row each. A pillar opens its own page, which lists its
// sub-pillars — they are not repeated here, so the sidebar stays five rows long however many areas
// a pillar grows. Names, order and routes come from pillarMeta, the catalogue the router uses.
const CORE_GROUP_LABEL = 'Core';
const coreLinks: GroupLink[] = pillarList.map((pillar) => ({
  to: pillarRoutes[pillar.key],
  label: pillar.label,
  icon: pillarIcons[pillar.key],
}));

// Your store: its products, collections and blog articles. Labels and paths come from the same
// config the pages read (data/catalogKinds.ts) and the icons from the same place the lists'
// placeholders do, so the sidebar cannot drift from the pages it opens.
const STORE_GROUP_LABEL = 'Your store';
const storeLinks: GroupLink[] = CATALOG_KIND_LIST.map((config) => {
  const Icon = KIND_ICON[config.kind];
  return { to: config.listPath, label: config.navLabel, icon: <Icon size={16} strokeWidth={2} /> };
});

// Bottom utility links
const utilityLinks = [
  { id: 'integrations', label: 'Integrations', icon: <Puzzle size={16} strokeWidth={2} /> },
  { id: 'reports', label: 'Reports', icon: <BarChart3 size={16} strokeWidth={2} /> },
];

function SidebarGroup({ label, links, isCollapsed, onClose }: { label: string; links: GroupLink[]; isCollapsed: boolean; onClose: () => void }) {
  return (
    <div className="mb-1.5">
      <p className={`px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-surface-400 ${isCollapsed ? 'lg:hidden' : ''}`}>
        {label}
      </p>
      {isCollapsed && <div className="mx-1 my-1.5 hidden border-t border-chrome-border lg:block" aria-hidden="true" />}
      <div className="space-y-px">
        {links.map(({ to, label: linkLabel, icon }) => (
          // Not `end`: a pillar stays highlighted on its sub-pillar pages (/seo/title-tags), so the
          // merchant can see which pillar they are inside.
          <NavLink
            key={to}
            to={to}
            onClick={onClose}
            title={linkLabel}
            className={({ isActive }) => `relative flex items-center gap-2 w-full rounded-md text-[12.5px] font-medium transition-all duration-200 group ${isCollapsed ? 'justify-center px-2 py-1.5 lg:px-2' : 'px-2 py-1.5'} ${isActive ? 'text-surface-900 bg-chrome-hover' : 'text-surface-600 hover:bg-chrome-hover hover:text-surface-900'}`}
          >
            <span className="flex-shrink-0 text-surface-500 group-hover:text-surface-900">{icon}</span>
            <span className={isCollapsed ? 'lg:sr-only' : ''}>{linkLabel}</span>
          </NavLink>
        ))}
      </div>
    </div>
  );
}

export default function Sidebar({ isOpen, isCollapsed, onClose, onToggleCollapse }: SidebarProps) {
  const [user, setUser] = useState<UserRow | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchCurrentUser()
      .then((current) => { if (mounted) setUser(current); })
      .catch((error) => console.error('Failed to load current user', error));
    const unsubscribe = subscribeCurrentUser((current) => { if (mounted) setUser(current); });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden transition-opacity duration-300"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar
       *
       * MOBILE ONLY — the `lg:` rules below are untouched, so the desktop column is unchanged.
       *
       * Two base-layer bugs made the drawer eat the left of every phone screen:
       *
       *   1. `fixed` and `relative` were both present. Tailwind emits both and the winner is
       *      decided by their order in the generated stylesheet, not in this string — `relative`
       *      won, so the drawer stayed IN THE FLEX FLOW. `-translate-x-full` slid it out of sight
       *      while it kept reserving its width, leaving a dead band with the page squeezed beside
       *      it. Dropping `relative` changes nothing at lg, where `lg:static` already governed.
       *
       *   2. Width was declared only at `lg:`, so on a phone the element had no width and sized
       *      itself to its content — a band about as wide as the nav labels. The base width added
       *      here is overridden by the `lg:w-*` pair, and 288px is below both desktop widths, so
       *      the cap never binds there either. */}
      <aside
        className={`
          fixed top-0 left-0 z-50 h-full w-[82vw] max-w-[288px] flex-shrink-0 bg-chrome flex flex-col
          border-r border-chrome-border overflow-hidden
          transition-[width,transform] duration-300 ease-in-out
          lg:translate-x-0 lg:static lg:z-auto
          ${isCollapsed ? 'lg:w-[60px]' : 'lg:w-[232px]'}
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        role="navigation"
        aria-label="Main navigation"
      >
        {/* Logo Area — wordmark + tagline lockup.
            48px to match the header's new height, so the two pieces of chrome line up on one
            hairline instead of stepping. */}
        <div className={`flex h-12 flex-shrink-0 items-center justify-between border-b border-chrome-border bg-chrome px-3 ${isCollapsed ? 'lg:justify-center lg:px-2' : ''}`}>
          <NavLink to="/" onClick={onClose} aria-label="Rankvora AI home" className={`flex items-center gap-2 ${isCollapsed ? 'lg:justify-center' : ''}`}>
            {/* Logo mark — also what the collapsed rail shows */}
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] bg-logo-mark text-white shadow-sm">
              <BarChart3 size={14} strokeWidth={2.5} aria-hidden="true" />
            </div>
            {/* Wordmark with letter-spaced tagline */}
            <span className={`flex flex-col justify-center ${isCollapsed ? 'lg:hidden' : ''}`}>
              <span className="text-[17px] font-extrabold leading-[1] tracking-tight text-logo-text">
                Rankvora<span className="text-logo-mark"> AI</span>
              </span>
              <span className="mt-px text-[6.5px] font-semibold uppercase tracking-[0.28em] text-surface-400 leading-[1.2]">
                Store performance
              </span>
            </span>
          </NavLink>

          {/* Collapse / expand rail control.
              Fixed 32px box rather than a bare glyph: the pointer cursor and the hover state then
              cover the whole hit area instead of only the 16px SVG, and because only colours change
              on hover — never size or padding — the header cannot shift under the cursor. The two
              icons share one frame, so swapping them on toggle is also shift-free. */}
          <button
            type="button"
            onClick={onToggleCollapse}
            className={`
              hidden h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md
              border border-chrome-border bg-surface-0 text-chrome-muted shadow-sm
              transition-colors duration-150 ease-in-out
              hover:border-surface-300 hover:bg-chrome-hover hover:text-surface-800
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1
              lg:flex
            `}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isCollapsed
              ? <PanelLeftOpen size={15} aria-hidden="true" />
              : <PanelLeftClose size={15} aria-hidden="true" />}
          </button>
          <button
            onClick={onClose}
            className="lg:hidden rounded-md p-1 text-surface-400 transition-colors hover:bg-surface-200 hover:text-surface-900"
            aria-label="Close sidebar"
          >
            <X size={17} />
          </button>
        </div>

        {/* Navigation.
            Rows are 28px rather than 40px, and the pillars no longer open into their sub-pillars
            here, so the whole menu fits a 768px-tall laptop without scrolling the chrome. */}
        <nav className={`flex-1 overflow-y-auto sidebar-scroll py-2 ${isCollapsed ? 'px-2' : 'px-2'}`}>
          {/* Dashboard Link */}
          <div className="mb-1.5">
            <NavLink
              to="/"
              end
              onClick={onClose}
              title="Dashboard"
              className={({ isActive }) => `
                relative flex items-center gap-2 w-full rounded-md text-[13px] font-medium
                transition-all duration-200 border border-transparent
                ${isCollapsed ? 'justify-center px-2 py-1.5 lg:px-2' : 'px-2 py-1.5'}
                ${isActive
                  ? 'text-surface-900 bg-chrome-active shadow-[inset_0_0_0_1px_rgba(0,0,0,0.02)]'
                  : 'text-surface-600 hover:bg-chrome-hover hover:text-surface-900'
                }
              `}
            >
              <span className="flex-shrink-0 text-surface-500">
                <LayoutDashboard size={16} strokeWidth={2} />
              </span>
              <span className={isCollapsed ? 'lg:sr-only' : ''}>Dashboard</span>
            </NavLink>
          </div>

          {/* Core: the five pillars. Each opens its own page, where its sub-pillars are listed. */}
          <SidebarGroup label={CORE_GROUP_LABEL} links={coreLinks} isCollapsed={isCollapsed} onClose={onClose} />

          {/* Your store: products, collections and blog articles — what the audit looked at, item by item. */}
          <SidebarGroup label={STORE_GROUP_LABEL} links={storeLinks} isCollapsed={isCollapsed} onClose={onClose} />

          <div className="my-2 border-t border-chrome-border" />

          {/* Utility Links */}
          <div className="space-y-px">
            {utilityLinks.map((link) => (
              <NavLink
                key={link.id}
                to={`/${link.id}`}
                onClick={onClose}
                title={link.label}
                className={({ isActive }) => `relative flex items-center gap-2 w-full rounded-md text-[12.5px] font-medium transition-all duration-200 group ${isCollapsed ? 'justify-center px-2 py-1.5 lg:px-2' : 'px-2 py-1.5'} ${isActive ? 'text-surface-900 bg-chrome-hover' : 'text-surface-600 hover:bg-chrome-hover hover:text-surface-900'}`}
              >
                <span className="flex-shrink-0 text-surface-500 group-hover:text-surface-900">
                  {link.icon}
                </span>
                <span className={isCollapsed ? 'lg:sr-only' : ''}>{link.label}</span>
              </NavLink>
            ))}
          </div>
        </nav>

        {/* User Profile Bottom Area */}
        <div className={`flex-shrink-0 border-t border-surface-200 ${isCollapsed ? 'p-2' : 'p-2'}`}>
          <div className={`flex w-full items-center gap-2 py-1.5 ${isCollapsed ? 'justify-center px-2' : 'px-2'}`}>
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-surface-300 bg-surface-100 text-surface-900">
              <span className="text-[10.5px] font-bold">{user ? initialsFor(user.fullName) : '··'}</span>
            </div>
            <div className={`flex-1 min-w-0 text-left ${isCollapsed ? 'lg:sr-only' : ''}`}>
              <p className="truncate text-[12px] font-semibold text-surface-900">
                {user?.fullName ?? 'Loading…'}
              </p>
              <p className="truncate text-[10.5px] font-medium text-surface-500">
                {planInfo.name} Plan
              </p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
