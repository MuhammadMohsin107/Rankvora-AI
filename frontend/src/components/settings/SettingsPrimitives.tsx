import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import Banner from '../polaris/Banner';
import { SelectField, SwitchField, TextField } from '../polaris/fields';
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

/**
 * What a field tells the control inside it: the label, the helper text and the error. Polaris draws all
 * three itself, as part of the field element, so `Field` no longer draws any markup of its own — it only
 * hands them down to the TextInput / SelectInput placed inside it.
 */
const FieldContext = createContext<{ label: string; error?: string; hint?: ReactNode } | null>(null);

function useFieldContext(control: string) {
  const field = useContext(FieldContext);
  if (!field) throw new Error(`${control} must be placed inside a Field, which gives it its label.`);
  return field;
}

/** Label + control + helper/error text: the label, hint and error shown by the TextInput or SelectInput inside. */
export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: string;
  /** The id of the control inside. Kept so call sites read the same; Polaris links label and control itself. */
  htmlFor?: string;
  /** Helper line under the control. A node, so it can carry a link or an action. */
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  const value = useMemo(() => ({ label, error, hint }), [label, error, hint]);
  return (
    <FieldContext.Provider value={value}>
      <div className={className}>{children}</div>
    </FieldContext.Provider>
  );
}

/** A text field — Polaris's `<s-text-field>` (or its email / url variant), labelled by the Field around it. */
export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled = false,
  prefix,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  /** Kept so call sites read the same: the Field's `error` is what marks the field invalid. */
  invalid?: boolean;
  disabled?: boolean;
  prefix?: string;
  describedBy?: string;
}) {
  const { label, error, hint } = useFieldContext('TextInput');
  return (
    <TextField
      id={id}
      label={label}
      details={hint}
      error={error}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      type={type === 'email' || type === 'url' ? type : 'text'}
      disabled={disabled}
      prefix={prefix}
    />
  );
}

/** A choice from a list — Polaris's `<s-select>`, labelled by the Field around it. */
export function SelectInput<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled = false,
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
  const { label, error, hint } = useFieldContext('SelectInput');
  return <SelectField id={id} label={label} details={hint} error={error} value={value} options={options} onChange={onChange} disabled={disabled} optionLabel={labelFor} />;
}

/** Toggle row: label, microcopy, switch — Polaris's `<s-switch>`. Microcopy is required. */
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
    <div className="py-2">
      <SwitchField id={id} label={label} details={description} checked={checked} onChange={onChange} disabled={disabled} />
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
    <Banner tone="info">
      <s-text>{children}</s-text>
    </Banner>
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
