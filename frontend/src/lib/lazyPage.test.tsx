import { render, screen, waitFor } from '@testing-library/react';
import { Component, Suspense, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { lazyPage } from './lazyPage';

const FLAG = 'rankvora.chunk-reload';

class Catch extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) { return { message: error.message }; }
  render() { return this.state.message === null ? this.props.children : <p>caught: {this.state.message}</p>; }
}

/** Renders a lazy page the way the app does: inside Suspense, under an error boundary. */
function show(page: ReturnType<typeof lazyPage>) {
  const Page = page;
  render(
    <Catch>
      <Suspense fallback={<p>loading</p>}>
        <Page />
      </Suspense>
    </Catch>,
  );
}

function stubReload() {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  return reload;
}

describe('lazyPage', () => {
  it('shows the page and clears the reload flag when the file arrives', async () => {
    window.sessionStorage.setItem(FLAG, '1');
    show(lazyPage(async () => ({ default: () => <p>page ready</p> })));
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(await screen.findByText('page ready')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(FLAG)).toBeNull();
  });

  it('reloads once when the file is gone, as after a deploy, and does not flash an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = stubReload();
    show(lazyPage(async () => { throw new Error('Failed to fetch dynamically imported module'); }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(FLAG)).toBe('1');
    // The page is going away: it keeps showing the loading state rather than the error screen.
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(screen.queryByText(/caught/)).not.toBeInTheDocument();
  });

  it('does not loop: a second failure in the same session reaches the error boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = stubReload();
    window.sessionStorage.setItem(FLAG, '1');
    show(lazyPage(async () => { throw new Error('still gone'); }));
    expect(await screen.findByText('caught: still gone')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads when storage is blocked, so it cannot loop either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = stubReload();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    show(lazyPage(async () => { throw new Error('gone'); }));
    expect(await screen.findByText('caught: gone')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});
