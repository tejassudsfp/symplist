"use client";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { type ChatBridge, chatBridge } from "./bridge.ts";
import { ChatStore } from "./store.ts";

/**
 * Holds the chat store above the pane, so a conversation survives the panel being unmounted.
 *
 * The provider mounts unconditionally and simply has nothing inside it in a browser: `chatBridge()`
 * returns null there and `useSimonChat()` answers null, which is what `feature-slots.tsx` checks before
 * filling the shell's chat slot. That way the cloud build carries the code (it is one bundle) but never
 * runs it, and there is no build flag with a wrong setting.
 */
const Context = createContext<ChatStore | null>(null);

export function SimonProvider({
  children,
  bridge,
}: {
  readonly children: ReactNode;
  /** Injectable for tests; production takes the bridge off `window.symplist`. */
  readonly bridge?: ChatBridge | null;
}) {
  const store = useMemo(() => {
    const resolved = bridge ?? chatBridge();
    return resolved ? new ChatStore(resolved) : null;
  }, [bridge]);
  useEffect(() => {
    if (!store) return;
    return () => store.dispose();
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

/** The store, or null when this runtime has no assistant. */
export function useSimonChat(): ChatStore | null {
  return useContext(Context);
}

/** A conversation's state, subscribed, with its watcher held for as long as the component is mounted. */
export function useChatState(store: ChatStore, taskId: string | null) {
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.get(taskId),
    () => store.get(taskId),
  );
  useEffect(() => store.watch(taskId), [store, taskId]);
  return state;
}
