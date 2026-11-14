import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A side panel that slides over the workspace.
 *
 * The workspace is now chat + document preview, because that is what the user
 * asked for: "Chat + preview saja, sisanya via drawer". Sources, the outline and
 * the section editor are real work but they are not what you look at while
 * writing — they are things you open, change, and close. Keeping them in the
 * main grid squeezed the chat into a 280 px column, so every message wrapped
 * after eight words.
 *
 * Behaves like the modal `Dialog` (Escape closes, focus is trapped and restored)
 * but anchored to the side and wider, because it hosts file lists and editors
 * rather than a short confirmation.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  side = 'left',
  width = 'w-full max-w-md',
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  side?: 'left' | 'right';
  /** Tailwind width classes, e.g. "w-full max-w-2xl". */
  width?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = panel?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex" data-testid={`drawer-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="absolute inset-0 animate-fade-in bg-ink-900/30" aria-hidden onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative z-10 flex h-full flex-col bg-white shadow-xl ${width} ${
          side === 'left' ? 'mr-auto border-r' : 'ml-auto border-l'
        } border-ink-200 ${side === 'left' ? 'animate-slide-in-left' : 'animate-slide-in-right'}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-800"
            aria-label={`Close ${title}`}
            data-testid="drawer-close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto scroll-slim">{children}</div>
        {footer && <div className="border-t border-ink-200 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
