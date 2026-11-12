import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { SelectField, SwitchField, TextField } from '../polaris/fields';

/** Card shell — matches Integrations / Reports exactly. */
export const settingsCard =
  'rounded-lg border border-surface-200 bg-surface-0 shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)]';

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

/** Toggle row: label and switch — Polaris's `<s-switch>`. A line of microcopy only where the label alone would mislead. */
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
  description?: string;
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
