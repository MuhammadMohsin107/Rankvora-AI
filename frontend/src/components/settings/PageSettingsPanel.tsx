import { ShieldCheck } from 'lucide-react';
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
import Button from '../../components/polaris/Button';
import { TextAreaField } from '../polaris/fields';

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
  // Where this setting's value comes from. The field's own label is drawn by Polaris, so this row only
  // carries the source, above the field it describes.
  const sourceChip = (
    <div className="mb-1 flex justify-end">
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
        {sourceChip}
        <TextAreaField
          id={field.key}
          label={field.label}
          rows={3}
          value={inputValue}
          placeholder={field.placeholder}
          // A text area has no length limit of its own to lean on here, so the limit is held by cutting
          // anything past it; the count is shown with the field's description.
          onChange={(next) => onChange(typeof field.maxLength === 'number' ? next.slice(0, field.maxLength) : next)}
          details={[field.description, typeof field.maxLength === 'number' ? `${inputValue.length}/${field.maxLength}` : null].filter(Boolean).join(' · ')}
        />
      </div>
    );
  }

  return (
    <div key={field.key} className="py-2">
      {sourceChip}
      <Field label={field.label} htmlFor={field.key} hint={field.description}>
        <TextInput
          id={field.key}
          type={field.type === 'url' ? 'url' : 'text'}
          value={inputValue}
          placeholder={field.placeholder}
          onChange={(next) => onChange(next)}
        />
      </Field>
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
          <Button variant="ghost" icon="x" onClick={onClose} accessibilityLabel="Close page settings" />
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
          <Button variant="ghost" onClick={onReset}>
            Reset defaults
          </Button>
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSave}>
              
              Save settings
            </Button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
