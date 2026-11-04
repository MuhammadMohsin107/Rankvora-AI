import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Eye, EyeOff, Info, X } from 'lucide-react';
import { Button } from '../workflows/WorkflowPrimitives';

/** Card shell — matches Integrations / Reports exactly. */
export const settingsCard =
  'rounded-lg border border-surface-200 bg-surface-0 shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)]';

export const eyebrowClass = 'text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500';

/** One settings group: title, description and its fields. */
export function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className={`${settingsCard} overflow-hidden`}>
      <div className="border-b border-surface-200 px-3 py-2">
        <h3 className="text-[12.5px] font-bold tracking-tight text-surface-950">{title}</h3>
        {description && <p className="mt-0.5 max-w-2xl text-[11.5px] leading-[1.4] text-surface-500">{description}</p>}
      </div>
      <div className="px-3 py-2">{children}</div>
      {footer && <div className="border-t border-surface-200 bg-surface-50/60 px-3 py-1.5">{footer}</div>}
    </section>
  );
}

/** Label + control + helper/error text. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className = '',
}: {
  label: string;
  htmlFor: string;
  /** Helper line under the control. A node, so it can carry a link or an action. */
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="block text-[12.5px] font-semibold text-surface-800">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1 flex items-center gap-1.5 text-[11.5px] font-medium text-critical-700">
          <AlertTriangle size={12} aria-hidden="true" />
          {error}
        </p>
      ) : (
        hint && (
          <div id={`${htmlFor}-hint`} className="mt-1 text-[11.5px] leading-[1.45] text-surface-500">
            {hint}
          </div>
        )
      )}
    </div>
  );
}

// 32px controls, matching the .btn-* height in index.css so an input and the button beside it are
// the same size. They were 44px against 36px buttons, which is what made every form row feel loose.
const controlBase =
  'w-full rounded-md border bg-surface-0 px-2.5 py-1.5 text-[12.5px] text-surface-900 outline-none transition-colors placeholder:text-surface-400 focus:ring-2 disabled:cursor-not-allowed disabled:bg-surface-50 disabled:text-surface-500';

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  type = 'text',
  invalid = false,
  disabled = false,
  prefix,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  invalid?: boolean;
  disabled?: boolean;
  prefix?: string;
  describedBy?: string;
}) {
  const [revealed, setRevealed] = useState(false);

  // Derived, never stored as a second source of truth: the caller still says `type="password"`,
  // and revealing only changes what this render hands to the DOM.
  const isPassword = type === 'password';
  const resolvedType = isPassword && revealed ? 'text' : type;

  const tone = invalid
    ? 'border-critical-300 focus:border-critical-500 focus:ring-critical-100'
    : 'border-surface-200 focus:border-brand-400 focus:ring-brand-100';

  if (prefix) {
    return (
      <div
        className={`flex items-stretch overflow-hidden rounded-md border transition-colors focus-within:ring-2 ${
          invalid
            ? 'border-critical-300 focus-within:border-critical-500 focus-within:ring-critical-100'
            : 'border-surface-200 focus-within:border-brand-400 focus-within:ring-brand-100'
        }`}
      >
        <span className="flex items-center border-r border-surface-200 bg-surface-50 px-2.5 font-mono text-[11.5px] text-surface-500">
          {prefix}
        </span>
        <input
          id={id}
          type={type}
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full bg-surface-0 px-2.5 py-1.5 text-[12.5px] text-surface-900 outline-none placeholder:text-surface-400"
        />
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        id={id}
        type={resolvedType}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        // Room for the reveal button, but only when there is one — a non-password field keeps its
        // full width rather than carrying a gap for a control it does not have.
        className={`${controlBase} ${tone} ${isPassword ? 'pr-9' : ''}`}
      />

      {/* THE FIELD STAYS type="password" UNTIL ASKED. Revealing is a per-field, per-visit choice
          that resets on every render of a fresh form — nothing here remembers it, so a password is
          never left on screen by a preference set on some earlier page.

          `tabIndex={-1}` keeps the toggle out of the tab order: someone tabbing from the password
          field expects to land on the submit button, not on a decorative control between them. It
          stays fully clickable, and screen readers still reach it. */}
      {isPassword && (
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => setRevealed((previous) => !previous)}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          aria-pressed={revealed}
          aria-controls={id}
          className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-surface-400 transition-colors hover:text-surface-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {revealed
            ? <EyeOff size={14} strokeWidth={2} aria-hidden="true" />
            : <Eye size={14} strokeWidth={2} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

export function SelectInput<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled = false,
  describedBy,
  labelFor,
}: {
  id: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  disabled?: boolean;
  describedBy?: string;
  /** How an option is shown, when that differs from the value stored — e.g. "PKR — Pakistani Rupee" for PKR. */
  labelFor?: (option: T) => string;
}) {
  // The stored value is always an option. A <select> whose value matches none of its options
  // silently SHOWS the first one — so a store in "Unspecified" read as "Pakistan", and a London
  // timezone as "Karachi", on a page presenting them as the merchant's real details.
  const choices = options.includes(value) ? options : [value, ...options];
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value as T)}
      className={`${controlBase} cursor-pointer border-surface-200 focus:border-brand-400 focus:ring-brand-100`}
    >
      {choices.map((option) => (
        <option key={option} value={option}>
          {labelFor ? labelFor(option) : option}
        </option>
      ))}
    </select>
  );
}

