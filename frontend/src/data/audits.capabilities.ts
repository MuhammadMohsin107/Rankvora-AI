import { api } from '../lib/api';

/**
 * Which sub-pillars Rankvora AI's engine can actually measure.
 *
 * This exists so the UI can distinguish two empty states that look identical but mean opposite
 * things:
 *
 *   "No audit has been run yet"        → offer Run Audit; running one WILL populate the page.
 *   "Rankvora AI cannot measure this yet"  → do NOT offer Run Audit; running one changes nothing.
 *
 * Before this, every unimplemented sub-pillar offered a Run Audit button that started a real
 * (slow, rate-limited) audit and then returned the user to the same empty page — a dead end that
 * read as a broken feature.
 *
 * The list is derived on the backend from checkRegistry, so it cannot drift from what actually
 * runs. It is store-independent, so it is fetched once and cached for the session.
 */

const CAPABILITIES_PATH = '/audits/capabilities';

interface Capabilities {
  implemented: Set<string>;
  /** Bare sub-pillar slugs Rankvora AI can actually WRITE a value for. See isSubPillarFixable. */
  fixable: Set<string>;
}

let cached: Promise<Capabilities> | null = null;

function fetchCapabilities(): Promise<Capabilities> {
  cached ??= api
    .get<{ implementedSubPillars: string[]; fixableSubPillars?: string[] }>(CAPABILITIES_PATH)
    .then((data) => ({
      implemented: new Set(data.implementedSubPillars),
      // Absent on a backend older than this field. An empty set means "nothing is fixable", which
      // hides the bulk-fix UI — the safe direction to fail in, since the alternative is offering
      // to write values the fix engine will refuse.
      fixable: new Set(data.fixableSubPillars ?? []),
    }))
    // A failed capability lookup must not make working sub-pillars look unimplemented. Falling
    // back to an empty set would hide Run Audit everywhere; instead we rethrow-as-null so callers
    // treat capability as UNKNOWN and keep the previous (offer-the-run) behaviour.
    .catch(() => {
      cached = null;
      throw new Error('capabilities unavailable');
    });
  return cached;
}

export function fetchImplementedSubPillars(): Promise<Set<string>> {
  return fetchCapabilities().then((capabilities) => capabilities.implemented);
}

/**
 * Resolves whether a sub-pillar is measurable.
 * Returns `null` when the capability list could not be loaded — meaning "unknown", which callers
 * should treat as "assume it works" rather than "assume it is broken".
 */
export async function isSubPillarImplemented(pillar: string, subPillar: string): Promise<boolean | null> {
  try {
    const implemented = await fetchImplementedSubPillars();
    return implemented.has(`${pillar}/${subPillar}`);
  } catch {
    return null;
  }
}

/**
 * Whether Rankvora AI can WRITE a fix for this sub-pillar, as opposed to only reporting it.
 *
 * Measuring and fixing are different capabilities and the UI must not conflate them. Rankvora AI
 * writes exactly three fields — seo.title, seo.description and image.alt — so every other
 * sub-pillar can be diagnosed and not repaired. Offering "Generate fixes" on one of those led a
 * merchant to a dialog proposing to write a GTIN, which is a manufacturer's identifier that
 * cannot be derived from the product and must never be generated.
 *
 * Unlike `isSubPillarImplemented`, an unknown answer resolves to FALSE rather than null. The two
 * failure directions are not symmetrical: wrongly hiding Run Audit costs a click, while wrongly
 * offering a fix invites someone to write an invented value to their live store.
 */
export async function isSubPillarFixable(subPillar: string): Promise<boolean> {
  try {
    const capabilities = await fetchCapabilities();
    return capabilities.fixable.has(subPillar);
  } catch {
    return false;
  }
}
