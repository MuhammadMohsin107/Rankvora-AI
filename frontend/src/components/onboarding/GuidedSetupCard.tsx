import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ShieldCheck } from 'lucide-react';
import { Button } from '../workflows/WorkflowPrimitives';
import { SettingsCard } from '../settings/SettingsPrimitives';
import CapabilityList from './CapabilityList';
import { PILLAR_LABELS } from './OnboardingSteps';
import { isPillarVisible } from '../../config/modules';
import {
  STEP_META,
  consentLabel,
  fetchOnboardingShared,
  languageLabel,
  type OnboardingSnapshot,
} from '../../data/onboarding.repository';

/**
 * Guided setup, summarised inside Settings → Workspace & store.
 *
 * Its real job is to be the permanent way back in. The answers given during setup drive what
 * Rankvora AI drafts, what it ranks first, which pages it leaves alone and when it re-scans — so
 * every one of them has to remain changeable from a place a merchant would think to look.
 *
 * Laid out to Settings' density, not the setup page's, because it is one card among a column of
 * them.
 *
 * IT REPORTS CAPABILITIES, NOT A COUNT OF QUESTIONS ANSWERED. The card used to say "All answered"
 * while a store had never been analysed and no measurement source was connected. The list below the
 * answers is read from live records, so "finished" now means what the store can actually do.
 *
 * Shows what is actually stored, never a placeholder: an unanswered step reads "Not answered".
 */
export default function GuidedSetupCard() {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await fetchOnboardingShared();
        if (!cancelled) setSnapshot(state);
      } catch {
        // Leaves the card unrendered rather than showing an error inside a settings form.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!snapshot || !snapshot.connected) return null;

  // REQUIRED steps only: the optional measurement step is reported by the capability list below, not
  // counted against the merchant as an unanswered question.
  const required = snapshot.progress.filter((entry) => entry.required);
  const complete = required.filter((entry) => entry.status === 'complete').length;
  const { answers, preferences } = snapshot;
  const outstanding = STEP_META.filter(
    (meta) => required.some((entry) => entry.step === meta.step && entry.status !== 'complete'),
  ).map((meta) => meta.title);

  const improveFirst = answers.priorityPillars.filter(isPillarVisible).map((key) => PILLAR_LABELS[key] ?? key);

  const rows: Array<{ label: string; value: string | null }> = [
    { label: 'Store name', value: answers.organizationName },
    { label: 'Brand name', value: answers.brandName },
    // Every industry the merchant chose, joined — not the first one.
    { label: 'Industry', value: answers.industries.length > 0 ? answers.industries.join(', ') : null },
    { label: 'Priority markets', value: answers.targetCountries.length > 0 ? answers.targetCountries.join(', ') : null },
    { label: 'Content language', value: preferences.contentLanguage ? languageLabel(preferences.contentLanguage) : null },
    { label: 'Improve first', value: improveFirst.length > 0 ? improveFirst.join(', ') : null },
    {
      label: 'Target keywords',
      value: answers.targetKeywords.length > 0 ? `${answers.targetKeywords.length} set` : null,
    },
    {
      label: 'Priority pages',
      value: preferences.priorityResources.length > 0 ? `${preferences.priorityResources.length} chosen` : null,
    },
    {
      label: 'Pages left alone',
      value: preferences.protectedPaths.length > 0 ? `${preferences.protectedPaths.length} protected` : null,
    },
  ];

  return (
    <SettingsCard
      title="Guided setup"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11.5px] text-surface-500">
            {snapshot.completedAt
              ? `Completed ${new Date(snapshot.completedAt).toLocaleDateString()}.`
              : outstanding.length > 0
                ? `${outstanding.join(', ')} outstanding.`
                : 'Ready to finish.'}
          </p>
          <Button variant="secondary" onClick={() => navigate('/onboarding')}>
            {snapshot.completedAt ? 'Review answers' : 'Continue setup'}
          </Button>
        </div>
      }
    >
      {/* Progress of the REQUIRED steps — the ones that block finishing. */}
      <div className="flex items-center gap-2.5 pb-2">
        <div className="flex flex-1 items-center gap-1" role="img" aria-label={`${complete} of ${required.length} required steps answered`}>
          {required.map((entry) => (
            <span
              key={entry.step}
              className={`h-1 flex-1 rounded-full ${entry.status === 'complete' ? 'bg-success-500' : 'bg-surface-200'}`}
            />
          ))}
        </div>
        <p className="flex-shrink-0 text-[11px] font-semibold tabular-nums text-surface-600">
          {complete === required.length ? (
            <span className="flex items-center gap-1 text-success-700">
              <Check size={11} strokeWidth={3} aria-hidden="true" />
              Required steps answered
            </span>
          ) : (
            `${complete} of ${required.length} required answered`
          )}
        </p>
      </div>

      <dl className="border-t border-surface-100">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-surface-100 py-1.5 last:border-0"
          >
            <dt className="text-[12px] text-surface-500">{row.label}</dt>
            <dd
              className={`min-w-0 max-w-[60%] truncate text-right text-[12.5px] ${
                row.value ? 'font-semibold text-surface-900' : 'text-surface-400'
              }`}
              title={row.value ?? undefined}
            >
              {row.value ?? 'Not answered'}
            </dd>
          </div>
        ))}
      </dl>

      {/* Pulled out of the list: this one governs whether Rankvora AI may write to the store at all.
          Null reads as "review every change" because that is genuinely how the product behaves when
          the question is unanswered. */}
      <div className="mt-2 flex items-start gap-2 rounded-md border border-surface-200 bg-surface-50/60 px-2.5 py-2">
        <ShieldCheck size={14} className="mt-px flex-shrink-0 text-surface-500" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-surface-500">Publishing</p>
          <p className="mt-0.5 text-[12.5px] font-semibold text-surface-900">{consentLabel(answers.automationConsent)}</p>
        </div>
      </div>

      <div className="mt-3">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-surface-500">Capabilities</p>
        <CapabilityList capabilities={snapshot.capabilities} compact />
      </div>
    </SettingsCard>
  );
}
