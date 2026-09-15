"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveBindings,
  type KeyboardPreferences,
} from "./bindings.ts";
import { type InvokeResult, KeyboardDispatcher } from "./dispatcher.ts";
import { type BindingLabel, detectPlatform, formatBinding, parseBinding } from "./keys.ts";
import type { ActionServices, ActionSource, AppAction, PaneId, Platform } from "./types.ts";

export interface ActionsContextValue {
  readonly platform: Platform;
  readonly actions: readonly AppAction[];
  /** Runs an action from a button, menu or the palette, through the same availability check. */
  invoke(actionId: string, source: ActionSource, pane?: PaneId | null): Promise<InvokeResult>;
  /** The platform-aware label of an action's current binding, or null when it is unbound. */
  bindingLabel(actionId: string): BindingLabel | null;
  readonly pendingSequence: readonly string[] | null;
}

const ActionsContext = createContext<ActionsContextValue | null>(null);

function subscribeNoop(): () => void {
  return () => undefined;
}

/** macOS or other, detected on the client; the server renders the portable labels. */
export function usePlatform(): Platform {
  return useSyncExternalStore(
    subscribeNoop,
    () => detectPlatform(typeof navigator === "undefined" ? undefined : navigator),
    () => "other",
  );
}

export interface ActionsProviderProps {
  readonly actions: readonly AppAction[];
  readonly services: ActionServices;
  readonly preferences?: KeyboardPreferences;
  readonly children: ReactNode;
}

/**
 * Installs the single keyboard dispatcher for the signed-in app (§10.2) and exposes the registry to
 * buttons, menus and the palette. The document listener runs in the bubble phase, so focused widgets
 * (menus, editors) handle their own keys first and anything they prevent is skipped.
 */
export function ActionsProvider({
  actions,
  services,
  preferences = DEFAULT_KEYBOARD_PREFERENCES,
  children,
}: ActionsProviderProps) {
  const platform = usePlatform();
  const [pendingSequence, setPendingSequence] = useState<readonly string[] | null>(null);
  const actionsRef = useRef(actions);
  const servicesRef = useRef(services);
  const preferencesRef = useRef(preferences);
  useEffect(() => {
    actionsRef.current = actions;
    servicesRef.current = services;
    preferencesRef.current = preferences;
  }, [actions, services, preferences]);

  const dispatcherRef = useRef<KeyboardDispatcher | null>(null);

  useEffect(() => {
    const dispatcher = new KeyboardDispatcher({
      getActions: () => actionsRef.current,
      getPreferences: () => preferencesRef.current,
      getServices: () => servicesRef.current,
      platform,
      document,
      onSequenceChange: setPendingSequence,
      onDisabled: (action, reason) => {
        servicesRef.current.announce(
          reason ? `${action.label}: ${reason}` : `${action.label} isn't available right now`,
        );
      },
      onError: (action) => {
        servicesRef.current.announce(`${action.label} didn't work. Try again.`);
      },
    });
    dispatcherRef.current = dispatcher;
    const onKeyDown = (event: KeyboardEvent) => {
      dispatcher.handleKeyDown(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      dispatcher.dispose();
      if (dispatcherRef.current === dispatcher) dispatcherRef.current = null;
      setPendingSequence(null);
    };
  }, [platform]);

  const invoke = useCallback(
    async (
      actionId: string,
      source: ActionSource,
      pane: PaneId | null = null,
    ): Promise<InvokeResult> => {
      const dispatcher = dispatcherRef.current;
      if (!dispatcher) return { kind: "unknown" };
      return dispatcher.invoke(actionId, source, pane);
    },
    [],
  );

  const bindings = useMemo(() => effectiveBindings(actions, preferences), [actions, preferences]);

  const bindingLabel = useCallback(
    (actionId: string): BindingLabel | null => {
      const binding = bindings.get(actionId);
      return binding ? formatBinding(binding, platform) : null;
    },
    [bindings, platform],
  );

  const value = useMemo<ActionsContextValue>(
    () => ({ platform, actions, invoke, bindingLabel, pendingSequence }),
    [platform, actions, invoke, bindingLabel, pendingSequence],
  );

  return (
    <ActionsContext.Provider value={value}>
      {children}
      {pendingSequence ? (
        <div className="sym-sequence-hint" aria-hidden="true" data-slot="sequence-hint">
          {`${formatBinding(parseBinding(pendingSequence.join(" ")), platform).display} …`}
        </div>
      ) : null}
    </ActionsContext.Provider>
  );
}

export function useActions(): ActionsContextValue {
  const value = useContext(ActionsContext);
  if (!value) throw new Error("useActions must be used inside ActionsProvider");
  return value;
}

/** The action registry context when present (the shell is rendered outside it in isolated tests). */
export function useOptionalActions(): ActionsContextValue | null {
  return useContext(ActionsContext);
}
