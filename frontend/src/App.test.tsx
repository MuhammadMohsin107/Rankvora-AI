import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Routing, the sign-in gate, lazy loading and the loading state are the real App. What is stood in
// for is everything that fetches or that has its own tests: the session, the setup gate, the shell
// and the pages themselves (each one a one-line marker, loaded through the same lazy import).
const { auth, stub } = vi.hoisted(() => ({
  auth: { status: 'authenticated' as 'loading' | 'authenticated' | 'unauthenticated' },
  /** A page replaced by one line of text, still arriving through the app's own lazy import. */
  stub: (text: string) => async () => {
    const { createElement } = await import('react');
    return { default: () => createElement('p', null, text) };
  },
}));
vi.mock('./context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ status: auth.status }),
}));
vi.mock('./context/ThemeContext', () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./components/onboarding/OnboardingGate', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./layouts/AppShell', async () => {
  const { createElement } = await import('react');
  return { default: ({ children }: { children: React.ReactNode }) => createElement('div', { 'data-testid': 'shell' }, children) };
});

vi.mock('./pages/Dashboard', stub('page: dashboard'));
vi.mock('./pages/seo/SeoDashboard', stub('page: seo dashboard'));
vi.mock('./pages/seo/SeoSubPillarRoute', stub('page: seo sub-pillar'));
vi.mock('./pages/content/ContentDashboard', stub('page: content dashboard'));
vi.mock('./pages/speed/SpeedDashboard', stub('page: speed dashboard'));
vi.mock('./pages/ai-discovery/AiDiscoveryDashboard', stub('page: ai discovery dashboard'));
vi.mock('./pages/cro/CroDashboard', stub('page: cro dashboard'));
vi.mock('./pages/NonSeoSubPillarPage', stub('page: sub-pillar'));
vi.mock('./pages/CatalogList', stub('page: catalog list'));
vi.mock('./pages/CatalogDetail', stub('page: catalog detail'));
vi.mock('./pages/Integrations', stub('page: integrations'));
vi.mock('./pages/onboarding/Onboarding', stub('page: onboarding'));
vi.mock('./pages/auth/OpenFromShopify', stub('page: open from shopify'));

import App from './App';

function visit(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(() => {
  auth.status = 'authenticated';
});

describe('App routing', () => {
  // First on purpose: a lazy page is only "on its way" the first time it is opened in a run, and the
  // table below opens every one of them.
  it('shows a loading state while a page\'s file is on its way', async () => {
    visit('/integrations');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(await screen.findByText('page: integrations')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });

  it('opens the dashboard at the root, inside the shell', async () => {
    visit('/');
    expect(await screen.findByText('page: dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('shell')).toContainElement(screen.getByText('page: dashboard'));
  });

  it.each([
    ['/seo', 'page: seo dashboard'],
    ['/seo/title-tags', 'page: seo sub-pillar'],
    ['/content', 'page: content dashboard'],
    ['/content/product-descriptions', 'page: sub-pillar'],
    ['/speed', 'page: speed dashboard'],
    ['/speed/core-web-vitals', 'page: sub-pillar'],
    ['/ai-discovery', 'page: ai discovery dashboard'],
    ['/ai-discovery/llms-txt', 'page: sub-pillar'],
    ['/products', 'page: catalog list'],
    ['/collections', 'page: catalog list'],
    ['/blog-articles', 'page: catalog list'],
    ['/products/123', 'page: catalog detail'],
    ['/integrations', 'page: integrations'],
  ])('%s opens its page, loaded on demand', async (path, expected) => {
    visit(path);
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('opens guided setup outside the shell', async () => {
    visit('/onboarding');
    expect(await screen.findByText('page: onboarding')).toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
  });

  it('keeps a switched-off pillar (CRO) out of the app: its address is "Page not found"', async () => {
    visit('/cro');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText('page: cro dashboard')).not.toBeInTheDocument();
  });

  it('answers an unknown address with "Page not found", keeping the shell and echoing the path', async () => {
    visit('/definitely/not/a/page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('/definitely/not/a/page')).toBeInTheDocument();
    expect(screen.getByTestId('shell')).toBeInTheDocument();
  });
});

describe('App sign-in gate', () => {
  it('shows a neutral placeholder, not the app, while the session is being resolved', () => {
    auth.status = 'loading';
    visit('/seo');
    expect(screen.getByText(/loading your session/i)).toBeInTheDocument();
    expect(screen.queryByText('page: seo dashboard')).not.toBeInTheDocument();
  });

  it('keeps a signed-out visitor out of the app and sends them to /login', async () => {
    auth.status = 'unauthenticated';
    visit('/seo');
    expect(await screen.findByText('page: open from shopify')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(screen.queryByText('page: seo dashboard')).not.toBeInTheDocument();
  });

  it('sends a signed-in visitor who opens /login on to the dashboard', async () => {
    visit('/login');
    expect(await screen.findByText('page: dashboard')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });
});
