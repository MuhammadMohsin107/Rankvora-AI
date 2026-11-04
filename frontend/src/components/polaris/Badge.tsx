import type { ComponentProps, ReactNode } from 'react';

/**
 * A small status label, drawn by Polaris (`<s-badge>`).
 *
 * `tone` says what the label means: success (all good), warning (needs a look), critical (broken),
 * info (a fact), neutral (just a label). Polaris picks the colours.
 */
export type BadgeTone = 'neutral' | 'success' | 'warning' | 'critical' | 'info';

// Polaris separates "caution" (yellow) from "warning" (orange). The app's warning has always been the
// amber of "needs attention", which is Polaris's caution.
const POLARIS_TONE = { neutral: 'neutral', success: 'success', warning: 'caution', critical: 'critical', info: 'info' } as const;

export default function Badge({ children, tone = 'neutral', icon }: { children: ReactNode; tone?: BadgeTone; icon?: ComponentProps<'s-badge'>['icon'] }) {
  return <s-badge tone={POLARIS_TONE[tone]} icon={icon}>{children}</s-badge>;
}
