import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ActionButton,
  CheckCard,
  ChoiceCard,
  DetectedNote,
  FieldError,
  FormField,
  FormSection,
  MultiSelectChips,
  PriorityList,
  SelectField,
  StepHeader,
  StepRail,
  Stepper,
  SuggestionRow,
  TagInput,
  TextField,
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

describe('SelectField', () => {
  it('opens on its prompt, not on the first option', () => {
    render(<SelectField id="s" value="" options={['Canada', 'France']} placeholder="Add a market…" onChange={() => undefined} />);
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Add a market…' })).toBeInTheDocument();
  });

  it('reports the chosen option', () => {
    const onChange = vi.fn();
    render(<SelectField id="s" value="" options={['Canada', 'France']} placeholder="Add…" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'France' } });
    expect(onChange).toHaveBeenCalledWith('France');
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

  it('keeps an added suggestion on screen, marked as added and not clickable again', () => {
    render(<SuggestionRow label="Suggestions" suggestions={suggestions} selected={['Linen Shirt']} onAdd={() => undefined} />);
    expect(screen.getByRole('button', { name: 'linen shirt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'wool coat' })).toBeEnabled();
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

  it('says "In use" once applied, with no button', () => {
    render(<DetectedNote action={{ label: 'Use this', applied: true, onApply: () => undefined }}>Note</DetectedNote>);
    expect(screen.getByText('In use')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this' })).not.toBeInTheDocument();
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
