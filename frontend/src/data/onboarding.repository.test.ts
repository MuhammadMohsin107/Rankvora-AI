import { describe, expect, it } from 'vitest';
import {
  FIELD_LIMITS,
  STOREFRONT_ADDRESS_MESSAGE,
  invalidAnswers,
  storefrontAddressProblem,
  type StepPayload,
} from './onboarding.repository';

/**
 * `storefrontAddressProblem` MIRRORS `normaliseDomain` in backend/src/services/onboarding.service.ts:
 * a bare host is accepted, anything that will not parse as a URL is refused, and so is a host without
 * a dot. These cases are the ones that rule turns on; if the server's rule changes, they are where to
 * look first.
 */
describe('storefrontAddressProblem', () => {
  it('has nothing to say about a blank address — the field is optional', () => {
    expect(storefrontAddressProblem('')).toBeNull();
    expect(storefrontAddressProblem('   ')).toBeNull();
    expect(storefrontAddressProblem(null)).toBeNull();
    expect(storefrontAddressProblem(undefined)).toBeNull();
  });

  it('accepts a full address', () => {
    expect(storefrontAddressProblem('https://northline.example')).toBeNull();
    expect(storefrontAddressProblem('http://northline.example')).toBeNull();
  });

  it('accepts a bare host, which is how people type it', () => {
    expect(storefrontAddressProblem('northline.example')).toBeNull();
    expect(storefrontAddressProblem('www.northline.example')).toBeNull();
  });

  it('accepts a path, query or fragment: the server keeps only the origin', () => {
    expect(storefrontAddressProblem('https://northline.example/collections/sale?x=1#top')).toBeNull();
  });

  it('ignores the whitespace around what was typed', () => {
    expect(storefrontAddressProblem('  northline.example  ')).toBeNull();
  });

  it('refuses a host with no dot: a typo or an intranet name, never a public storefront', () => {
    expect(storefrontAddressProblem('localhost')).toBe(STOREFRONT_ADDRESS_MESSAGE);
    expect(storefrontAddressProblem('https://shop')).toBe(STOREFRONT_ADDRESS_MESSAGE);
  });

  it('refuses text that is not an address at all', () => {
    expect(storefrontAddressProblem('not a url at all')).toBe(STOREFRONT_ADDRESS_MESSAGE);
    expect(storefrontAddressProblem('https://')).toBe(STOREFRONT_ADDRESS_MESSAGE);
  });

  it('says what to do, with an example, not what rule was broken', () => {
    expect(STOREFRONT_ADDRESS_MESSAGE).toBe('Enter a valid storefront address, for example https://example.com');
  });
});

describe('invalidAnswers', () => {
  const draft = (over: Partial<StepPayload>): StepPayload => ({ step: 1, ...over });

  it('names an address that cannot be saved, on the step that holds it', () => {
    expect(invalidAnswers(1, draft({ primaryDomain: 'localhost' }))).toEqual({ primaryDomain: STOREFRONT_ADDRESS_MESSAGE });
  });

  it('finds nothing wrong with a good address, a blank one, or none at all', () => {
    expect(invalidAnswers(1, draft({ primaryDomain: 'northline.example' }))).toEqual({});
    expect(invalidAnswers(1, draft({ primaryDomain: '' }))).toEqual({});
    expect(invalidAnswers(1, draft({}))).toEqual({});
  });

  it('does not look at the address on any other step', () => {
    for (const step of [2, 3, 4, 5]) {
      expect(invalidAnswers(step, draft({ primaryDomain: 'localhost' }))).toEqual({});
    }
  });
});

/** The server's own limits (backend/src/schemas/onboarding.schema.ts), so a field can stop at them. */
describe('FIELD_LIMITS', () => {
  it('matches what the server accepts', () => {
    expect(FIELD_LIMITS).toEqual({
      organizationName: 255,
      brandName: 255,
      primaryDomain: 512,
      brandedTerm: 80,
      keyword: 60,
      protectedPath: 512,
    });
  });
});
