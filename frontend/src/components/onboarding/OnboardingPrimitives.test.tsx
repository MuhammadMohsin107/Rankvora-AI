import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Search } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import {
  ActionButton,
  CheckCard,
  ChoiceCard,
  Combobox,
  DetectedNote,
  FactTile,
  FetchFailedNote,
  FieldError,
  FormField,
  FormSection,
  MultiCombobox,
  MultiSelectChips,
  PriorityList,
  SegmentedControl,
  StepHeader,
  StepRail,
  Stepper,
  SuggestionRow,
  TagInput,
  TextField,
  ToggleCard,
  furthestReachable,
  stepsOwed,
} from './OnboardingPrimitives';

const steps = (...states: Array<'complete' | 'pending'>) =>
  states.map((status, index) => ({
    step: index + 1,
    title: `Title ${index + 1}`,
    status,
    // The fourth step is the optional one, as in the real flow.
    optional: index === 3,
  }));

describe('furthestReachable / stepsOwed', () => {
  it('opens up to and including the first required step that is not answered', () => {
    expect(furthestReachable(1, steps('complete', 'pending', 'pending', 'pending', 'pending'))).toBe(2);
  });

  it('does not let an unanswered OPTIONAL step lock the steps after it', () => {
    expect(furthestReachable(1, steps('complete', 'complete', 'complete', 'pending', 'pending'))).toBe(5);
  });

  it('never goes behind the step the merchant is on', () => {
    expect(furthestReachable(4, steps('pending', 'pending', 'pending', 'pending', 'pending'))).toBe(4);
  });

  it('counts only required steps as owed', () => {
    expect(stepsOwed(steps('complete', 'complete', 'complete', 'pending', 'pending'))).toBe(1);
    expect(stepsOwed(steps('complete', 'complete', 'complete', 'pending', 'complete'))).toBe(0);
  });
});

