import { describe, expect, it } from 'vitest';
import { catalogLinkForMove, itemsForMove, type CatalogItem } from './catalog.repository';

const move = { route: '/seo/title-tags', title: 'Products with a title that is too short' };

function item(id: string, checks: Array<{ route: string; findingTitle: string | null }>): CatalogItem {
  return { id, checks } as unknown as CatalogItem;
}

describe('itemsForMove', () => {
  it('keeps only the items whose row in that check belongs to that finding', () => {
    const items = [
      item('1', [{ route: '/seo/title-tags', findingTitle: move.title }]),
      item('2', [{ route: '/seo/title-tags', findingTitle: 'Another finding' }]),
      item('3', [{ route: '/seo/meta-descriptions', findingTitle: move.title }]),
      item('4', []),
    ];
    expect(itemsForMove(items, move).map((entry) => entry.id)).toEqual(['1']);
  });
});

describe('catalogLinkForMove', () => {
  it('points at the kind\'s list and carries the move in the address', () => {
    const link = catalogLinkForMove('product', move);
    const [path, query] = link.split('?');
    expect(path).toBe('/products');
    const params = new URLSearchParams(query);
    expect(params.get('area')).toBe('seo/title-tags');
    expect(params.get('issue')).toBe(move.title);
  });
});
