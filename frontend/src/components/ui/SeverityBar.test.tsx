import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SeverityBar from './SeverityBar';

describe('SeverityBar', () => {
  it('spells the counts out for a screen reader', () => {
    render(<SeverityBar counts={{ critical: 2, high: 1, medium: 0, low: 5 }} />);
    expect(screen.getByRole('img', { name: 'Open issues by severity: 2 critical, 1 high, 0 medium, 5 low' })).toBeInTheDocument();
  });

  it('sizes each segment by its share and draws no segment for a zero', () => {
    const { container } = render(<SeverityBar counts={{ critical: 1, high: 1, medium: 0, low: 2 }} showLegend={false} />);
    const widths = Array.from(container.querySelectorAll<HTMLElement>('[role="img"] > span')).map((segment) => segment.style.width);
    expect(widths).toEqual(['25%', '25%', '50%']);
  });

  it('draws an empty track, not a full bar, when nothing is open', () => {
    const { container } = render(<SeverityBar counts={{ critical: 0, high: 0, medium: 0, low: 0 }} />);
    expect(screen.getByRole('img', { name: 'No open issues' })).toBeInTheDocument();
    expect(container.querySelectorAll('[role="img"] > span')).toHaveLength(0);
  });

  it('lists every severity in the legend, and can hide it', () => {
    const { rerender } = render(<SeverityBar counts={{ critical: 3, high: 0, medium: 0, low: 0 }} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('Critical').parentElement).toHaveTextContent('Critical3');
    rerender(<SeverityBar counts={{ critical: 3, high: 0, medium: 0, low: 0 }} showLegend={false} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
