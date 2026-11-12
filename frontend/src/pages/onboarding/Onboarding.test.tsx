import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeOnboarding,
  fetchOnboarding,
  fetchOnboardingSuggestions,
  saveOnboardingStep,
  type OnboardingSnapshot,
  type OnboardingSuggestions,
  type StepPayload,
} from '../../data/onboarding.repository';
import Onboarding from './Onboarding';

vi.mock('../../data/onboarding.repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/onboarding.repository')>()),
  fetchOnboarding: vi.fn(),
  fetchOnboardingSuggestions: vi.fn(),
  saveOnboardingStep: vi.fn(),
  completeOnboarding: vi.fn(),
}));

// Step 4 reads the real Google / Analytics / PageSpeed connections. Nothing here reaches it, but the
// modules are imported, so they are kept off the network.
vi.mock('../../data/google.repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/google.repository')>()),
  fetchGoogleStatus: vi.fn().mockResolvedValue({ configured: false, connected: false, siteUrl: null }),
}));

const snapshot = (over: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot => ({
  connected: true,
  currentStep: 1,
  progress: [1, 2, 3, 4, 5].map((step) => ({ step, status: 'pending' as const, required: step !== 4 })),
  startedAt: null,
  deferredAt: null,
  completedAt: null,
  answers: {
    organizationName: null, brandName: null, primaryDomain: null, industries: [], sellsDescription: null,
    businessModels: [], catalogShape: null, targetCountries: [], targetLanguages: [], primaryMarket: null,
    targetKeywords: [], brandedTerms: [], competitorDomains: [], primaryGoal: null, priorityPillars: [],
    automationConsent: null, alertFrequency: null,
  },
  preferences: { contentLanguage: null, priorityResources: [], protectedPaths: [], preferredScanHour: null },
  capabilities: [],
  schedule: { enabled: true, frequency: 'Weekly', preferredHour: null, timeZone: 'America/Toronto', nextScanAt: null, lastAnalyzedAt: null },
  trackedQuestions: [],
  firstAuditAt: null,
  detection: {
    available: true,
    unavailableReason: null,
    shop: {
      name: 'Northline Home', contactEmail: null, myshopifyDomain: 'northline-home.myshopify.com',
      primaryUrl: 'https://northline.example', currencyCode: 'CAD', ianaTimezone: 'America/Toronto', country: 'Canada', planName: null,
    },
  },
  options: {
    industries: ['Home & garden', 'Apparel'],
    businessModels: [],
    catalogShapes: [],
    primaryGoals: [],
    pillars: ['seo', 'content', 'speed', 'ai-discovery'],
    alertFrequencies: ['Weekly', 'No email alerts'],
    analysisFrequencies: ['Daily', 'Weekly'],
  },
  ...over,
});

const suggestions = (): OnboardingSuggestions => ({
  available: true,
  unavailableReason: null,
  industry: null,
  catalogShape: null,
  keywords: [],
  questions: [],
  brandedTerms: [],
  languages: [{ locale: 'en', name: 'English', primary: true, published: true }],
  detectedCountry: 'Canada',
  catalogue: { productTotal: null, collectionCount: 0, sampledProducts: 0 },
  content: {
    publishedProducts: { count: 128, exact: true },
    publishedCollections: { count: 9, exact: true },
    pages: { count: 6, exact: true },
    articles: { count: 14, exact: true },
  },
  resources: { products: [], collections: [] },
});

function Where() {
  const { pathname } = useLocation();
  return <p data-testid="where">{pathname}</p>;
}

function open(initial = '/onboarding') {
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const button = (name: RegExp | string) => screen.getByRole('button', { name });

beforeEach(() => {
  // jsdom implements none of these; the page scrolls to the top of each step and to a flagged field.
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  vi.mocked(fetchOnboarding).mockReset();
  vi.mocked(fetchOnboardingSuggestions).mockReset().mockResolvedValue(suggestions());
  vi.mocked(saveOnboardingStep).mockReset().mockImplementation(async (payload: StepPayload) => {
    const base = snapshot();
    return {
      ...base,
      currentStep: payload.step + 1,
      progress: base.progress.map((entry) => (entry.step === payload.step ? { ...entry, status: 'complete' as const } : entry)),
    };
  });
  vi.mocked(completeOnboarding).mockReset().mockResolvedValue(snapshot({ completedAt: '2026-11-12T00:00:00Z' }));
});

describe('Onboarding · states', () => {
  it('shows a labelled loading state while the store is read', async () => {
    vi.mocked(fetchOnboarding).mockReturnValue(new Promise(() => undefined));
    open();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading your store…');
  });

  it('says so, with a way to retry, when setup cannot be loaded', async () => {
    vi.mocked(fetchOnboarding).mockRejectedValue(new Error('boom'));
    open();
    expect(await screen.findByRole('heading', { name: 'Setup could not be loaded' })).toBeInTheDocument();
    expect(button('Try again')).toBeInTheDocument();
  });

  it('asks a store that is not connected to connect first, and can send them on', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(snapshot({ connected: false }));
    open();
    expect(await screen.findByRole('heading', { name: 'Connect Shopify first' })).toBeInTheDocument();
    fireEvent.click(button(/Connect Shopify/));
    expect(await screen.findByTestId('where')).toHaveTextContent('/integrations');
  });

  it('lets a merchant who is not ready leave without connecting', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(snapshot({ connected: false }));
    open();
    await screen.findByRole('heading', { name: 'Connect Shopify first' });
    fireEvent.click(button('Skip for now'));
    expect(await screen.findByTestId('where')).toHaveTextContent('/');
  });
});

