import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProductReadiness, type ProductReadinessResult } from '../../data/aiDiscovery.repository';
import ProductReadinessPanel from './ProductReadinessPanel';

vi.mock('../../data/aiDiscovery.repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/aiDiscovery.repository')>()),
  fetchProductReadiness: vi.fn(),
}));

const result = (over: Partial<ProductReadinessResult['summary']> = {}): ProductReadinessResult => ({
  summary: {
    analyzed: 10, healthy: 6, needsWork: 3, critical: 1, averageScore: 80,
    available: 10, exact: true, truncated: false, unpublished: 0, capturedAt: '2026-11-12T00:00:00Z', ...over,
  },
  products: [],
});

async function check(data: ProductReadinessResult) {
  vi.mocked(fetchProductReadiness).mockResolvedValue(data);
  render(<MemoryRouter><ProductReadinessPanel /></MemoryRouter>);
  fireEvent.click(screen.getByText('Check my products'));
  await screen.findByText('Average readiness');
}

describe('ProductReadinessPanel summary', () => {
  beforeEach(() => { vi.mocked(fetchProductReadiness).mockReset(); });

  it('splits the assessed products into ready, needs work and critical', async () => {
    await check(result());
    expect(screen.getByRole('img', { name: 'Products by AI readiness: Ready 6, Needs work 3, Critical 1' })).toBeInTheDocument();
  });

  it('keeps the average readiness figure beside it', async () => {
    await check(result());
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('shows the real product count in the middle of the ring', async () => {
    await check(result({ analyzed: 1250, healthy: 1000, needsWork: 200, critical: 50 }));
    expect(screen.getByText('1,250')).toBeInTheDocument();
  });

  it('draws no summary for a store with nothing assessed — never an empty ring read as 0% ready', async () => {
    vi.mocked(fetchProductReadiness).mockResolvedValue(result({ analyzed: 0, healthy: 0, needsWork: 0, critical: 0, averageScore: null }));
    render(<MemoryRouter><ProductReadinessPanel /></MemoryRouter>);
    fireEvent.click(screen.getByText('Check my products'));
    await screen.findByText('No products yet.');
    expect(screen.queryByRole('img', { name: /Products by AI readiness/ })).not.toBeInTheDocument();
  });
});
