"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type AccessProblem, problemOf } from "../errors.ts";

export interface Resource<T> {
  readonly status: "loading" | "ready" | "failed";
  readonly data: T | null;
  readonly problem: AccessProblem | null;
  /** True while a reload runs over data that is already shown. */
  readonly refreshing: boolean;
  reload(): void;
  /** Replaces the loaded value after a mutation, without another request. */
  set(value: T): void;
}

/**
 * One loaded administration resource. `key` identifies what is loaded (filters, ids), so changing it
 * starts a fresh request and aborts the previous one; the data already on screen stays until the new
 * answer arrives, so a filter change never blanks the page.
 */
export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [problem, setProblem] = useState<AccessProblem | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const loadedKey = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry counter; changing it reloads the same key.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (loadedKey.current === null) setStatus("loading");
    else setRefreshing(true);
    setProblem(null);
    void (async () => {
      try {
        const value = await loadRef.current(controller.signal);
        if (cancelled) return;
        loadedKey.current = key;
        setData(value);
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        const next = problemOf(error);
        if (next.kind === "aborted") return;
        setProblem(next);
        setStatus("failed");
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const set = useCallback((value: T) => {
    setData(value);
    setStatus("ready");
    setProblem(null);
  }, []);

  return { status, data, problem, refreshing, reload, set };
}
