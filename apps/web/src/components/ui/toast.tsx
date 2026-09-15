"use client";

import { XIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface ToastAction {
  /** Typically "Undo" or "Try again". */
  readonly label: string;
  readonly onAction: () => void | Promise<void>;
}

export interface ToastOptions {
  readonly message: string;
  readonly action?: ToastAction;
  /** Visible time before auto-dismissal; toasts with an action stay longer by default. */
  readonly durationMs?: number;
}

export interface ToastApi {
  /** Shows a toast, replacing any toast already visible (one at a time). Returns its id. */
  show(options: ToastOptions): number;
  dismiss(id?: number): void;
}

interface ActiveToast extends ToastOptions {
  readonly id: number;
}

export const TOAST_DURATION_MS = 6000;
export const TOAST_WITH_ACTION_DURATION_MS = 10_000;

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Toasts for confirmed outcomes with an optional Undo or Try again (sample toast). Only one toast is
 * visible; a new one replaces it. The region is a persistent polite live region, the timer pauses
 * while the toast is hovered or focused, and Escape inside it dismisses it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paused = useRef(false);
  const remaining = useRef(0);
  const startedAt = useRef(0);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const dismiss = useCallback(
    (id?: number) => {
      setToast((current) => {
        if (!current || (id !== undefined && current.id !== id)) return current;
        clearTimer();
        return null;
      });
    },
    [clearTimer],
  );

  const startTimer = useCallback(
    (id: number, ms: number) => {
      clearTimer();
      remaining.current = ms;
      startedAt.current = Date.now();
      timer.current = setTimeout(() => dismiss(id), ms);
    },
    [clearTimer, dismiss],
  );

  const show = useCallback(
    (options: ToastOptions) => {
      counter.current += 1;
      const id = counter.current;
      setToast({ ...options, id });
      paused.current = false;
      startTimer(
        id,
        options.durationMs ?? (options.action ? TOAST_WITH_ACTION_DURATION_MS : TOAST_DURATION_MS),
      );
      return id;
    },
    [startTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const pause = () => {
    if (!toast || paused.current) return;
    paused.current = true;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    clearTimer();
  };

  const resume = () => {
    if (!toast || !paused.current) return;
    paused.current = false;
    startTimer(toast.id, Math.max(remaining.current, 1500));
  };

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="sym-toast-region" data-slot="toast-region">
        <div role="status" aria-live="polite" aria-atomic="true">
          {toast ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: pausing on hover and focus is a timing accommodation, not an interaction.
            <div
              key={toast.id}
              className="sym-toast"
              onMouseEnter={pause}
              onMouseLeave={resume}
              onFocus={pause}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  dismiss(toast.id);
                }
              }}
            >
              <span>{toast.message}</span>
              {toast.action ? (
                <button
                  type="button"
                  className="sym-toast-action"
                  onClick={() => {
                    const action = toast.action;
                    dismiss(toast.id);
                    void action?.onAction();
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
              <button
                type="button"
                className="sym-toast-dismiss"
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
              >
                <XIcon size={13} strokeWidth={2.4} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}
