import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/reportClientError', () => ({ reportClientError: vi.fn() }));
// The fallback uses Polaris buttons, which jsdom does not define; a plain stand-in keeps this about the boundary.
vi.mock('./polaris/Button', () => ({
  default: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

import ErrorBoundary from './ErrorBoundary';
import { reportClientError } from '../lib/reportClientError';

function Boom(): never {
  throw new Error('render crashed');
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing is wrong', () => {
    render(<ErrorBoundary><p>all good</p></ErrorBoundary>);
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('shows the real error message and reports it instead of leaving a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('render crashed')).toBeInTheDocument();
    expect(reportClientError).toHaveBeenCalledTimes(1);
  });
});
