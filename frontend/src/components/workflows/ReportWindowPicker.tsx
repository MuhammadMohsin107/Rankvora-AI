import { REPORT_WINDOWS, setReportDays } from '../../data/reportWindow';

/**
 * ─── The reporting period, as a control the merchant can reach ───────
 *
 * Sits in the header of every card that reads Google, next to the dates. One shared value behind
 * all of them — see data/reportWindow.ts — so changing it here changes it on the card beside this
 * one too, and the page cannot show two periods at once.
 *
 * A radiogroup rather than three buttons: these are one choice with three answers, and a screen
 * reader should announce the selected one as selected instead of reading out three unrelated
 * actions. Arrow keys work because the browser handles them for radios in a group.
 *
 * `disabled` is for a card that is mid-read. The period is a request, not a filter over data
 * already on screen, so letting it change while a read is in flight would land the wrong window's
 * numbers under the newly selected label.
 */
export function ReportWindowPicker({
  value,
  disabled = false,
  label = 'Reporting period',
}: {
  value: number;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-md border border-surface-200 bg-surface-50 p-0.5"
    >
      {REPORT_WINDOWS.map((option) => {
        const selected = option.days === value;
        return (
          <button
            key={option.days}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => setReportDays(option.days)}
            // The full phrase, because "7d" alone is not something to read aloud.
            aria-label={`Last ${option.days} days`}
            className={`cursor-pointer rounded px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60 ${
              selected
                ? 'bg-surface-0 text-surface-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                : 'text-surface-500 hover:text-surface-800'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
