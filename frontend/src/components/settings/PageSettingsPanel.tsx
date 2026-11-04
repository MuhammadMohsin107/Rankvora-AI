import { Check, ShieldCheck, X } from 'lucide-react';
import {
  Field,
  SelectInput,
  TextInput,
  ToggleRow,
  settingsCard,
} from './SettingsPrimitives';
import type {
  PageSettingField,
  PageSettingValue,
  PageSettingsDefinition,
} from '../../data/pageSettings.registry';

interface PageSettingsPanelProps {
  open: boolean;
  definition: PageSettingsDefinition;
  values: Record<string, PageSettingValue>;
  onClose: () => void;
  onChange: (key: string, value: PageSettingValue) => void;
  onReset: () => void;
  onSave: () => void;
  /**
   * A configuration surface belonging to one sub-pillar, rendered above the generic fields.
   *
   * Image Alt Text's template builder lives here rather than on the page. It is something a
   * merchant sets once and rarely revisits, so on the page it pushed the score, the findings and
   * the evidence table below the fold every single visit — while the panel is exactly where a
   * "set it and forget it" control belongs, next to Re-analyze.
   *
   * It owns its own save, so the footer's Save applies to the generic fields only.
   */
  children?: React.ReactNode;
}

function renderField(field: PageSettingField, value: PageSettingValue, onChange: (value: PageSettingValue) => void) {
  const sharedLabelText = (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-[12.5px] font-semibold text-surface-800">{field.label}</span>
      <span className="rounded border border-surface-200 bg-surface-50 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">
        {field.source}
      </span>
    </div>
  );

  if (field.type === 'toggle') {
    return (
      <div key={field.key} className="border-b border-surface-100 pb-2 last:border-b-0 last:pb-0">
        <ToggleRow
          id={field.key}
          label={field.label}
          description={field.description ?? 'Toggle the generated schema behavior for this page.'}
          checked={Boolean(value)}
          onChange={(next) => onChange(next)}
        />
        <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">
          <ShieldCheck size={10} />
          {field.source}
        </div>
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <Field key={field.key} label={field.label} htmlFor={field.key} hint={field.description} className="py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="rounded border border-surface-200 bg-surface-50 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">
            {field.source}
          </span>
        </div>
        <div className="mt-1.5">
          <SelectInput
            id={field.key}
            value={String(value ?? (field.options?.[0] ?? ''))}
            options={field.options ?? []}
            onChange={(next) => onChange(next)}
          />
        </div>
      </Field>
    );
  }

  const inputValue = typeof value === 'string' ? value : '';

  if (field.type === 'textarea') {
    return (
      <div key={field.key} className="py-2">
        {sharedLabelText}
        <textarea
          id={field.key}
          value={inputValue}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 min-h-[72px] w-full rounded-md border border-surface-200 bg-surface-0 px-2.5 py-1.5 text-[12.5px] text-surface-900 outline-none transition-colors placeholder:text-surface-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
        />
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-surface-500">
          <span>{field.description}</span>
          {typeof field.maxLength === 'number' && (
            <span className="tabular-nums">{inputValue.length}/{field.maxLength}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div key={field.key} className="py-2">
      {sharedLabelText}
      <TextInput
        id={field.key}
        type={field.type === 'url' ? 'url' : 'text'}
        value={inputValue}
        placeholder={field.placeholder}
        onChange={(next) => onChange(next)}
      />
      <p className="mt-1 text-[11.5px] leading-[1.45] text-surface-500">{field.description}</p>
    </div>
  );
}

export default function PageSettingsPanel({
  open,
  definition,
  values,
  onClose,
  onChange,
  onReset,
  onSave,
  children,
}: PageSettingsPanelProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <button type="button" className="absolute inset-0 bg-surface-950/25" onClick={onClose} aria-label="Close settings panel" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="page-settings-title"
        className="relative flex h-full w-full max-w-2xl flex-col border-l border-surface-200 bg-surface-0 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-surface-200 px-4 py-3">
          <div>
            {/* "Settings", not "Client settings": the merchant reading this panel IS the client,
                so the qualifier only ever described the audience to ourselves. Backend and
                database identifiers are unchanged — this is a label. */}
            <p className="eyebrow">Settings</p>
            <h2 id="page-settings-title" className="mt-0.5 text-[15px] font-semibold text-surface-950">{definition.title}</h2>
            <p className="mt-0.5 text-[11.5px] leading-[1.45] text-surface-500">{definition.description}</p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost h-7 w-7 min-h-0 p-0" aria-label="Close page settings">
            <X size={15} />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {children}
          {definition.sections.map((section) => (
            <section key={section.id} className={`${settingsCard} overflow-hidden`}>
              <div className="border-b border-surface-200 px-3 py-2">
                <h3 className="card-title">{section.title}</h3>
                {section.description && <p className="mt-0.5 text-[11.5px] leading-[1.45] text-surface-500">{section.description}</p>}
              </div>
              <div className="px-3 py-2">
                {section.fields.map((field) => renderField(field, values[field.key], (next) => onChange(field.key, next)))}
              </div>
            </section>
          ))}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-surface-200 bg-surface-50 px-4 py-2.5">
          <button type="button" onClick={onReset} className="btn-ghost btn-xs text-surface-600">
            Reset defaults
          </button>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={onClose} className="btn-secondary btn-xs">
              Cancel
            </button>
            <button type="button" onClick={onSave} className="btn-primary btn-xs">
              <Check size={12} />
              Save settings
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
