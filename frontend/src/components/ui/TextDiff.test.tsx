import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TextDiff, { diffWords, MAX_CELLS } from './TextDiff';

const text = (parts: ReturnType<typeof diffWords>, kind: string) => parts.filter((part) => part.kind === kind).map((part) => part.text.trim());

describe('diffWords', () => {
  it('returns nothing for two empty strings', () => {
    expect(diffWords('', '')).toEqual([]);
  });

  it('marks a missing before as all added, and a missing after as all removed', () => {
    expect(diffWords('', 'New title')).toEqual([{ kind: 'added', text: 'New title' }]);
    expect(diffWords('Old title', '')).toEqual([{ kind: 'removed', text: 'Old title' }]);
  });

  it('finds the words that changed and keeps the rest', () => {
    const parts = diffWords('Blue cotton shirt for men', 'Blue linen shirt for men');
    expect(text(parts, 'removed')).toEqual(['cotton']);
    expect(text(parts, 'added')).toEqual(['linen']);
    expect(parts[0]).toEqual({ kind: 'same', text: 'Blue ' });
    expect(parts[parts.length - 1]).toEqual({ kind: 'same', text: ' shirt for men' });
  });

  it('is lossless: before is the same + removed runs, after is the same + added runs', () => {
    const before = 'Free shipping on all orders over $50 this week';
    const after = 'Free returns on all orders this week only';
    const parts = diffWords(before, after);
    expect(parts.filter((part) => part.kind !== 'added').map((part) => part.text).join('')).toBe(before);
    expect(parts.filter((part) => part.kind !== 'removed').map((part) => part.text).join('')).toBe(after);
  });

  it('reports identical text as one unchanged run', () => {
    expect(diffWords('Same text', 'Same text')).toEqual([{ kind: 'same', text: 'Same text' }]);
  });

  it('shows very large inputs whole instead of comparing them', () => {
    const big = Array.from({ length: Math.ceil(Math.sqrt(MAX_CELLS)) + 50 }, (_, index) => `w${index}`).join(' ');
    const parts = diffWords(big, `${big} extra`);
    expect(parts.map((part) => part.kind)).toEqual(['removed', 'added']);
  });
});

describe('TextDiff', () => {
  it('renders removed text as <del> and new text as <ins>', () => {
    const { container } = render(<TextDiff before="Cheap blue shirt" after="Soft blue shirt" />);
    expect(container.querySelector('del')).toHaveTextContent('Cheap');
    expect(container.querySelector('ins')).toHaveTextContent('Soft');
  });

  it('has an accessible description of the markup', () => {
    const { getByLabelText } = render(<TextDiff before="a" after="b" />);
    expect(getByLabelText(/removed text is struck through/i)).toBeInTheDocument();
  });
});
