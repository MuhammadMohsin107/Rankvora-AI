/**
 * ─── The merchant's order of pillars ─────────────────────────────────
 *
 * Guided setup asks "What would you like Rankvora AI to improve first?" and the answer changes
 * PRIORITISATION, never coverage: every pillar is still analysed and still scored. This is the one
 * place that turns the answer into an order, so the dashboard's priority list and anything that
 * later ranks across pillars read the same rule.
 *
 * Pure, with no database — the caller supplies what the store saved. Two rules:
 *
 *   · the pillars the merchant chose come first, in the order they chose them;
 *   · every other pillar follows, in the product's own order.
 *
 * Nothing the merchant did not choose is dropped, and nothing they did not say is invented: a store
 * that saved no priorities gets `null`, which the caller reads as "leave the order alone".
 */
export function orderedPillars(saved: unknown, allPillars: readonly string[]): string[] | null {
  if (!Array.isArray(saved)) return null;

  const chosen: string[] = [];
  for (const entry of saved) {
    // Only pillars the product knows: a stale key from an older build must not become a rank.
    if (typeof entry === 'string' && allPillars.includes(entry) && !chosen.includes(entry)) chosen.push(entry);
  }
  if (chosen.length === 0) return null;

  return [...chosen, ...allPillars.filter((pillar) => !chosen.includes(pillar))];
}
