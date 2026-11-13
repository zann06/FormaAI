import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** How many times this exact message arrived while the toast was on screen. */
  repeat: number;
}

interface ToastContextValue {
  notify: (kind: ToastKind, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Only the newest few toasts are shown.
 *
 * A batch generation can fail for every section in a row (an expired key, a rate
 * limit), and appending one card per failure covered the whole page — the report
 * behind it was unusable. Identical messages are collapsed into a counter and the
 * stack is capped.
 */
const MAX_VISIBLE = 3;
const LIFETIME: Record<ToastKind, number> = { success: 4500, info: 5000, error: 9000 };

const KIND_STYLES: Record<ToastKind, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-red-200 bg-white text-red-900',
  info: 'border-ink-200 bg-white text-ink-800',
};

const KIND_DOT: Record<ToastKind, string> = {
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  info: 'bg-brand-500',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((kind: ToastKind, message: string) => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => {
      const match = current.find((toast) => toast.kind === kind && toast.message === message);
      if (match) {
        return current.map((toast) =>
          toast.id === match.id ? { ...toast, repeat: toast.repeat + 1 } : toast,
        );
      }
      return [...current, { id, kind, message, repeat: 0 }].slice(-MAX_VISIBLE);
    });
  }, []);

  // One timer per visible toast, keyed by id. Kept outside the state updater so
  // scheduling is never repeated by a double render (StrictMode).
  //
  // The dependency is the join of ids, not the array: bumping a toast's repeat
  // counter must not restart (and so extend) the timers of the other toasts.
  const idKey = toasts.map((toast) => toast.id).join(',');
  useEffect(() => {
    const current = toasts.map((toast) =>
      window.setTimeout(() => dismiss(toast.id), LIFETIME[toast.kind]),
    );
    return () => current.forEach((timer) => window.clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey, dismiss]);

  const value = useMemo<ToastContextValue>(
    () => ({
      notify,
      success: (message: string) => notify('success', message),
      error: (message: string) => notify('error', message),
      info: (message: string) => notify('info', message),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col-reverse gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex animate-fade-up items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lift ${
              KIND_STYLES[toast.kind]
            }`}
          >
            <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${KIND_DOT[toast.kind]}`} />
            <span className="flex-1 leading-relaxed">
              {toast.message}
              {toast.repeat > 0 && (
                <span className="ml-1.5 rounded-full bg-black/5 px-1.5 py-0.5 text-xs font-medium">
                  ×{toast.repeat + 1}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="shrink-0 text-ink-400 hover:text-ink-700"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
