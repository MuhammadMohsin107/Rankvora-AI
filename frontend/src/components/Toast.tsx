import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info, X } from 'lucide-react';

/**
 * ─── Pop-up messages ─────────────────────────────────────────────────
 *
 * Short-lived messages, shown over the page instead of inside it. For what is worth saying once and
 * is not part of the form: "Google connected", "Saved". Anything the merchant must ACT on — a failed
 * connection, a missing answer — stays inline, where it cannot disappear before it is read.
 *
 * Two ways to use it:
 *   · anywhere in the app: `const toast = useToast(); toast('Saved')` — ToastProvider (mounted once,
 *     in App.tsx) owns the list and the clock;
 *   · a screen that keeps its own list (guided setup) renders `<ToastStack toasts onDismiss />` itself.
 */

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastMessage {
  id: string;
  tone: 'success' | 'info' | 'error';
  message: string;
  /** A button inside the pop-up ("Undo", "View"). Running it also closes the pop-up. */
  action?: ToastAction;
  /** How long it stays before leaving by itself. Defaults to TOAST_MS. */
  durationMs?: number;
}

/** How long a pop-up stays before it leaves by itself — long enough to read two lines without rushing. */
const TOAST_MS = 9000;
/** A plain message is short and needs no action, so it leaves sooner than one that offers a button. */
const PLAIN_TOAST_MS = 3200;

const TONES = {
  success: { Icon: Check, classes: 'border-success-100 bg-success-50 text-success-700' },
  info: { Icon: Info, classes: 'border-info-100 bg-info-50 text-info-700' },
  error: { Icon: AlertTriangle, classes: 'border-critical-100 bg-critical-50 text-critical-700' },
} as const;

function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: string) => void }) {
  // Held while the pointer or keyboard focus is on it, so a merchant who is still reading is not
  // cut off. The clock starts again from the full time when they let go.
  const [held, setHeld] = useState(false);
  const duration = toast.durationMs ?? TOAST_MS;

  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), duration);
    return () => window.clearTimeout(timer);
  }, [held, onDismiss, toast.id, duration]);

  const { Icon, classes } = TONES[toast.tone];
  return (
    <div
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-[0_16px_40px_-16px_rgba(15,23,42,0.35)] motion-safe:animate-scale-in ${classes}`}
    >
      <Icon size={14} className="mt-px flex-shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[12px] leading-[1.5]">{toast.message}</p>
      {toast.action && (
        <button
          type="button"
          onClick={() => { toast.action?.onAction(); onDismiss(toast.id); }}
          className="flex-shrink-0 rounded px-1 text-[12px] font-semibold underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 flex-shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The pop-ups themselves.
 *
 * Rendered into the document body rather than where it is used: a step sits inside an animated
 * wrapper, and a transformed ancestor would make `fixed` position the pop-up against the step
 * instead of the window.
 */
export function ToastStack({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void }) {
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

type Show = (message: string, options?: { error?: boolean; tone?: ToastMessage['tone']; action?: ToastAction }) => void;

const ToastContext = createContext<Show | null>(null);

/** Mount once, near the root. Gives every component below it `useToast()`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback<Show>((message, options) => {
    counter.current += 1;
    const toast: ToastMessage = {
      id: `toast-${counter.current}`,
      tone: options?.tone ?? (options?.error ? 'error' : 'success'),
      message,
      action: options?.action,
      // A pop-up that offers a button stays long enough to be read and reached with the keyboard.
      durationMs: options?.action ? TOAST_MS : PLAIN_TOAST_MS,
    };
    setToasts((current) => [...current, toast]);
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** `toast('Saved')`, `toast('Could not save', { error: true })`, `toast('Removed', { action: { label, onAction } })`. */
export function useToast(): Show {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}
