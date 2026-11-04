import { useId, type InputHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

interface AuthFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'> {
  label: string;
  /** Field-level validation message. Also drives aria-invalid / aria-describedby. */
  error?: string;
  /** Persistent helper text shown when there is no error. */
  hint?: string;
  /** Leading icon inside the field. Decorative — the label carries the meaning, so it is
   * aria-hidden and the input keeps its full accessible name without it. */
  icon?: LucideIcon;
}

/**
 * Labelled input with accessible error wiring and an optional leading icon.
 *
 * FILLED, NOT OUTLINED. The field is a tinted well (`bg-surface-50`) on the sheet (`surface-0`):
 * one step darker than the sheet in dark mode, a light grey well in light mode. That is how an
 * inset field is expressed in both themes without a hard border doing the work — the border here
 * is a faint hairline that only becomes visible as a state (hover, focus, error).
 *
 * Focus uses the shell's `--auth-accent` / `--auth-ring` rather than the app's brand token, so
 * the fields match the title, links and button around them.
 */
export default function AuthField({ label, error, hint, icon: Icon, type = 'text', ...inputProps }: AuthFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className="auth-field-group">
      <label
        htmlFor={id}
        className="block text-[13px] font-medium text-surface-700 transition-colors duration-200"
      >
        {label}
      </label>

      {/* h-11 (44px) is the WCAG 2.5.5 minimum touch target, and the floor here. */}
      <div className="relative mt-1.5">
        {Icon && (
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400">
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
          </span>
        )}

        <input
          {...inputProps}
          id={id}
          type={type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`auth-input h-11 w-full rounded-[10px] border bg-surface-0 pr-4 text-[14px] text-surface-900 shadow-[0_1px_2px_rgba(16,24,40,0.06)] outline-none transition-all duration-200 placeholder:text-surface-400
            ${Icon ? 'pl-10' : 'pl-4'}
            focus:bg-surface-0 focus:shadow-[0_0_0_3px_var(--auth-ring)]
            disabled:cursor-not-allowed disabled:text-surface-400 disabled:hover:border-surface-200
            ${
              error
                ? 'border-critical-400 focus:border-critical-500 focus:shadow-[0_0_0_3px_rgba(220,38,38,0.12)]'
                : 'border-surface-200/80 hover:border-surface-300 focus:border-[color:var(--auth-accent)]'
            }`}
        />
      </div>

      {error ? (
        <p
          id={errorId}
          role="alert"
          className="auth-rise mt-1.5 flex items-center gap-1.5 pl-1 text-[12px] font-medium text-critical-600"
          style={{ animationDuration: '0.28s' }}
        >
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-critical-500" />
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 pl-1 text-[12px] text-surface-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