describe('Onboarding · the flow', () => {
  beforeEach(() => { vi.mocked(fetchOnboarding).mockResolvedValue(snapshot()); });

  it('opens on step 1 with the guide beside it', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Confirm your store' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    const guide = screen.getAllByRole('navigation', { name: 'Setup progress' })[0];
    expect(within(guide).getByRole('button', { name: /Confirm your store/ })).toHaveAttribute('aria-current', 'step');
  });

  it('shows what Shopify reported, read-only', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    expect(screen.getByText('Imported from Shopify')).toBeInTheDocument();
    expect(screen.getByText('https://northline.example')).toBeInTheDocument();
    expect(await screen.findByText('128')).toBeInTheDocument();
  });

  it('opens every field empty — a suggestion is never written in for the merchant', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    expect(screen.getByLabelText('Store name')).toHaveValue('');
    expect(screen.getByLabelText('Storefront address')).toHaveValue('');
  });

  it('offers the Shopify name as a one-click answer, and uses it only when asked', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this' })[0]);
    expect(screen.getByLabelText('Store name')).toHaveValue('Northline Home');
  });

  it('stops on a missing required answer: flags the field, says how many, and saves nothing', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    fireEvent.click(button('Confirm and continue'));

    expect(await screen.findByText('2 answers are still needed on this step.')).toBeInTheDocument();
    expect(screen.getByText('Confirm the store name your reports should use.')).toBeInTheDocument();
    expect(screen.getByText('Choose at least one market that matters to your business.')).toBeInTheDocument();
    expect(screen.getByLabelText('Store name')).toHaveAttribute('aria-invalid', 'true');
    expect(saveOnboardingStep).not.toHaveBeenCalled();
    // Still on step 1.
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  });

  it('clears the flag the moment the field is touched', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    fireEvent.click(button('Confirm and continue'));
    await screen.findByText('Confirm the store name your reports should use.');
    fireEvent.change(screen.getByLabelText('Store name'), { target: { value: 'N' } });
    expect(screen.queryByText('Confirm the store name your reports should use.')).not.toBeInTheDocument();
  });

  async function answerStepOne() {
    fireEvent.change(screen.getByLabelText('Store name'), { target: { value: 'Northline Home' } });
    fireEvent.change(screen.getByLabelText('Priority markets'), { target: { value: 'Canada' } });
  }

  it('saves only that step’s answers and moves on to step 2', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    await answerStepOne();
    fireEvent.click(button('Confirm and continue'));

    expect(await screen.findByRole('heading', { level: 1, name: 'Your business' })).toBeInTheDocument();
    expect(saveOnboardingStep).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(saveOnboardingStep).mock.calls[0][0];
    expect(payload).toMatchObject({ step: 1, organizationName: 'Northline Home', targetCountries: ['Canada'] });
    // Nothing from another step travels with it.
    expect(payload).not.toHaveProperty('brandName');
    expect(screen.getByText('Step 2 of 5')).toBeInTheDocument();
  });

  it('keeps an earlier answer when the merchant goes Back', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    await answerStepOne();
    fireEvent.click(button('Confirm and continue'));
    await screen.findByRole('heading', { level: 1, name: 'Your business' });

    fireEvent.click(button('Back'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Confirm your store' })).toBeInTheDocument();
    expect(screen.getByLabelText('Store name')).toHaveValue('Northline Home');
  });

  it('has no Back on the first step', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('says what went wrong, and stays put, when a save fails', async () => {
    vi.mocked(saveOnboardingStep).mockRejectedValue(new Error('offline'));
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    await answerStepOne();
    fireEvent.click(button('Confirm and continue'));
    await waitFor(() => expect(screen.getByText(/couldn't save that/i)).toBeInTheDocument());
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  });

  it('opens at the first step still owed when some are already answered', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(
      snapshot({
        currentStep: 3,
        progress: [1, 2, 3, 4, 5].map((step) => ({ step, status: step <= 2 ? ('complete' as const) : ('pending' as const), required: step !== 4 })),
      }),
    );
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Priorities' })).toBeInTheDocument();
  });

  it('does not offer a step beyond the first unanswered required one', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    const guide = screen.getAllByRole('navigation', { name: 'Setup progress' })[0];
    expect(within(guide).getByRole('button', { name: /Priorities/ })).toBeDisabled();
  });
});

describe('Onboarding · finishing and editing', () => {
  it('lands on the permissions step with a Finish action, and will not finish without a choice', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(
      snapshot({
        currentStep: 5,
        progress: [1, 2, 3, 4, 5].map((step) => ({ step, status: step === 5 ? ('pending' as const) : ('complete' as const), required: step !== 4 })),
      }),
    );
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Permissions & monitoring' })).toBeInTheDocument();
    fireEvent.click(button('Finish setup'));
    expect(await screen.findByText('Choose how changes to your store are approved.')).toBeInTheDocument();
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it('presents a finished setup as an edit session, with a way back to the app', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(
      snapshot({
        completedAt: '2026-11-01T00:00:00Z',
        progress: [1, 2, 3, 4, 5].map((step) => ({ step, status: 'complete' as const, required: step !== 4 })),
      }),
    );
    open();
    expect(await screen.findByText('Setup is complete. Edit any step.')).toBeInTheDocument();
    expect(button('Save and close')).toBeInTheDocument();
    expect(button('Next')).toBeInTheDocument();
  });

  it('offers no exit during first-time setup — the steps are the way through', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(snapshot());
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    expect(screen.queryByRole('button', { name: 'Save and close' })).not.toBeInTheDocument();
  });
});

