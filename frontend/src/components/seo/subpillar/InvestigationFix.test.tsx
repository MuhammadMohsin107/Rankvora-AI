import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceRow, SubPillarFinding } from '../../../data/seo/subpillar.model';
import type { AiFixProposal } from '../../../data/findings.repository';
import { fetchAiFixProposals } from '../../../data/findings.repository';
import InvestigationFix, { type FixCapability } from './InvestigationFix';

vi.mock('../../../data/findings.repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../data/findings.repository')>()),
  fetchAiFixProposals: vi.fn(),
  planAiFixes: vi.fn(),
  applyFixes: vi.fn(),
}));

const finding = { id: '7' } as unknown as SubPillarFinding;

const row: EvidenceRow = {
  id: 'product:42',
  status: 'missing-title',
  cells: { name: 'Blue shirt', path: '/products/blue-shirt' },
  current: { label: 'Current title', value: 'Blue cotton shirt' },
} as unknown as EvidenceRow;

const capability = (field: string): FixCapability => ({
  field: { subPillar: 'title-tags', field, label: field === 'seo.title' ? 'SEO title' : 'SEO meta description', minLength: 10, maxLength: 160, generator: 'ai' },
  aiEnabled: true,
  model: 'test-model',
});

const held = (proposedValue: string, field: string): AiFixProposal => ({
  id: 1, findingId: 7, resourceType: 'product', resourceId: '42', field,
  currentValue: 'Blue cotton shirt', proposedValue, deterministicValue: null,
  reason: 'Matches the product.', status: 'proposed', statusDetail: null, model: 'test-model',
});

function open(field: string, proposedValue: string) {
  vi.mocked(fetchAiFixProposals).mockResolvedValue([held(proposedValue, field)]);
  render(<MemoryRouter><InvestigationFix finding={finding} rows={[row]} capability={capability(field)} autoGenerate={false} /></MemoryRouter>);
}

describe('InvestigationFix draft preview', () => {
  beforeEach(() => { vi.mocked(fetchAiFixProposals).mockReset(); });

  it('offers a closed preview once a draft exists', async () => {
    open('seo.title', 'Blue linen shirt');
    const summary = await screen.findByText('Preview changes');
    expect(summary.closest('details')).not.toHaveAttribute('open');
  });

  it('shows what changed, word by word, from the real current value', async () => {
    open('seo.title', 'Blue linen shirt');
    await screen.findByText('Preview changes');
    expect(document.querySelector('del')).toHaveTextContent('cotton');
    expect(document.querySelector('ins')).toHaveTextContent('linen');
  });

  it('shows a title fix as the title of a search result, with the item’s own path', async () => {
    open('seo.title', 'Blue linen shirt');
    await screen.findByText('Preview changes');
    const preview = screen.getByRole('img', { name: 'Search result preview' });
    expect(preview).toHaveTextContent('/products/blue-shirt');
    expect(preview).toHaveTextContent('Blue linen shirt');
  });

  it('shows a description fix as the description line only — it never invents a title', async () => {
    open('seo.description', 'A soft linen shirt for warm days, cut for an easy fit.');
    await screen.findByText('Preview changes');
    const preview = screen.getByRole('img', { name: 'Search result preview' });
    expect(preview).toHaveTextContent('A soft linen shirt');
    expect(preview).not.toHaveTextContent('Blue cotton shirt');
  });

  it('shows no search-result preview for a field that is not part of one', async () => {
    open('image.alt', 'Folded blue linen shirt on a white table');
    await screen.findByText('Preview changes');
    expect(screen.queryByRole('img', { name: 'Search result preview' })).not.toBeInTheDocument();
  });

  it('says so when the draft is the same as the current value', async () => {
    open('seo.title', 'Blue cotton shirt');
    const summary = await screen.findByText('Preview changes');
    // The card also says this beside Apply; this is the one inside the preview.
    await waitFor(() => expect(within(summary.closest('details') as HTMLElement).getByText('Same as the current value.')).toBeInTheDocument());
  });
});
