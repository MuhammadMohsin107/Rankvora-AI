import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

function Trigger({ onAction, error = false }: { onAction?: () => void; error?: boolean }) {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast('Saved')}>plain</button>
      <button onClick={() => toast('Could not save', { error })}>error</button>
      <button onClick={() => toast('Removed', { action: { label: 'Undo', onAction: onAction ?? (() => undefined) } })}>action</button>
    </>
  );
}

function setup(props: Parameters<typeof Trigger>[0] = {}) {
  render(<ToastProvider><Trigger {...props} /></ToastProvider>);
  // fireEvent, not userEvent: user-event waits on real timers, which are faked in these tests.
  return { click: (element: HTMLElement) => act(() => { fireEvent.click(element); }) };
}

describe('toasts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows a message and removes it by itself after about three seconds', () => {
    const user = setup();
    user.click(screen.getByText('plain'));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(3100); });
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('keeps a message with a button much longer, so there is time to reach it', () => {
    const user = setup();
    user.click(screen.getByText('action'));
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByText('Removed')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.queryByText('Removed')).not.toBeInTheDocument();
  });

  it('runs the action once and closes the message', () => {
    const onAction = vi.fn();
    const user = setup({ onAction });
    user.click(screen.getByText('action'));
    user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Removed')).not.toBeInTheDocument();
  });

  it('can be dismissed by hand', () => {
    const user = setup();
    user.click(screen.getByText('plain'));
    user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('stacks several messages', () => {
    const user = setup();
    user.click(screen.getByText('plain'));
    user.click(screen.getByText('error'));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Could not save')).toBeInTheDocument();
  });

  it('is announced politely to screen readers', () => {
    const user = setup();
    user.click(screen.getByText('plain'));
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });
});

describe('useToast', () => {
  it('refuses to work outside the provider instead of failing silently', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
  });
});
