import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PolarisNotice from './PolarisNotice';

describe('PolarisNotice', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stays hidden while Polaris has not been given long to load, then warns', () => {
    render(<PolarisNotice />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(7900); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i);
    expect(screen.getByRole('button', { name: /reload the page/i })).toBeInTheDocument();
  });

  it('never shows once Polaris has registered, even if it arrives late', async () => {
    render(<PolarisNotice />);
    act(() => { vi.advanceTimersByTime(5000); });
    // The script turns up on a slow connection, before the wait is over.
    await act(async () => { customElements.define('s-button', class extends HTMLElement {}); });
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders nothing at all when Polaris is already there', () => {
    // 's-button' was registered by the previous test and stays registered in this file.
    const { container } = render(<PolarisNotice />);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(container).toBeEmptyDOMElement();
  });
});
