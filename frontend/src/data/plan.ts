/**
 * Rankvora AI has NO billing system: no provider, no subscriptions table, no plan API. Every
 * account is on the same free tier, so "Free" is true — and it is the only thing that is. This
 * must be replaced by a billing API when one is built.
 */
export const planInfo = {
  name: 'Free',
};
