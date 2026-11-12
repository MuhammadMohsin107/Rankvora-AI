import { describe, expect, it, vi } from 'vitest';
import { clearRecentSearches, recentSearches, rememberSearch, searchDestinations } from './search';

describe('searchDestinations', () => {
  it('returns nothing for an empty or blank query', () => {
    expect(searchDestinations('')).toEqual([]);
    expect(searchDestinations('   ')).toEqual([]);
  });

  it('finds a page by its title and always answers with in-app paths', () => {
    const results = searchDestinations('products');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Products');
    for (const result of results) expect(result.to.startsWith('/')).toBe(true);
  });

  it('matches on keywords that are not in the title', () => {
    expect(searchDestinations('catalogue').some((result) => result.to === '/products')).toBe(true);
  });

  it('respects the limit', () => {
    expect(searchDestinations('a', 2).length).toBeLessThanOrEqual(2);
  });
});

describe('recent searches', () => {
  it('starts empty', () => {
    expect(recentSearches()).toEqual([]);
  });

  it('keeps the newest first, drops duplicates ignoring case, and ignores one-letter queries', () => {
    rememberSearch('title tags');
    rememberSearch('schema');
    rememberSearch('TITLE TAGS');
    rememberSearch('x');
    expect(recentSearches()).toEqual(['TITLE TAGS', 'schema']);
  });

  it('keeps at most five', () => {
    for (const word of ['aa', 'bb', 'cc', 'dd', 'ee', 'ff']) rememberSearch(word);
    expect(recentSearches()).toEqual(['ff', 'ee', 'dd', 'cc', 'bb']);
  });

  it('treats a corrupted stored value as empty instead of throwing', () => {
    window.localStorage.setItem('scorelo:recent-searches', '{not json');
    expect(recentSearches()).toEqual([]);
    window.localStorage.setItem('scorelo:recent-searches', JSON.stringify({ a: 1 }));
    expect(recentSearches()).toEqual([]);
  });

  it('clears the history', () => {
    rememberSearch('schema');
    clearRecentSearches();
    expect(recentSearches()).toEqual([]);
  });

  it('keeps working when the browser refuses to store anything', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => rememberSearch('schema')).not.toThrow();
  });
});