/** Toggle row: label, microcopy, switch. Microcopy is required. */
export function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className={`block text-[12.5px] font-semibold ${disabled ? 'text-surface-400' : 'text-surface-800'}`}>
          {label}
        </label>
        <p className="mt-0.5 max-w-xl text-[11.5px] leading-[1.4] text-surface-500">{description}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
          checked ? 'bg-brand-600' : 'bg-surface-300'
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-[18px] w-[18px] transform rounded-full bg-surface-0 shadow-sm transition-transform duration-200 motion-reduce:transition-none ${
            checked ? 'translate-x-[22px]' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

/** Read-only row for values Rankvora AI derives rather than accepts. */
export function ReadOnlyRow({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-surface-100 py-2 last:border-0">
      <div className="min-w-0">
        <p className="text-[12.5px] font-semibold text-surface-800">{label}</p>
        {hint && <p className="mt-0.5 text-[11.5px] text-surface-500">{hint}</p>}
      </div>
      <div className="text-[12.5px] text-surface-700">{value}</div>
    </div>
  );
}

/** Explains why a group is display-only in this build. */
export function PreviewNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-info-100 bg-info-50 px-2.5 py-2">
      <Info size={14} className="mt-px flex-shrink-0 text-info-700" aria-hidden="true" />
      <p className="text-[11px] leading-[1.4] text-info-800">{children}</p>
    </div>
  );
}

/** Sticky bar shown only while there are unsaved changes. */
export function SaveBar({
  visible,
  saving,
  onSave,
  onCancel,
  message = 'You have unsaved changes',
}: {
  visible: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  message?: string;
}) {
  if (!visible) return null;
  return (
    <div className="sticky bottom-4 z-20 mt-2" role="region" aria-label="Unsaved changes">
      <div className="flex flex-col gap-2 rounded-lg border border-surface-300 bg-surface-0/95 px-3 py-2 shadow-[0_16px_40px_-16px_rgba(15,23,42,0.35)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-[12.5px] font-semibold text-surface-800">
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-warning-500" aria-hidden="true" />
          {message}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Discard
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Transient success confirmation after a save. */
export function SavedToast({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(onDismiss, 3200);
    return () => window.clearTimeout(timer);
  }, [visible, onDismiss]);

  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 rounded-lg border border-success-100 bg-surface-0 px-3 py-2 shadow-[0_16px_40px_-16px_rgba(15,23,42,0.35)] motion-safe:animate-scale-in"
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success-50 text-success-700">
        <Check size={14} strokeWidth={2.6} aria-hidden="true" />
      </span>
      <p className="text-[12.5px] font-semibold text-surface-800">Settings saved</p>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-1 rounded p-1 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700"
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Destructive-action confirmation. Requires an explicit typed match. */
export function ConfirmDialog({
  open,
  title,
  description,
  impact,
  confirmLabel,
  confirmWord,
  typedValue,
  onTypedValueChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  impact: string[];
  confirmLabel: string;
  confirmWord: string;
  typedValue: string;
  onTypedValueChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onCancel]);

  if (!open) return null;
  const matches = typedValue.trim().toUpperCase() === confirmWord.toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center">
      {/* Deliberately NOT a surface token. A scrim's job is to darken whatever is behind it, in
          both themes — running it through the inverting ramp would turn it into a white wash over
          dark content, which lightens the page instead of dimming it. */}
      <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px]" onClick={onCancel} aria-hidden="true" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
        className="relative w-full max-w-md rounded-lg border border-surface-200 bg-surface-0 shadow-2xl motion-safe:animate-scale-in"
      >
        <div className="flex items-start gap-3 border-b border-surface-200 p-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-critical-50 text-critical-700">
            <AlertTriangle size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-[13px] font-bold text-surface-950">
              {title}
            </h2>
            <p id="confirm-description" className="mt-1 text-[12.5px] leading-[1.45] text-surface-600">
              {description}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1.5 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-3">
          <p className="text-[11.5px] font-bold uppercase tracking-wide text-surface-500">What happens</p>
          <ul className="mt-2 space-y-1.5">
            {impact.map((item) => (
              <li key={item} className="flex items-start gap-2 text-[12.5px] text-surface-700">
                <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-surface-400" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>

          <div className="mt-2.5">
            <label htmlFor="confirm-input" className="block text-[12.5px] font-semibold text-surface-800">
              Type <span className="font-mono text-critical-700">{confirmWord}</span> to confirm
            </label>
            <input
              id="confirm-input"
              value={typedValue}
              onChange={(event) => onTypedValueChange(event.target.value)}
              autoComplete="off"
              className="mt-1.5 w-full rounded-lg border border-surface-200 px-3 py-2.5 text-[12.5px] outline-none transition-colors focus:border-critical-400 focus:ring-2 focus:ring-critical-100"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-surface-200 bg-surface-50/60 p-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={!matches}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
