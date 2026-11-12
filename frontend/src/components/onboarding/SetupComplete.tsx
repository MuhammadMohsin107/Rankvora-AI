import { ArrowRight } from 'lucide-react';
import { ActionButton } from './OnboardingPrimitives';

/**
 * ─── The end of guided setup ─────────────────────────────────────────
 *
 * Shown once, right after the last save went through, instead of dropping the merchant onto the
 * dashboard with no sign that anything happened. It does two things only: says setup is done, and
 * reads back what they told us so a wrong answer is caught now rather than three screens later.
 *
 * EVERY LINE IS THE MERCHANT'S OWN ANSWER. `rows` comes from the draft they just saved — nothing
 * here is generated, estimated or promised. In particular it does not claim an analysis has started:
 * the server saves the answers and marks setup complete, and what happens next is on the dashboard.
 *
 * The mark draws itself (a circle, then the tick) with two CSS animations in index.css, and is plain
 * and still under `prefers-reduced-motion`.
 */
export interface CompletionRow {
  label: string;
  value: string;
}

export default function SetupComplete({ rows, onContinue }: { rows: CompletionRow[]; onContinue: () => void }) {
  return (
    <div className="px-5 py-10 text-center sm:px-10 sm:py-14">
      <span className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-success-50 ring-1 ring-inset ring-success-100">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <circle className="onboarding-check-ring" cx="20" cy="20" r="16" strokeWidth="2.5" strokeLinecap="round" style={{ stroke: 'var(--c-success-600)' }} />
          <path className="onboarding-check-mark" d="M12.5 20.5l5.2 5.2 9.8-10.9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--c-success-600)' }} />
        </svg>
      </span>

      <h1 className="mx-auto mt-7 max-w-[20ch] text-balance text-[30px] font-semibold leading-[1.1] tracking-[-0.035em] text-surface-950 sm:text-[38px]">
        You’re all set
      </h1>
      <p className="mx-auto mt-3 max-w-[46ch] text-pretty text-[15px] leading-[1.6] text-surface-500">
        Your answers are saved and shape every analysis Rankvora runs on your store.
      </p>

      {rows.length > 0 && (
        <dl className="mx-auto mt-9 max-w-xl divide-y divide-surface-100 overflow-hidden rounded-2xl bg-surface-50 text-left ring-1 ring-inset ring-surface-200/70">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5 px-5 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
              <dt className="flex-shrink-0 text-[12.5px] font-medium text-surface-500">{row.label}</dt>
              <dd className="min-w-0 text-pretty text-[14px] font-semibold tracking-[-0.01em] text-surface-950 sm:text-right">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-9 flex justify-center">
        <ActionButton onClick={onContinue} className="min-w-52">
          Go to dashboard
          <ArrowRight size={16} aria-hidden="true" />
        </ActionButton>
      </div>
    </div>
  );
}
