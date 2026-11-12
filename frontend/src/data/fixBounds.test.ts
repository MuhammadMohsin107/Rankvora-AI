import { describe, expect, it } from 'vitest';
import { TITLE_FIELD_FLOOR, titleFieldBounds } from './fixBounds';

describe('titleFieldBounds', () => {
  it('keeps the plain range when the theme adds no suffix', () => {
    expect(titleFieldBounds(30, 60, 0)).toEqual({ minLength: 30, maxLength: 60 });
  });

  it('takes the theme suffix off both ends of the range', () => {
    // " | Store name" is 13 characters: the field may be 17-47 so the rendered title stays 30-60.
    expect(titleFieldBounds(30, 60, 13)).toEqual({ minLength: 17, maxLength: 47 });
  });

  it('never lets the minimum fall below the floor that still names the page', () => {
    const { minLength } = titleFieldBounds(30, 60, 28);
    expect(minLength).toBeGreaterThanOrEqual(TITLE_FIELD_FLOOR);
  });

  it('falls back to the plain range when the suffix fills the whole title', () => {
    expect(titleFieldBounds(30, 60, 60)).toEqual({ minLength: 30, maxLength: 60 });
    expect(titleFieldBounds(30, 60, 75)).toEqual({ minLength: 30, maxLength: 60 });
  });

  it('never returns a minimum above the maximum', () => {
    for (let suffix = 0; suffix <= 70; suffix += 1) {
      const { minLength, maxLength } = titleFieldBounds(30, 60, suffix);
      expect(minLength).toBeLessThanOrEqual(maxLength);
    }
  });
});
