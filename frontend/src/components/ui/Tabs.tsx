import { useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * ─── Segmented tabs ──────────────────────────────────────────────────
 *
 * The one control behind every "All · Critical · High …" filter in the app. Five pages had drawn
 * the same inset track and raised segment by hand; none of them moved with the arrow keys, which
 * is what the WAI-ARIA tabs pattern asks of a `role="tablist"`.
 *
 * This keeps the look the pages already had and adds the keyboard behaviour:
 *   · only the selected tab is in the Tab order (roving tabindex); the arrows move between tabs;
 *   · ← / → step (and wrap), Home / End jump to the ends, and the tab that receives focus is
 *     selected — the filters are cheap to switch, so there is no separate "activate" step;
 *   · a disabled tab is skipped.
 *
 * Ported from the Replica mockup's `Tabs`, restyled with the app's theme tokens.
 */

export interface TabItem<Id extends string = string> {
  id: Id;
  label: ReactNode;
  /** Shown after the label. A number is formatted with thousands separators. */
  count?: number | string;
  /** A Tailwind background class for a small leading dot (e.g. a severity colour). */
  dotClass?: string;
  disabled?: boolean;
}

interface TabsProps<Id extends string> {
  tabs: readonly TabItem<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  /** Names the group for a screen reader: "Filter issues by severity". */
  label: string;
  /** `plain`: "Critical 3". `parens`: "Critical (3)". */
  countStyle?: 'plain' | 'parens';
  className?: string;
}

const track = 'inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-surface-200/70 bg-surface-50 p-0.5';

function formatCount(count: number | string): string {
  return typeof count === 'number' ? count.toLocaleString() : count;
}

export default function Tabs<Id extends string>({ tabs, active, onChange, label, countStyle = 'plain', className = '' }: TabsProps<Id>) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = tabs.filter((tab) => !tab.disabled);
  // If `active` names no tab (a filter that was removed), the first enabled one stays reachable.
  const tabbableId = enabled.some((tab) => tab.id === active) ? active : enabled[0]?.id;

  const move = (from: Id, key: string): boolean => {
    const index = enabled.findIndex((tab) => tab.id === from);
    if (index === -1 || enabled.length === 0) return false;
    let next: number;
    if (key === 'ArrowRight' || key === 'ArrowDown') next = (index + 1) % enabled.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (index - 1 + enabled.length) % enabled.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = enabled.length - 1;
    else return false;
    const target = enabled[next];
    onChange(target.id);
    refs.current.get(target.id)?.focus();
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: Id) => {
    if (move(id, event.key)) event.preventDefault();
  };

  return (
    <div className={`${track} ${className}`.trim()} role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const empty = tab.count === 0 || tab.count === '0';
        const tone = selected
          ? 'bg-surface-0 font-semibold text-surface-950 shadow-[0_1px_2px_var(--c-shadow-md)] ring-1 ring-surface-200'
          : empty
            ? 'text-surface-400 hover:text-surface-600'
            : 'text-surface-600 hover:text-surface-900';
        return (
          <button
            key={tab.id}
            ref={(element) => {
              if (element) refs.current.set(tab.id, element);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={tab.id === tabbableId ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, tab.id)}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
          >
            {tab.dotClass && <span className={`h-1.5 w-1.5 rounded-full ${tab.dotClass} ${empty ? 'opacity-40' : ''}`} aria-hidden="true" />}
            {tab.label}
            {tab.count !== undefined && (
              <span className={`tabular-nums ${selected ? 'text-surface-500' : 'text-surface-400'}`}>
                {countStyle === 'parens' ? `(${formatCount(tab.count)})` : formatCount(tab.count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
