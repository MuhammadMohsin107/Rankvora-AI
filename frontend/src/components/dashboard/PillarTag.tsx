import type { PillarKey } from '../../data/dashboard/dashboard.types';
import { pillarMeta } from '../../data/pillarMeta';

/**
 * The pillar a finding belongs to, marked with that pillar's identity colour.
 *
 * The colour is on the DOT and the tinted ground only — never on the label. Several pillar
 * accents are light hues (Content is amber #f59e0b, AI Discovery #10b981) that fall far below
 * 4.5:1 as small text on a white card, so the word itself stays in the neutral text ramp.
 */
export default function PillarTag({ pillar, label }: { pillar: PillarKey; label: string }) {
  const meta = pillarMeta[pillar];
  return (
    <span
      className="inline-flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-surface-700"
      style={{ backgroundColor: meta?.tint }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta?.color }} aria-hidden="true" />
      {label}
    </span>
  );
}