describe('StepRail', () => {
  const rail = (current: number, list = steps('complete', 'pending', 'pending', 'pending', 'pending'), onJump = vi.fn()) => {
    render(<StepRail current={current} steps={list} onJump={onJump} />);
    return onJump;
  };

  it('marks the current step and states each step’s status in words', () => {
    rail(2);
    expect(screen.getByRole('button', { name: /Title 2/ })).toHaveAttribute('aria-current', 'step');
    expect(within(screen.getByRole('button', { name: /Title 1/ })).getByText('Complete')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Title 2/ })).getByText('In progress')).toBeInTheDocument();
  });

  it('says how many required steps are left', () => {
    rail(1);
    expect(screen.getByText('3 steps to go')).toBeInTheDocument();
  });

  it('reports a finished setup', () => {
    rail(5, steps('complete', 'complete', 'complete', 'complete', 'complete'));
    expect(screen.getByText('All steps complete')).toBeInTheDocument();
  });

  it('exposes progress as a progressbar', () => {
    rail(2);
    const bar = screen.getByRole('progressbar', { name: 'Setup progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '5');
  });

  it('lets the merchant jump back to an earlier step', () => {
    const onJump = rail(2);
    fireEvent.click(screen.getByRole('button', { name: /Title 1/ }));
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it('does not offer a step beyond the first unanswered required one', () => {
    const onJump = rail(1, steps('pending', 'pending', 'pending', 'pending', 'pending'));
    const locked = screen.getByRole('button', { name: /Title 3/ });
    expect(locked).toBeDisabled();
    fireEvent.click(locked);
    expect(onJump).not.toHaveBeenCalled();
  });

  it('does not re-open the step the merchant is already on', () => {
    const onJump = rail(1);
    fireEvent.click(screen.getByRole('button', { name: /Title 1/ }));
    expect(onJump).not.toHaveBeenCalled();
  });
});

describe('Stepper (narrow screens)', () => {
  it('gives every segment a full-sentence name', () => {
    render(<Stepper current={1} steps={steps('pending', 'pending', 'pending', 'pending', 'pending')} onJump={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Step 1: Title 1 — Not answered yet' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Step 4: Title 4 — Optional' })).toBeDisabled();
  });
});

describe('StepHeader', () => {
  it('names the step, its place in the sequence and why it is asked', () => {
    render(<StepHeader step={4} total={5} title="Measurement" purpose="Optional — your first analysis runs without it." />);
    expect(screen.getByRole('heading', { level: 1, name: 'Measurement' })).toBeInTheDocument();
    expect(screen.getByText('Step 4 of 5')).toBeInTheDocument();
    expect(screen.getByText(/runs without it/)).toBeInTheDocument();
  });
});

describe('ActionButton', () => {
  it('runs its action', () => {
    const onClick = vi.fn();
    render(<ActionButton onClick={onClick}>Continue</ActionButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ignores presses while loading, and says it is busy', () => {
    const onClick = vi.fn();
    render(<ActionButton onClick={onClick} loading>Saving…</ActionButton>);
    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('can be disabled', () => {
    render(<ActionButton onClick={() => undefined} disabled>Back</ActionButton>);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });
});

describe('FormField', () => {
  it('ties the label to the control and shows Required / Optional in words', () => {
    render(
      <>
        <FormField label="Store name" htmlFor="x" badge="required"><TextField id="x" value="" onChange={() => undefined} /></FormField>
        <FormField label="Domain" htmlFor="y" badge="optional"><TextField id="y" value="" onChange={() => undefined} /></FormField>
      </>,
    );
    expect(screen.getByLabelText('Store name')).toBe(document.getElementById('x'));
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
  });

  it('puts the error beside the field, announced, and named by the control', () => {
    render(
      <FormField label="Store name" htmlFor="x" badge="required" error="Confirm the store name.">
        <TextField id="x" value="" invalid onChange={() => undefined} />
      </FormField>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Confirm the store name.');
    expect(alert).toHaveAttribute('id', 'x-error');
    const input = screen.getByLabelText('Store name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('x-error');
  });

  it('is not marked invalid until there is something wrong', () => {
    render(<FormField label="A" htmlFor="a"><TextField id="a" value="" onChange={() => undefined} /></FormField>);
    expect(screen.getByLabelText('A')).not.toHaveAttribute('aria-invalid');
  });
});

describe('FormSection', () => {
  it('is a named group and flags itself when its required choice is missing', () => {
    render(<FormSection title="Industry" badge="required" error="Choose one."><span>chips</span></FormSection>);
    const group = screen.getByRole('group', { name: 'Industry' });
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Choose one.');
  });
});

describe('FieldError', () => {
  it('is an alert', () => {
    render(<FieldError>Something is missing.</FieldError>);
    expect(screen.getByRole('alert')).toHaveTextContent('Something is missing.');
  });
});

describe('ChoiceCard / CheckCard', () => {
  it('a choice card is a radio that reports its value', () => {
    const onSelect = vi.fn();
    render(<ChoiceCard name="consent" value="ask" selected={false} label="Review every change" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('radio', { name: /Review every change/ }));
    expect(onSelect).toHaveBeenCalledWith('ask');
  });

  it('a choice card shows its selected state to assistive tech', () => {
    render(<ChoiceCard name="consent" value="ask" selected label="Review every change" onSelect={() => undefined} />);
    expect(screen.getByRole('radio', { name: /Review every change/ })).toBeChecked();
  });

  it('a check card toggles and keeps its description', () => {
    const onToggle = vi.fn();
    render(<CheckCard id="c" checked={false} label="English" description="Primary · Published" onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /English/ }));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.getByText('Primary · Published')).toBeInTheDocument();
  });
});

describe('MultiSelectChips', () => {
  function Harness({ invalid = false }: { invalid?: boolean }) {
    const [selected, setSelected] = useState<string[]>(['Apparel']);
    return (
      <MultiSelectChips
        label="Industry"
        options={['Apparel', 'Home', 'Beauty']}
        selected={selected}
        invalid={invalid}
        onToggle={(value) => setSelected((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]))}
      />
    );
  }

  it('shows every option and which are chosen', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Apparel' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('allows more than one answer, and removing one', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByRole('button', { name: 'Apparel' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Apparel' }));
    expect(screen.getByRole('button', { name: 'Apparel' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('flags the group when the required choice is missing', () => {
    render(<Harness invalid />);
    expect(screen.getByRole('group', { name: 'Industry' })).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('TagInput', () => {
  function Harness({ max = 3, transform }: { max?: number; transform?: (raw: string) => string | null }) {
    const [values, setValues] = useState<string[]>([]);
    return <TagInput id="tags" values={values} onChange={setValues} placeholder="Type a keyword" max={max} transform={transform} />;
  }
  const type = (text: string, key = 'Enter') => {
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key });
  };

  it('adds an entry on Enter and lists it with a remove button', () => {
    render(<Harness />);
    type('linen shirt');
    expect(screen.getByText('linen shirt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove linen shirt' })).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('adds on a comma too', () => {
    render(<Harness />);
    type('wool coat', ',');
    expect(screen.getByText('wool coat')).toBeInTheDocument();
  });

  it('refuses a duplicate, case-insensitively, and says so', () => {
    render(<Harness />);
    type('Linen');
    type('linen');
    expect(screen.getAllByText(/linen/i)).toHaveLength(1);
    expect(screen.getByText('Already in the list.')).toBeInTheDocument();
  });

  it('stops at the maximum and says so', () => {
    render(<Harness max={1} />);
    type('one');
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByPlaceholderText('Maximum of 1 reached')).toBeInTheDocument();
  });

  it('removes an entry', () => {
    render(<Harness />);
    type('one');
    fireEvent.click(screen.getByRole('button', { name: 'Remove one' }));
    expect(screen.queryByText('one')).not.toBeInTheDocument();
  });

  it('removes the last entry on Backspace in an empty field', () => {
    render(<Harness />);
    type('one');
    type('two');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' });
    expect(screen.queryByText('two')).not.toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
  });

  it('uses the caller’s transform and rejects what it rejects', () => {
    render(<Harness transform={(raw) => (raw.trim().length >= 3 ? raw.trim().toLowerCase() : null)} />);
    type('ab');
    expect(screen.getByText("That doesn't look like a valid entry.")).toBeInTheDocument();
    type('ABC');
    expect(screen.getByText('abc')).toBeInTheDocument();
  });
});

describe('SuggestionRow', () => {
  const suggestions = [{ value: 'linen shirt', hint: 'From your collections' }, { value: 'wool coat', hint: 'From your products' }];

  it('adds a suggestion with one click', () => {
    const onAdd = vi.fn();
    render(<SuggestionRow label="Suggestions" suggestions={suggestions} selected={[]} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: 'linen shirt' }));
    expect(onAdd).toHaveBeenCalledWith('linen shirt');
  });

  it('removes a suggestion once it has been added, and leaves the rest on offer', () => {
    render(<SuggestionRow label="Suggestions" suggestions={suggestions} selected={['Linen Shirt']} onAdd={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'linen shirt' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'wool coat' })).toBeEnabled();
  });

  it('removes the whole row when every suggestion has been added', () => {
    const { container } = render(
      <SuggestionRow label="Suggestions" suggestions={suggestions} selected={['linen shirt', 'WOOL COAT']} onAdd={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('puts a suggestion back when its term is taken out of the field', () => {
    const { rerender } = render(<SuggestionRow label="Suggestions" suggestions={suggestions} selected={['linen shirt']} onAdd={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'linen shirt' })).not.toBeInTheDocument();
    rerender(<SuggestionRow label="Suggestions" suggestions={suggestions} selected={[]} onAdd={() => undefined} />);
    expect(screen.getByRole('button', { name: 'linen shirt' })).toBeInTheDocument();
  });

  it('renders nothing when there is nothing to suggest', () => {
    const { container } = render(<SuggestionRow label="Suggestions" suggestions={[]} selected={[]} onAdd={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DetectedNote', () => {
  it('offers the value as a one-click answer, never filling it in itself', () => {
    const onApply = vi.fn();
    render(<DetectedNote action={{ label: 'Use this', applied: false, onApply }}>Your Shopify store name is “Northline”.</DetectedNote>);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('removes itself once the suggestion has been used', () => {
    const { container } = render(
      <DetectedNote action={{ label: 'Use this', applied: true, onApply: () => undefined }}>Your Shopify store name is “Northline”.</DetectedNote>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('In use')).not.toBeInTheDocument();
  });

  it('comes back if the field is changed to something else', () => {
    const action = (applied: boolean) => ({ label: 'Use this', applied, onApply: () => undefined });
    const { rerender } = render(<DetectedNote action={action(true)}>Your Shopify store name is “Northline”.</DetectedNote>);
    expect(screen.queryByRole('button', { name: 'Use this' })).not.toBeInTheDocument();
    rerender(<DetectedNote action={action(false)}>Your Shopify store name is “Northline”.</DetectedNote>);
    expect(screen.getByRole('button', { name: 'Use this' })).toBeInTheDocument();
  });

  it('keeps a purely informational note (no action) on screen', () => {
    render(<DetectedNote>Shopify did not return a primary domain for this store.</DetectedNote>);
    expect(screen.getByText('Shopify did not return a primary domain for this store.')).toBeInTheDocument();
  });
});

describe('PriorityList', () => {
  const items = [{ key: 'seo', label: 'Search visibility' }, { key: 'content', label: 'Content' }, { key: 'speed', label: 'Performance' }];

  it('moves an item up and down by key', () => {
    const onReorder = vi.fn();
    render(<PriorityList items={items} onReorder={onReorder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move Content up' }));
    expect(onReorder).toHaveBeenLastCalledWith(['content', 'seo', 'speed']);
    fireEvent.click(screen.getByRole('button', { name: 'Move Content down' }));
    expect(onReorder).toHaveBeenLastCalledWith(['seo', 'speed', 'content']);
  });

  it('cannot move the first item up or the last item down', () => {
    render(<PriorityList items={items} onReorder={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Move Search visibility up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Performance down' })).toBeDisabled();
  });
});

describe('CheckCard rank', () => {
  it('shows where a chosen tile stands in an order, on the tile itself', () => {
    render(<CheckCard id="c" checked label="Search visibility" icon={Search} rank={2} onToggle={() => undefined} />);
    const tile = screen.getByRole('checkbox', { name: /Search visibility/ }).closest('label') as HTMLElement;
    expect(within(tile).getByText('2')).toBeInTheDocument();
  });

  it('shows no number when there is no order to show', () => {
    render(<CheckCard id="c" checked label="Search visibility" icon={Search} onToggle={() => undefined} />);
    const tile = screen.getByRole('checkbox', { name: /Search visibility/ }).closest('label') as HTMLElement;
    expect(within(tile).queryByText(/^\d$/)).not.toBeInTheDocument();
  });

  it('does not let the number change the tile’s accessible name', () => {
    render(<CheckCard id="c" checked label="Search visibility" icon={Search} rank={1} onToggle={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: 'Search visibility' })).toBeInTheDocument();
  });
});

describe('ToggleCard', () => {
  it('is a switch that reports on and off', () => {
    const onToggle = vi.fn();
    render(<ToggleCard id="t" checked={false} label="Re-analyze automatically" onToggle={onToggle} />);
    const control = screen.getByRole('switch', { name: /Re-analyze automatically/ });
    expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(control);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('shows its state, and its description', () => {
    render(<ToggleCard id="t" checked label="Re-analyze automatically" description="Runs on the schedule below." onToggle={() => undefined} />);
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Runs on the schedule below.')).toBeInTheDocument();
  });
});

describe('PriorityList wrapping and marks', () => {
  it('keeps a long name whole instead of cutting it off', () => {
    const long = 'Product & collection content';
    render(<PriorityList items={[{ key: 'content', label: long, icon: Search }]} onReorder={() => undefined} />);
    const name = screen.getByText(long);
    expect(name.className).not.toMatch(/truncate/);
  });
});

// ─── Searchable pickers ──────────────────────────────────────────────

const COUNTRIES = [
  { value: 'ca', label: 'Canada' },
  { value: 'mx', label: 'Mexico' },
  { value: 'us', label: 'United States' },
  { value: 'gb', label: 'United Kingdom' },
];

function Picker({ initial = '', onChange }: { initial?: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Combobox
      id="pick"
      value={value}
      options={COUNTRIES}
      placeholder="Pick a country"
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const box = () => screen.getByRole('combobox');
const optionNames = () => screen.queryAllByRole('option').map((option) => option.textContent);

describe('Combobox', () => {
  it('starts closed, on its prompt', () => {
    render(<Picker />);
    expect(box()).toHaveAttribute('aria-expanded', 'false');
    expect(box()).toHaveAttribute('placeholder', 'Pick a country');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on focus and offers every option', () => {
    render(<Picker />);
    fireEvent.focus(box());
    expect(box()).toHaveAttribute('aria-expanded', 'true');
    expect(optionNames()).toEqual(['Canada', 'Mexico', 'United States', 'United Kingdom']);
  });

  it('narrows the list as the merchant types', () => {
    render(<Picker />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'united' } });
    expect(optionNames()).toEqual(['United States', 'United Kingdom']);
  });

  it('lists matches that START with what was typed ahead of those that merely contain it', () => {
    render(<Combobox id="r" value="" options={[{ value: 'm', label: 'Mexican food' }, { value: 'c', label: 'Canada' }]} placeholder="x" onChange={() => undefined} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'can' } });
    expect(optionNames()).toEqual(['Canada', 'Mexican food']);
  });

  it('says so when nothing matches', () => {
    render(<Picker />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('chooses the highlighted option with Enter, and then shows it by name', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'mex' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('mx');
    expect(box()).toHaveValue('Mexico');
    expect(box()).toHaveAttribute('aria-expanded', 'false');
  });

  it('moves the highlight with the arrow keys, and announces it', () => {
    render(<Picker />);
    fireEvent.focus(box());
    const first = box().getAttribute('aria-activedescendant');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    const second = box().getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    expect(document.getElementById(second as string)).toHaveTextContent('Mexico');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().getAttribute('aria-activedescendant')).toBe(first);
  });

  it('never moves the highlight past either end of the list', () => {
    render(<Picker />);
    fireEvent.focus(box());
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(document.getElementById(box().getAttribute('aria-activedescendant') as string)).toHaveTextContent('United Kingdom');
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(document.getElementById(box().getAttribute('aria-activedescendant') as string)).toHaveTextContent('Canada');
  });

  it('chooses with the mouse', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.focus(box());
    fireEvent.mouseDown(screen.getByRole('option', { name: 'United States' }));
    expect(onChange).toHaveBeenCalledWith('us');
  });

  it('closes on Escape without changing the answer', () => {
    const onChange = vi.fn();
    render(<Picker initial="ca" onChange={onChange} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'mex' } });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(box()).toHaveValue('Canada');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes when the field loses focus', () => {
    render(<Picker />);
    fireEvent.focus(box());
    fireEvent.blur(box());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps the current answer in view while open, as the placeholder, and marks it selected', () => {
    render(<Picker initial="mx" />);
    fireEvent.focus(box());
    expect(box()).toHaveAttribute('placeholder', 'Mexico');
    expect(screen.getByRole('option', { name: 'Mexico' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Canada' })).toHaveAttribute('aria-selected', 'false');
  });

  it('wires the field to its list for assistive technology', () => {
    render(<Picker />);
    fireEvent.focus(box());
    expect(screen.getByRole('listbox')).toHaveAttribute('id', box().getAttribute('aria-controls') as string);
    expect(box()).toHaveAttribute('aria-autocomplete', 'list');
  });

  it('does not open when it is disabled', () => {
    render(<Combobox id="d" value="" options={COUNTRIES} placeholder="x" disabled onChange={() => undefined} />);
    expect(box()).toBeDisabled();
    fireEvent.focus(box());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('can be an "add one" field: choosing reports the value and the field goes back to its prompt', () => {
    const onChange = vi.fn();
    render(<Combobox id="a" value="" options={COUNTRIES} placeholder="Add a country…" onChange={onChange} />);
    fireEvent.focus(box());
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('ca');
    expect(box()).toHaveValue('');
    expect(box()).toHaveAttribute('placeholder', 'Add a country…');
  });

  it('can offer a "no choice" option whose value is empty', () => {
    const onChange = vi.fn();
    render(<Combobox id="h" value="3" options={[{ value: '', label: 'Any time' }, { value: '3', label: '03:00' }]} placeholder="x" onChange={onChange} />);
    expect(box()).toHaveValue('03:00');
    fireEvent.focus(box());
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Any time' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('draws a long list in part and says how many more there are', () => {
    const many = Array.from({ length: 130 }, (_, index) => ({ value: String(index), label: `Item ${index}` }));
    render(<Combobox id="m" value="" options={many} placeholder="x" onChange={() => undefined} />);
    fireEvent.focus(box());
    expect(screen.getAllByRole('option')).toHaveLength(100);
    expect(screen.getByText('30 more — keep typing to narrow the list')).toBeInTheDocument();
  });

  it('marks a missing answer', () => {
    render(<Combobox id="i" value="" options={COUNTRIES} placeholder="x" invalid onChange={() => undefined} />);
    expect(box()).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('MultiCombobox', () => {
  function Markets({ start = [], max, onAdd, onRemove }: { start?: string[]; max?: number; onAdd?: (v: string) => void; onRemove?: (v: string) => void }) {
    const [values, setValues] = useState<string[]>(start);
    return (
      <MultiCombobox
        id="markets"
        values={values}
        options={['Canada', 'Mexico', 'United States']}
        placeholder="Search for a country…"
        max={max}
        onAdd={(value) => {
          setValues((current) => [...current, value]);
          onAdd?.(value);
        }}
        onRemove={(value) => {
          setValues((current) => current.filter((entry) => entry !== value));
          onRemove?.(value);
        }}
      />
    );
  }

  it('adds the highlighted option as a chip inside the field', () => {
    const onAdd = vi.fn();
    render(<Markets onAdd={onAdd} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'mex' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('Mexico');
    expect(screen.getByRole('button', { name: 'Remove Mexico' })).toBeInTheDocument();
    expect(box()).toHaveValue('');
  });

  it('does not offer a choice that has already been made', () => {
    render(<Markets start={['canada']} />);
    fireEvent.focus(box());
    expect(optionNames()).toEqual(['Mexico', 'United States']);
  });

  it('takes the last choice back with Backspace on an empty field', () => {
    const onRemove = vi.fn();
    render(<Markets start={['Canada', 'Mexico']} onRemove={onRemove} />);
    fireEvent.keyDown(box(), { key: 'Backspace' });
    expect(onRemove).toHaveBeenCalledWith('Mexico');
  });

  it('leaves the chips alone on Backspace while something is being typed', () => {
    const onRemove = vi.fn();
    render(<Markets start={['Canada']} onRemove={onRemove} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'x' } });
    fireEvent.keyDown(box(), { key: 'Backspace' });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('removes a choice from its chip', () => {
    const onRemove = vi.fn();
    render(<Markets start={['Canada']} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Canada' }));
    expect(onRemove).toHaveBeenCalledWith('Canada');
  });

  it('stops at the maximum and says so', () => {
    render(<Markets start={['Canada']} max={1} />);
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute('placeholder', 'Maximum of 1 reached');
  });

  it('offers nothing to add once every option is chosen', () => {
    render(<Markets start={['Canada', 'Mexico', 'United States']} />);
    fireEvent.focus(box());
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
});

describe('SegmentedControl', () => {
  const OPTIONS = [{ value: 'Daily', label: 'Daily' }, { value: 'Weekly', label: 'Weekly' }, { value: 'Monthly', label: 'Monthly' }];
  function Frequency({ initial = 'Weekly', onChange }: { initial?: string; onChange?: (v: string) => void }) {
    const [value, setValue] = useState(initial);
    return <SegmentedControl label="How often" options={OPTIONS} value={value} onChange={(v) => { setValue(v); onChange?.(v); }} />;
  }
  const radio = (name: string) => screen.getByRole('radio', { name });

  it('is one named radio group with the current choice checked', () => {
    render(<Frequency />);
    expect(screen.getByRole('radiogroup', { name: 'How often' })).toBeInTheDocument();
    expect(radio('Weekly')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Daily')).toHaveAttribute('aria-checked', 'false');
  });

  it('shows every option at once and picks with one press', () => {
    const onChange = vi.fn();
    render(<Frequency onChange={onChange} />);
    fireEvent.click(radio('Monthly'));
    expect(onChange).toHaveBeenCalledWith('Monthly');
    expect(radio('Monthly')).toHaveAttribute('aria-checked', 'true');
  });

  it('puts only the chosen option in the tab order', () => {
    render(<Frequency />);
    expect(radio('Weekly')).toHaveAttribute('tabindex', '0');
    expect(radio('Daily')).toHaveAttribute('tabindex', '-1');
  });

  it('keeps the group reachable when nothing is chosen yet', () => {
    render(<SegmentedControl label="x" options={OPTIONS} value="" onChange={() => undefined} />);
    expect(radio('Daily')).toHaveAttribute('tabindex', '0');
    expect(radio('Weekly')).toHaveAttribute('tabindex', '-1');
  });

  it('moves the choice with the arrow keys, wrapping at the ends', () => {
    render(<Frequency initial="Monthly" />);
    fireEvent.keyDown(radio('Monthly'), { key: 'ArrowRight' });
    expect(radio('Daily')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Daily')).toHaveFocus();
    fireEvent.keyDown(radio('Daily'), { key: 'ArrowLeft' });
    expect(radio('Monthly')).toHaveAttribute('aria-checked', 'true');
  });

  it('jumps to the ends with Home and End', () => {
    render(<Frequency />);
    fireEvent.keyDown(radio('Weekly'), { key: 'End' });
    expect(radio('Monthly')).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radio('Monthly'), { key: 'Home' });
    expect(radio('Daily')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('FetchFailedNote', () => {
  it('says what failed, that setup can go on, and offers to try again', () => {
    const onRetry = vi.fn();
    render(<FetchFailedNote onRetry={onRetry} retrying={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load your store.s details/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/still fill everything in yourself/i);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows that it is trying, and cannot be pressed again meanwhile', () => {
    const onRetry = vi.fn();
    render(<FetchFailedNote onRetry={onRetry} retrying />);
    const button = screen.getByRole('button', { name: 'Trying again…' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('Limits on what can be typed', () => {
  it('stops a text field at the length the server accepts', () => {
    render(<TextField id="n" value="" onChange={() => undefined} maxLength={255} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('maxlength', '255');
  });

  it('refuses a tag entry longer than the server accepts, with a note, and adds nothing', () => {
    const onChange = vi.fn();
    render(<TagInput id="k" values={[]} onChange={onChange} placeholder="Type" max={10} maxItemLength={5} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'toolong' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Keep each entry to 5 characters or fewer.')).toBeInTheDocument();
  });

  it('accepts an entry exactly at the limit', () => {
    const onChange = vi.fn();
    render(<TagInput id="k" values={[]} onChange={onChange} placeholder="Type" max={10} maxItemLength={5} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'exact' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['exact']);
  });
});

describe('FactTile', () => {
  it('shows a fact', () => {
    render(<FactTile label="Currency" value="CAD" />);
    expect(screen.getByText('CAD')).toBeInTheDocument();
  });

  it('says Shopify did not report a missing fact, by default', () => {
    render(<FactTile label="Pages" value={null} />);
    expect(screen.getByText('Not reported by Shopify')).toBeInTheDocument();
  });

  it('says what it is told to when the reason is something else', () => {
    render(<FactTile label="Pages" value={null} missing="Couldn’t be loaded" />);
    expect(screen.getByText('Couldn’t be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Not reported by Shopify')).not.toBeInTheDocument();
  });
});
