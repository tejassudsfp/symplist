"use client";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  outlineRequestHandler,
  setOutlineRequestHandler,
} from "@/features/documents/outline-request";
import { createSimonApi, type SimonApi } from "./api.ts";
import { type SimonRealtime, simonRealtime } from "./realtime.ts";
import { SimonStore } from "./store.ts";

const Context = createContext<SimonStore | null>(null);
export function SimonProvider({
  children,
  userId,
  api,
  realtime = simonRealtime,
}: {
  children: ReactNode;
  userId: string | null;
  api?: SimonApi;
  realtime?: SimonRealtime | null;
}) {
  const store = useMemo(() => {
    void userId;
    return new SimonStore(api ?? createSimonApi(), realtime);
  }, [userId, api, realtime]);
  useEffect(() => {
    store.reopen();
    return () => store.dispose();
  }, [store]);
  useEffect(() => {
    const requestOutline = (taskId: string) => {
      store.draft(taskId, "Create a concise outline for this task page.");
    };
    setOutlineRequestHandler(requestOutline);
    return () => {
      if (outlineRequestHandler() === requestOutline) setOutlineRequestHandler(null);
    };
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useSimon() {
  return useContext(Context);
}
export function useChatState(store: SimonStore, taskId: string | null) {
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.get(taskId),
    () => store.get(taskId),
  );
  useEffect(() => store.watch(taskId), [store, taskId]);
  return state;
}