const answered = (over: Partial<OnboardingSnapshot['answers']> = {}): Partial<OnboardingSnapshot> => ({
  answers: {
    ...snapshot().answers,
    organizationName: 'Northline Home',
    brandName: 'Northline',
    industries: ['Home & garden'],
    targetCountries: ['Canada', 'United States'],
    priorityPillars: ['seo', 'speed'],
    automationConsent: 'ask',
    ...over,
  },
  preferences: { contentLanguage: 'en', priorityResources: [], protectedPaths: [], preferredScanHour: null },
});

describe('Onboarding · step 3, priorities', () => {
  const atStepThree = (over: Partial<OnboardingSnapshot['answers']> = {}) => {
    vi.mocked(fetchOnboarding).mockResolvedValue(
      snapshot({
        ...answered(over),
        currentStep: 3,
        progress: [1, 2, 3, 4, 5].map((step) => ({ step, status: step <= 2 ? ('complete' as const) : ('pending' as const), required: step !== 4 })),
      }),
    );
  };
  const tile = (name: RegExp) => screen.getByRole('checkbox', { name }).closest('label') as HTMLElement;

  it('numbers the chosen tiles in the order they will be looked at', async () => {
    atStepThree({ priorityPillars: ['speed', 'seo'] });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Priorities' });
    expect(within(tile(/Store performance/)).getByText('1')).toBeInTheDocument();
    expect(within(tile(/Search visibility/)).getByText('2')).toBeInTheDocument();
  });

  it('shows no numbers, and no order list, for a single choice', async () => {
    atStepThree({ priorityPillars: ['seo'] });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Priorities' });
    expect(within(tile(/Search visibility/)).queryByText(/^\d$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Priority order')).not.toBeInTheDocument();
  });

  it('lists the order under its own heading, with a count', async () => {
    atStepThree({ priorityPillars: ['seo', 'speed'] });
    open();
    await screen.findByText('Priority order');
    expect(screen.getByText('2 areas')).toBeInTheDocument();
  });

  it('renumbers the tiles when the order is changed', async () => {
    atStepThree({ priorityPillars: ['seo', 'speed'] });
    open();
    await screen.findByText('Priority order');
    fireEvent.click(screen.getByRole('button', { name: 'Move Store performance up' }));
    expect(within(tile(/Store performance/)).getByText('1')).toBeInTheDocument();
    expect(within(tile(/Search visibility/)).getByText('2')).toBeInTheDocument();
  });

  it('drops a tile from the order when it is unticked', async () => {
    atStepThree({ priorityPillars: ['seo', 'speed'] });
    open();
    await screen.findByText('Priority order');
    fireEvent.click(screen.getByRole('checkbox', { name: /Store performance/ }));
    expect(screen.queryByText('Priority order')).not.toBeInTheDocument();
  });
});

describe('Onboarding · the completion screen', () => {
  const atFinish = () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(
      snapshot({
        ...answered(),
        currentStep: 5,
        progress: [1, 2, 3, 4, 5].map((step) => ({ step, status: step === 5 ? ('pending' as const) : ('complete' as const), required: step !== 4 })),
      }),
    );
  };

  it('replaces the form with a confirmation once setup is saved and completed', async () => {
    atFinish();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Permissions & monitoring' });
    fireEvent.click(button('Finish setup'));
    expect(await screen.findByRole('heading', { level: 1, name: 'You’re all set' })).toBeInTheDocument();
    expect(completeOnboarding).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Finish setup' })).not.toBeInTheDocument();
  });

  it('reads back the merchant’s own answers', async () => {
    atFinish();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Permissions & monitoring' });
    fireEvent.click(button('Finish setup'));
    await screen.findByRole('heading', { level: 1, name: 'You’re all set' });
    const summary = within(screen.getByText('Store').closest('dl') as HTMLElement);
    expect(summary.getByText('Northline Home')).toBeInTheDocument();
    expect(summary.getByText('Canada, United States')).toBeInTheDocument();
    expect(summary.getByText('Home & garden')).toBeInTheDocument();
    expect(summary.getByText('Search visibility → Store performance')).toBeInTheDocument();
    expect(summary.getByText('Review every change before publishing')).toBeInTheDocument();
  });

  it('only says what is true: the answers are saved, with no claim that an analysis has started', async () => {
    atFinish();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Permissions & monitoring' });
    fireEvent.click(button('Finish setup'));
    await screen.findByRole('heading', { level: 1, name: 'You’re all set' });
    expect(screen.getByText(/Your answers are saved/)).toBeInTheDocument();
    expect(screen.queryByText(/analysis (has|is) (started|running)|first analysis/i)).not.toBeInTheDocument();
  });

  it('leaves for the dashboard only when the merchant says so', async () => {
    atFinish();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Permissions & monitoring' });
    fireEvent.click(button('Finish setup'));
    await screen.findByRole('heading', { level: 1, name: 'You’re all set' });
    expect(screen.queryByTestId('where')?.textContent).not.toBe('/');
    fireEvent.click(button(/Go to dashboard/));
    expect(await screen.findByTestId('where')).toHaveTextContent('/');
  });

  it('does not show it when the final save fails', async () => {
    atFinish();
    vi.mocked(completeOnboarding).mockRejectedValue(new Error('offline'));
    open();
    await screen.findByRole('heading', { level: 1, name: 'Permissions & monitoring' });
    fireEvent.click(button('Finish setup'));
    await waitFor(() => expect(screen.getByText(/couldn't save that/i)).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'You’re all set' })).not.toBeInTheDocument();
    expect(button('Finish setup')).toBeEnabled();
  });
});

describe('Onboarding · a used suggestion goes away', () => {
  beforeEach(() => { vi.mocked(fetchOnboarding).mockResolvedValue(snapshot()); });

  const storeNote = () => screen.queryByText(/Your Shopify store name is/);
  const domainNote = () => screen.queryByText(/Your Shopify primary domain is/);

  it('removes the store-name note once "Use this" has been pressed, and keeps the value', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    expect(storeNote()).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this' })[0]);
    expect(screen.getByLabelText('Store name')).toHaveValue('Northline Home');
    expect(storeNote()).not.toBeInTheDocument();
    expect(screen.queryByText('In use')).not.toBeInTheDocument();
  });

  it('removes only the note that was used', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this' })[0]);
    expect(storeNote()).not.toBeInTheDocument();
    expect(domainNote()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
    expect(screen.getByLabelText('Storefront address')).toHaveValue('https://northline.example');
    expect(domainNote()).not.toBeInTheDocument();
  });

  it('offers the suggestion again if the field is changed to something else', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this' })[0]);
    expect(storeNote()).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Store name'), { target: { value: 'Something else' } });
    expect(storeNote()).toBeInTheDocument();
  });

  it('removes the detected-country note once the market is added', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    const add = await screen.findByRole('button', { name: 'Add Canada' });
    fireEvent.click(add);
    expect(screen.queryByText(/billing address is in Canada/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Canada' })).toBeInTheDocument();
  });

  it('removes an alias suggestion once it has been added to the field', async () => {
    vi.mocked(fetchOnboardingSuggestions).mockResolvedValue({ ...suggestions(), brandedTerms: ['Northline Home Co'] });
    vi.mocked(fetchOnboarding).mockResolvedValue(
      snapshot({
        currentStep: 2,
        progress: [1, 2, 3, 4, 5].map((step) => ({ step, status: step === 1 ? ('complete' as const) : ('pending' as const), required: step !== 4 })),
      }),
    );
    open();
    const chip = await screen.findByRole('button', { name: 'Northline Home Co' });
    fireEvent.click(chip);
    expect(screen.getByRole('button', { name: 'Remove Northline Home Co' })).toBeInTheDocument();
    // The chip that was just used is no longer on offer, and neither is the row that held it.
    expect(screen.queryByRole('button', { name: 'Northline Home Co' })).not.toBeInTheDocument();
    expect(screen.queryByText('From your store name')).not.toBeInTheDocument();
  });
});

describe('Onboarding · Languages to audit', () => {
  beforeEach(() => { vi.mocked(fetchOnboarding).mockResolvedValue(snapshot()); });

  it('is offered when Shopify names the store’s languages', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    expect(await screen.findByText('Languages to audit')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /English \(en\)/ })).toBeInTheDocument();
  });

  it('is left out, with no apology in its place, when the languages could not be read', async () => {
    vi.mocked(fetchOnboardingSuggestions).mockResolvedValue({ ...suggestions(), languages: null });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    await screen.findByText('Imported from Shopify');
    await waitFor(() => expect(screen.queryByText('Reading your store…')).not.toBeInTheDocument());
    expect(screen.queryByText('Languages to audit')).not.toBeInTheDocument();
    expect(screen.queryByText(/languages could not be read/i)).not.toBeInTheDocument();
  });

  it('is left out when the store reports no languages at all', async () => {
    vi.mocked(fetchOnboardingSuggestions).mockResolvedValue({ ...suggestions(), languages: [] });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    await waitFor(() => expect(screen.queryByText('Reading your store…')).not.toBeInTheDocument());
    expect(screen.queryByText('Languages to audit')).not.toBeInTheDocument();
    expect(screen.queryByText(/no enabled languages/i)).not.toBeInTheDocument();
  });

  it('is left out when the suggestions could not be loaded at all', async () => {
    vi.mocked(fetchOnboardingSuggestions).mockRejectedValue(new Error('offline'));
    open();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your store' });
    await waitFor(() => expect(screen.queryByText('Reading your store…')).not.toBeInTheDocument());
    expect(screen.queryByText('Languages to audit')).not.toBeInTheDocument();
  });
});
