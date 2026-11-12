import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Tabs, { type TabItem } from './Tabs';

type Id = 'all' | 'critical' | 'high' | 'low';

const TABS: TabItem<Id>[] = [
  { id: 'all', label: 'All', count: 12 },
  { id: 'critical', label: 'Critical', count: 3, dotClass: 'bg-critical-500' },
  { id: 'high', label: 'High', count: 0, disabled: true },
  { id: 'low', label: 'Low', count: 1200 },
];

function Harness({ onChange }: { onChange?: (id: Id) => void }) {
  const [active, setActive] = useState<Id>('all');
  return <Tabs tabs={TABS} active={active} onChange={(id) => { setActive(id); onChange?.(id); }} label="Filter issues" />;
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('Tabs', () => {
  it('is one labelled tablist with the active tab selected', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Filter issues' })).toBeInTheDocument();
    expect(tab(/^All/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Critical/)).toHaveAttribute('aria-selected', 'false');
  });

  it('puts only the selected tab in the Tab order', () => {
    render(<Harness />);
    expect(tab(/^All/)).toHaveAttribute('tabindex', '0');
    expect(tab(/^Critical/)).toHaveAttribute('tabindex', '-1');
  });

  it('selects a tab on click', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(tab(/^Critical/));
    expect(onChange).toHaveBeenCalledWith('critical');
    expect(tab(/^Critical/)).toHaveAttribute('aria-selected', 'true');
  });

  it('moves with the arrow keys, skips a disabled tab and wraps around', () => {
    render(<Harness />);
    fireEvent.keyDown(tab(/^All/), { key: 'ArrowRight' });
    expect(tab(/^Critical/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Critical/)).toHaveFocus();

    // "High" is disabled, so the next one is "Low".
    fireEvent.keyDown(tab(/^Critical/), { key: 'ArrowRight' });
    expect(tab(/^Low/)).toHaveAttribute('aria-selected', 'true');

    // Past the end it wraps to the first.
    fireEvent.keyDown(tab(/^Low/), { key: 'ArrowRight' });
    expect(tab(/^All/)).toHaveAttribute('aria-selected', 'true');

    // And back past the start it wraps to the last.
    fireEvent.keyDown(tab(/^All/), { key: 'ArrowLeft' });
    expect(tab(/^Low/)).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to the ends with Home and End', () => {
    render(<Harness />);
    fireEvent.keyDown(tab(/^All/), { key: 'End' });
    expect(tab(/^Low/)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab(/^Low/), { key: 'Home' });
    expect(tab(/^All/)).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves other keys alone', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(tab(/^All/), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not select a disabled tab', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(tab(/^High/));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('formats counts, and can wrap them in brackets', () => {
    const { rerender } = render(<Tabs tabs={TABS} active="all" onChange={() => undefined} label="x" />);
    expect(tab(/^Low/)).toHaveTextContent('Low1,200');
    rerender(<Tabs tabs={TABS} active="all" onChange={() => undefined} label="x" countStyle="parens" />);
    expect(tab(/^Low/)).toHaveTextContent('Low(1,200)');
  });

  it('keeps the first enabled tab reachable when the active id matches none', () => {
    render(<Tabs tabs={TABS} active={'gone' as Id} onChange={() => undefined} label="x" />);
    expect(tab(/^All/)).toHaveAttribute('tabindex', '0');
  });
});
