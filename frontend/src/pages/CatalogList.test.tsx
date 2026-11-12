import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Catalog, CatalogItem } from '../data/catalog.repository';

// The page reads three things over the network. Everything below them (tabs, search, sort, paging,
// the filter from a "winning move", the address) is the real code.
vi.mock('../data/catalog.repository', async (importActual) => ({
  ...(await importActual<typeof import('../data/catalog.repository')>()),
  fetchCatalog: vi.fn(),
}));
vi.mock('../data/onboarding.repository', () => ({
  fetchOnboardingShared: vi.fn(async () => ({ preferences: { priorityResources: [] } })),
}));
vi.mock('../data/dashboard/dashboard.repository', async (importActual) => ({
  ...(await importActual<typeof import('../data/dashboard/dashboard.repository')>()),
  fetchDashboardData: vi.fn(),
}));

// Panels with their own data and their own tests' worth of behaviour are stood in for.
vi.mock('../components/audit/RunAuditButton', () => ({ default: () => <p>run audit button</p> }));
vi.mock('../components/dashboard/WinningMovesPanel', () => ({ default: () => null }));
vi.mock('../components/catalog/MovesPanel', () => ({
  default: ({ issues, onSelect }: { issues: Array<{ title: string }>; onSelect: (issue: unknown) => void }) => (
    <div>
      {issues.map((issue) => (
        <button key={issue.title} onClick={() => onSelect(issue)}>move: {issue.title}</button>
      ))}
    </div>
  ),
}));

import CatalogList from './CatalogList';
import { fetchCatalog } from '../data/catalog.repository';
import { fetchDashboardData } from '../data/dashboard/dashboard.repository';

const MOVE = { route: '/seo/title-tags', title: 'Titles that are too short', affectedCount: 4 };

function item(id: string, name: string, counts: { critical: number; warnings: number; passing: number }, extra: Partial<CatalogItem> = {}): CatalogItem {
  const total = counts.critical + counts.warnings + counts.passing;
  return {
    id, name, url: `https://shop.example/products/${id}`, imageSrc: null, images: [], imageCount: null,
    updatedAt: null, publishedAt: null, productCount: null, productType: null, vendor: null,
    checks: Array.from({ length: total }, () => ({ route: '/other', findingTitle: null })),
    ...counts,
    passRate: total === 0 ? 0 : Math.round((counts.passing / total) * 100),
    ...extra,
  } as unknown as CatalogItem;
}

const ITEMS: CatalogItem[] = [
  item('1', 'Alpine Jacket', { critical: 2, warnings: 0, passing: 1 }, {
    checks: [{ route: MOVE.route, findingTitle: MOVE.title }, { route: '/x', findingTitle: null }, { route: '/y', findingTitle: null }] as never,
  }),
  item('2', 'Birch Bowl', { critical: 0, warnings: 3, passing: 1 }),
  item('3', 'Cedar Chair', { critical: 0, warnings: 0, passing: 4 }),
  item('4', 'Dune Duffel', { critical: 1, warnings: 0, passing: 0 }),
];

function catalog(items: CatalogItem[] = ITEMS): Catalog {
  return { items, checksRead: [{ key: 'seo/title-tags', label: 'Title tags', pillarLabel: 'SEO' }], checksUnavailable: [], lastAnalyzed: null };
}

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname}{search}</p>;
}

