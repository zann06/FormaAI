import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

/**
 * A branded dropdown that replaces the browser-native `<select>`.
 *
 * The native control was the last un-styled element in the product: on Windows it
 * rendered a grey OS widget with a bevelled arrow, and its popup list ignored the
 * brand entirely. It also cannot show a description line next to each option, which
 * the model picker needs ("cbai/deepseek-v4.1-flash" means nothing without its
 * provider).
 *
 * Behaviour kept from the native control so it stays accessible:
 *  - `role="combobox"` with `aria-expanded`/`aria-activedescendant`
 *  - Arrow keys move, Enter/Space select, Escape closes, Tab closes
 *  - Typing jumps to the first option starting with those letters
 *  - The list is a `listbox` of `option`s, so screen readers announce it
 *
 * Deliberately no portal: every use site sits inside a card with enough room, and
 * a portal would need scroll-position syncing on top of the drawer transform.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Second line, shown greyed under the label. */
  description?: string;
  disabled?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select an option',
  disabled = false,
  id,
  className = '',
  size = 'md',
  'aria-label': ariaLabel,
  'data-testid': testId,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  'data-testid'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Letters typed in a row, used for type-to-jump. */
  const typed = useRef({ text: '', timer: 0 as unknown as number });
  const listboxId = useId();

  const selectedIndex = useMemo(() => options.findIndex((option) => option.value === value), [options, value]);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      close();
    },
    [options, onChange, close],
  );

  // Close on outside pointer-down. Using pointerdown rather than click means a
  // click on another control closes this one *before* that control reacts, which
  // is what users expect from a native menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Keep the highlighted row visible while arrowing through a long list.
  //
  // Optional on purpose: `scrollIntoView` is missing in jsdom and in some embedded
  // webviews, and a missing nicety must never break selection.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);

  function openWithActive() {
    setOpen(true);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabled(options));
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;

    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openWithActive();
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        // Mark the key as handled so a surrounding dialog does not treat the same
        // Escape as "close the dialog" and throw away the user's form input.
        event.preventDefault();
        close();
        return;
      case 'Tab':
        close();
        return;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((current) => step(options, current, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((current) => step(options, current, -1));
        return;
      case 'Home':
        event.preventDefault();
        setActiveIndex(firstEnabled(options));
        return;
      case 'End':
        event.preventDefault();
        setActiveIndex(lastEnabled(options));
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (activeIndex >= 0) commit(activeIndex);
        return;
      default:
        break;
    }

    // Type-to-jump, as a native select does.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      window.clearTimeout(typed.current.timer);
      typed.current.text += event.key.toLowerCase();
      typed.current.timer = window.setTimeout(() => {
        typed.current.text = '';
      }, 600);
      const needle = typed.current.text;
      const found = options.findIndex(
        (option) => !option.disabled && option.label.toLowerCase().startsWith(needle),
      );
      if (found >= 0) setActiveIndex(found);
    }
  }

  const small = size === 'sm';

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled}
        data-testid={testId}
        onClick={() => (open ? close() : openWithActive())}
        onKeyDown={onKeyDown}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-white text-left
          transition-colors disabled:cursor-not-allowed disabled:opacity-50
          ${
            open
              ? 'border-brand-500 ring-1 ring-brand-500'
              : 'border-ink-200 hover:border-ink-300'
          }
          ${small ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm'}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? 'text-ink-900' : 'text-ink-400'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className={`shrink-0 text-ink-400 transition-transform duration-200 ${small ? 'h-3 w-3' : 'h-4 w-4'} ${
            open ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6.5 8 10.5 12 6.5" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className="animate-scale-in absolute z-40 mt-1 max-h-64 w-full origin-top overflow-auto rounded-xl border border-ink-200 bg-white py-1 shadow-lift scroll-slim"
        >
          {options.length === 0 && (
            <li className="px-3 py-2 text-xs text-ink-500">No options available</li>
          )}
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <li
                key={option.value}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onMouseDown={(event) => {
                  // Prevent the trigger button from losing focus before the click.
                  event.preventDefault();
                  commit(index);
                }}
                className={`flex cursor-pointer items-start gap-2 px-3 py-2 text-sm
                  ${option.disabled ? 'cursor-not-allowed opacity-40' : ''}
                  ${isActive && !option.disabled ? 'bg-brand-50' : ''}
                  ${isSelected ? 'font-medium text-brand-700' : 'text-ink-800'}`}
              >
                <span aria-hidden className="mt-1 w-3 shrink-0 text-brand-600">
                  {isSelected ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block truncate text-xs font-normal text-ink-500">
                      {option.description}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function firstEnabled(options: SelectOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabled(options: SelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]!.disabled) return index;
  }
  return -1;
}

/** Moves by `direction`, skipping disabled entries and wrapping at the ends. */
function step(options: SelectOption[], from: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;
  let index = from;
  for (let attempt = 0; attempt < options.length; attempt += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return from;
}
