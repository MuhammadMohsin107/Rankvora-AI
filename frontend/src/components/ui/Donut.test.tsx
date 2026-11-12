import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Donut from './Donut';

const segments = [
  { label: 'Ready', value: 6, color: 'var(--c-success-600)' },
  { label: 'Needs work', value: 3, color: 'var(--c-warning-600)' },
  { label: 'Critical', value: 0, color: 'var(--c-critical-600)' },
];

describe('Donut', () => {
  it('names the chart and spells out every figure', () => {
    render(<Donut segments={segments} label="Products by readiness" />);
    expect(screen.getByRole('img', { name: 'Products by readiness: Ready 6, Needs work 3, Critical 0' })).toBeInTheDocument();
  });

  it('draws an arc only for a segment with a value, plus the track', () => {
    const { container } = render(<Donut segments={segments} label="x" />);
    // the track + 2 arcs; the zero segment has none
    expect(container.querySelectorAll('circle')).toHaveLength(3);
  });

  it('keeps zero segments in the legend', () => {
    render(<Donut segments={segments} label="x" />);
    expect(screen.getByText('Critical').parentElement).toHaveTextContent('Critical0');
  });

  it('draws only the empty track when every value is zero', () => {
    const { container } = render(<Donut segments={segments.map((segment) => ({ ...segment, value: 0 }))} label="x" />);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
  });

  it('shows the centre figure and the line under it', () => {
    render(<Donut segments={segments} label="x" center="67%" sub="ready" />);
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('sizes arcs to their share of the ring', () => {
    const { container } = render(<Donut segments={[{ label: 'A', value: 1, color: 'red' }, { label: 'B', value: 3, color: 'blue' }]} label="x" size={100} stroke={10} />);
    const arcs = Array.from(container.querySelectorAll('circle')).slice(1);
    const circumference = 2 * Math.PI * 45;
    const length = (index: number) => Number(arcs[index].getAttribute('stroke-dasharray')?.split(' ')[0]);
    // A quarter and three quarters, each less the 1.5px gap between arcs.
    expect(length(0)).toBeCloseTo(circumference / 4 - 1.5, 1);
    expect(length(1)).toBeCloseTo((circumference * 3) / 4 - 1.5, 1);
  });
});