async function open(url = '/products', kind: 'product' | 'collection' | 'article' = 'product') {
  render(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <Routes>
        <Route path="/products" element={<CatalogList kind={kind} />} />
        <Route path="/products/:itemId" element={<p>item page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('tablist');
}

const where = () => screen.getByTestId('where').textContent;
const names = () => screen.queryAllByRole('listitem').map((row) => within(row).getByText(/^(Alpine|Birch|Cedar|Dune)/).textContent);
const tab = (name: RegExp) => screen.getByRole('tab', { name });

beforeEach(() => {
  vi.mocked(fetchCatalog).mockResolvedValue(catalog());
  vi.mocked(fetchDashboardData).mockResolvedValue({ priorityIssues: [MOVE], overallScore: 80 } as never);
});

describe('CatalogList page', () => {
  it('shows a loading state, then every item, with counts on the tabs', async () => {
    await open();
    // "Needs most work first": the lowest share of checks passed leads.
    expect(names()).toEqual(['Dune Duffel', 'Birch Bowl', 'Alpine Jacket', 'Cedar Chair']);
    expect(tab(/all products/i)).toHaveTextContent('(4)');
    expect(tab(/critical issues/i)).toHaveTextContent('(2)');
    expect(tab(/warnings/i)).toHaveTextContent('(1)');
    expect(tab(/passing/i)).toHaveTextContent('(1)');
  });

  it('tells the merchant when the audit has not run yet', async () => {
    const { ApiError } = await import('../lib/api');
    vi.mocked(fetchCatalog).mockRejectedValue(new ApiError('No audit yet', 404, 'AUDIT_NOT_FOUND'));
    render(<MemoryRouter initialEntries={['/products']}><Routes><Route path="/products" element={<CatalogList kind="product" />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('run audit button')).toBeInTheDocument();
  });

  it('offers a retry when loading fails, and retries', async () => {
    vi.mocked(fetchCatalog).mockRejectedValueOnce(new Error('boom'));
    render(<MemoryRouter initialEntries={['/products']}><Routes><Route path="/products" element={<CatalogList kind="product" />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    fireEvent.click(document.querySelector('s-button')!);
    await screen.findByRole('tablist');
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
  });

  describe('tabs live in the address', () => {
    it('starts on the tab named in the address', async () => {
      await open('/products?tab=critical');
      expect(tab(/critical issues/i)).toHaveAttribute('aria-selected', 'true');
      expect(names()).toEqual(['Dune Duffel', 'Alpine Jacket']);
    });

    it('writes the chosen tab into the address and leaves it out for "all"', async () => {
      await open();
      fireEvent.click(tab(/warnings/i));
      expect(where()).toBe('/products?tab=warnings');
      expect(names()).toEqual(['Birch Bowl']);
      fireEvent.click(tab(/all products/i));
      expect(where()).toBe('/products');
      expect(names()).toHaveLength(4);
    });

    it('falls back to "all" for a tab it does not know', async () => {
      await open('/products?tab=nonsense');
      expect(tab(/all products/i)).toHaveAttribute('aria-selected', 'true');
      expect(names()).toHaveLength(4);
    });
  });

  describe('search and sort', () => {
    it('filters by name as the merchant types', async () => {
      await open();
      const field = document.querySelector('s-search-field')!;
      act(() => { field.value = 'birch'; field.dispatchEvent(new Event('input')); });
      await waitFor(() => expect(names()).toEqual(['Birch Bowl']));
    });

    it('says so when nothing matches', async () => {
      await open();
      const field = document.querySelector('s-search-field')!;
      act(() => { field.value = 'zzz'; field.dispatchEvent(new Event('input')); });
      expect(await screen.findByText(/no products match this filter/i)).toBeInTheDocument();
    });

    it('sorts A to Z when asked', async () => {
      await open();
      const select = document.querySelector('s-select')!;
      act(() => { select.value = 'name'; select.dispatchEvent(new Event('change')); });
      await waitFor(() => expect(names()).toEqual(['Alpine Jacket', 'Birch Bowl', 'Cedar Chair', 'Dune Duffel']));
    });
  });

  describe('a winning move filters the list', () => {
    it('shows only the items the move names, keeps the tab, and clears again', async () => {
      await open('/products?tab=critical');
      fireEvent.click(await screen.findByText(`move: ${MOVE.title}`));

      const params = new URLSearchParams(where()!.split('?')[1]);
      expect(params.get('area')).toBe('seo/title-tags');
      expect(params.get('issue')).toBe(MOVE.title);
      expect(params.get('tab')).toBe('critical');
      expect(names()).toEqual(['Alpine Jacket']);
      expect(screen.getByText(/filtered/i)).toBeInTheDocument();

      // Clearing the filter removes the move's own parameters and nothing else.
      fireEvent.click(document.querySelector('s-button[accessibilitylabel="Clear the filter"]')!);
      expect(where()).toBe('/products?tab=critical');
      expect(names()).toEqual(['Dune Duffel', 'Alpine Jacket']);
    });

    it('opens already filtered from a link such as the dashboard\'s', async () => {
      await open(`/products?area=seo/title-tags&issue=${encodeURIComponent(MOVE.title)}`);
      expect(names()).toEqual(['Alpine Jacket']);
    });
  });

  it('opens an item\'s own page when its row is clicked', async () => {
    await open();
    const row = screen.getAllByRole('listitem').find((entry) => within(entry).queryByText('Alpine Jacket'))!;
    fireEvent.click(within(row).getByRole('button'));
    expect(await screen.findByText('item page')).toBeInTheDocument();
    expect(where()).toBe('/products/1');
  });

  it('pages a long list fifty at a time', async () => {
    const many = Array.from({ length: 120 }, (_, i) => item(String(1000 + i), `Alpine ${String(i).padStart(3, '0')}`, { critical: 0, warnings: 0, passing: 1 }));
    vi.mocked(fetchCatalog).mockResolvedValue(catalog(many));
    await open();
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText(/1–50 of 120/)).toBeInTheDocument();
    fireEvent.click(document.querySelector('s-button[icon="chevron-right"]')!);
    expect(await screen.findByText(/51–100 of 120/)).toBeInTheDocument();
  });
});
