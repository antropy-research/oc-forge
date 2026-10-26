// Linear's command-style menus: a search field over a list of choices, worked
// from the keyboard (type to narrow, ↑/↓ to move, Enter to pick, Esc to close,
// Backspace on an empty field to go back), with ticks for several choices.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { searchChoices } from '../../../src/domain/linearFilter.ts';

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  icon?: ComponentChildren;
  /** A heading the option sits under; options of one group must be next to each other. */
  group?: string;
  /** Kept out of the search: always shown (such as "Before a date…"). */
  sticky?: boolean;
}

let nextId = 0;

/**
 * Close a popover on a press outside it, or Escape inside it. A press on the
 * control that opened it (in the same `.lin-anchor`) is left to that control.
 */
export const useDismiss = (root: { current: HTMLElement | null }, onClose: () => void): void => {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      const anchor = root.current?.closest('.lin-anchor');
      if (root.current?.contains(target) || (anchor && anchor.contains(target))) return;
      closeRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !root.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('mousedown', outside, true);
    root.current?.addEventListener('keydown', escape);
    const element = root.current;
    return () => {
      document.removeEventListener('mousedown', outside, true);
      element?.removeEventListener('keydown', escape);
    };
  }, []);
};

export const Picker = ({
  label,
  placeholder,
  options,
  selected = [],
  multi = false,
  onPick,
  onClose,
  onBack,
  onSearch,
  footer,
  class: className = '',
  initialTerm = '',
  empty = 'No matches',
}: {
  /** The menu's name, such as "Change status". */
  label: string;
  placeholder?: string;
  options: PickerOption[];
  selected?: readonly string[];
  multi?: boolean;
  onPick: (option: PickerOption) => void;
  onClose: () => void;
  /** Backspace in an empty field: back to the menu before. */
  onBack?: () => void;
  /** The search as typed, for menus that add choices from it. */
  onSearch?: (term: string) => void;
  footer?: ComponentChildren;
  class?: string;
  initialTerm?: string;
  empty?: string;
}) => {
  const [term, setTerm] = useState(initialTerm);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useMemo(() => `lin-picker-${++nextId}`, []);
  const shown = useMemo(() => {
    const sticky = options.filter((option) => option.sticky);
    return [...searchChoices(options.filter((option) => !option.sticky), term), ...sticky];
  }, [options, term]);
  const chosen = new Set(selected);

  useDismiss(root, onClose);
  // Before the next key arrives: what is typed right after the menu opens goes into it.
  useLayoutEffect(() => input.current?.focus(), []);

  useEffect(() => setActive((current) => Math.min(current, Math.max(0, shown.length - 1))), [shown.length]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (option: PickerOption | undefined) => {
    if (option) onPick(option);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current) => (shown.length ? (current + 1) % shown.length : 0));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current) => (shown.length ? (current - 1 + shown.length) % shown.length : 0));
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(Math.max(0, shown.length - 1));
        break;
      case 'Enter':
        event.preventDefault();
        pick(shown[active]);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case 'Backspace':
        if (!term && onBack) {
          event.preventDefault();
          onBack();
        }
        break;
      case 'Tab':
        onClose();
        break;
      default:
        return;
    }
  };

  let lastGroup: string | undefined;
  return (
    <div class={`lin-popover ${className}`.trim()} ref={root} role="dialog" aria-label={label} onKeyDown={(event) => event.stopPropagation()}>
      <input
        ref={input}
        class="lin-popover-search"
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
        aria-label={placeholder ?? label}
        placeholder={placeholder ?? `${label}…`}
        value={term}
        onInput={(event) => {
          const next = event.currentTarget.value;
          setTerm(next);
          setActive(0);
          onSearch?.(next);
        }}
        onKeyDown={onKeyDown}
      />
      <ul class="lin-popover-list" role="listbox" id={`${id}-list`} aria-label={label} aria-multiselectable={multi || undefined} ref={list}>
        {shown.map((option, index) => {
          const heading = option.group && option.group !== lastGroup ? option.group : null;
          lastGroup = option.group;
          const isOn = chosen.has(option.value);
          return [
            heading ? <li key={`g:${heading}`} class="lin-popover-group" role="presentation">{heading}</li> : null,
            <li
              key={`${option.group ?? ''}:${option.value}`}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              aria-selected={isOn}
              class={`lin-option${index === active ? ' is-active' : ''}${isOn ? ' is-on' : ''}`}
              onMouseMove={() => index !== active && setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(option)}
            >
              {multi && <span class={`lin-check${isOn ? ' is-on' : ''}`} aria-hidden="true">{isOn ? '✓' : ''}</span>}
              {option.icon && <span class="lin-option-icon">{option.icon}</span>}
              <span class="lin-option-label">{option.label}</span>
              {option.hint && <span class="lin-option-hint">{option.hint}</span>}
              {!multi && isOn && <span class="lin-option-tick" aria-hidden="true">✓</span>}
            </li>,
          ];
        })}
        {shown.length === 0 && <li class="lin-popover-empty" role="presentation">{empty}</li>}
      </ul>
      {footer && <div class="lin-popover-footer">{footer}</div>}
    </div>
  );
};

/** A button that shows a value and opens a picker of choices for it, as Linear's display menu does. */
export const PickerButton = ({
  label,
  value,
  icon,
  open,
  onOpen,
  children,
  class: className = '',
}: {
  /** What it sets, such as "Grouping"; the button's name is "Grouping: Status". */
  label: string;
  value: string;
  icon?: ComponentChildren;
  open: boolean;
  onOpen: () => void;
  children?: ComponentChildren;
  class?: string;
}) => (
  <span class={`lin-anchor ${className}`.trim()}>
    <button type="button" class="lin-select" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${value}`} onClick={onOpen}>
      {icon}
      <span class="lin-select-value">{value}</span>
      <span class="lin-caret" aria-hidden="true">▾</span>
    </button>
    {open && children}
  </span>
);
