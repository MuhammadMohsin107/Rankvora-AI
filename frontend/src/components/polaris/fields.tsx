import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

/**
 * ─── Form fields, drawn by Polaris ───────────────────────────────────
 *
 * Text fields, selects, switches, text areas and a search field — each a thin React wrapper
 * around a Polaris element (`<s-text-field>`, `<s-select>`, `<s-switch>`, …). Polaris draws the label, the
 * helper text and the error message itself, so a field is ONE element: pass `label`, `details` (helper
 * text) and `error` here and never draw them separately.
 *
 * They are CONTROLLED: `value` / `checked` in, `onChange(value)` out.
 *
 * HOW THE EVENTS ARE HEARD. Polaris announces a change with `input` (every keystroke) and `change` (when
 * the field is committed). React 19 wires `onChange` on a custom element in a way that can run the handler
 * twice for one change (tested), which is harmless for setting state and wrong for anything else. So each
 * listener is attached by hand, once, through a ref, and the handler is read through a ref so a new
 * function each render never re-attaches it. Typing is reported on `input`; a switch, checkbox or select
 * on `change`.
 */

function useElementEvent<T extends HTMLElement>(ref: RefObject<T | null>, event: string, handler: (element: T) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const listener = () => latest.current(element);
    element.addEventListener(event, listener);
    return () => element.removeEventListener(event, listener);
  }, [ref, event]);
}

interface FieldBase {
  label: string;
  /** Hide the label visually (it is still read aloud) — for a field whose purpose is clear from its place. */
  labelHidden?: boolean;
  /** Helper text under the field. A node, so it can carry a link. */
  details?: ReactNode;
  /** Shown in red under the field, and marks it invalid. */
  error?: string;
  disabled?: boolean;
  required?: boolean;
  /** Passed through as the field's id. */
  id?: string;
}

/** Helper text: a string goes in as the `details` property; a node goes in the `details` slot. */
function detailsProps(details: ReactNode) {
  return typeof details === 'string' ? { details } : {};
}
function detailsSlot(details: ReactNode) {
  return details && typeof details !== 'string' ? <span slot="details">{details}</span> : null;
}
/** The same slot, for the Polaris elements whose types do not list `children` (they accept them all the same). */
function slotted(details: ReactNode): Record<string, unknown> {
  return { children: detailsSlot(details) };
}

// ─── Text ────────────────────────────────────────────────────────────

export interface TextFieldProps extends FieldBase {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** "email" and "url" use Polaris's own fields for those, which check the shape as it is typed. */
  type?: 'text' | 'email' | 'url';
  prefix?: string;
  suffix?: string;
}

export function TextField({ label, labelHidden, details, error, disabled, required, id, value, onChange, placeholder, type = 'text', prefix, suffix }: TextFieldProps) {
  const ref = useRef<HTMLElementTagNameMap['s-text-field']>(null);
  useElementEvent(ref, 'input', (element) => onChange(element.value));
  const shared = {
    id,
    label,
    labelAccessibilityVisibility: labelHidden ? ('exclusive' as const) : ('visible' as const),
    error,
    disabled,
    required,
    value,
    placeholder,
    ...detailsProps(details),
  };
  if (type === 'email') {
    return <s-email-field ref={ref as never} {...shared} {...slotted(details)} />;
  }
  if (type === 'url') {
    return <s-url-field ref={ref as never} {...shared} {...slotted(details)} />;
  }
  return <s-text-field ref={ref} {...shared} prefix={prefix} suffix={suffix}>{detailsSlot(details)}</s-text-field>;
}

export interface TextAreaFieldProps extends FieldBase {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

export function TextAreaField({ label, labelHidden, details, error, disabled, required, id, value, onChange, placeholder, rows = 3 }: TextAreaFieldProps) {
  const ref = useRef<HTMLElementTagNameMap['s-text-area']>(null);
  useElementEvent(ref, 'input', (element) => onChange(element.value));
  return (
    <s-text-area
      ref={ref}
      id={id}
      label={label}
      labelAccessibilityVisibility={labelHidden ? 'exclusive' : 'visible'}
      error={error}
      disabled={disabled}
      required={required}
      value={value}
      placeholder={placeholder}
      rows={rows}
      {...detailsProps(details)}
      {...slotted(details)}
    />
  );
}

export function SearchField({ label, value, onChange, placeholder, disabled, id }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean; id?: string }) {
  const ref = useRef<HTMLElementTagNameMap['s-search-field']>(null);
  useElementEvent(ref, 'input', (element) => onChange(element.value));
  return <s-search-field ref={ref} id={id} label={label} labelAccessibilityVisibility="exclusive" value={value} placeholder={placeholder} disabled={disabled} />;
}

// ─── Choosing ────────────────────────────────────────────────────────

export interface SelectFieldProps<T extends string> extends FieldBase {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  /** How an option is shown, when that differs from the value stored — "PKR — Pakistani Rupee" for PKR. */
  optionLabel?: (option: T) => string;
  /** An option that is listed but cannot be chosen. */
  optionDisabled?: (option: T) => boolean;
}

export function SelectField<T extends string>({ label, labelHidden, details, error, disabled, required, id, value, options, onChange, optionLabel, optionDisabled }: SelectFieldProps<T>) {
  const ref = useRef<HTMLElementTagNameMap['s-select']>(null);
  useElementEvent(ref, 'change', (element) => onChange(element.value as T));
  // The stored value is always an option. A select whose value matches none of its options silently SHOWS
  // the first one — so a store in "Unspecified" read as "Pakistan" on a page presenting it as the merchant's
  // real details.
  const choices = options.includes(value) ? options : [value, ...options];
  return (
    <s-select
      ref={ref}
      id={id}
      label={label}
      labelAccessibilityVisibility={labelHidden ? 'exclusive' : 'visible'}
      error={error}
      disabled={disabled}
      required={required}
      value={value}
      {...detailsProps(details)}
    >
      {choices.map((option) => (
        <s-option key={option} value={option} selected={option === value} disabled={optionDisabled?.(option) ?? false}>
          {optionLabel ? optionLabel(option) : option}
        </s-option>
      ))}
      {detailsSlot(details)}
    </s-select>
  );
}

export interface SwitchFieldProps extends Omit<FieldBase, 'error' | 'required'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** An on/off setting. Polaris draws the label beside the switch, with `details` under it. */
export function SwitchField({ label, labelHidden, details, disabled, id, checked, onChange }: SwitchFieldProps) {
  const ref = useRef<HTMLElementTagNameMap['s-switch']>(null);
  useElementEvent(ref, 'change', (element) => onChange(element.checked));
  return (
    <s-switch
      ref={ref}
      id={id}
      label={label}
      labelAccessibilityVisibility={labelHidden ? 'exclusive' : 'visible'}
      disabled={disabled}
      checked={checked}
      {...detailsProps(details)}
      {...slotted(details)}
    />
  );
}
