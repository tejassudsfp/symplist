"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { problemOf } from "@/features/access/errors";

export function connectionError(error: unknown): string {
  const problem = problemOf(error);
  if (problem.kind === "session_expired")
    return "Your session has ended. Sign in again to continue.";
  if (problem.kind === "throttled") return "Symplist is busy. Wait a moment and try again.";
  if (problem.kind === "api" && problem.status === 403)
    return "Your access changed. Refresh the page to continue.";
  return "We couldn't confirm the result. Check your connection and try again.";
}

interface ResourceState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Memory-only, single-flight resource. Reopen on every effect entry, including StrictMode replay. */
export class ConnectionResource<T> {
  private state: ResourceState<T> = { data: null, loading: true, error: null };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private opened = false;
  private pending = false;
  private controller: AbortController | null = null;
  constructor(private readonly load: (signal: AbortSignal) => Promise<T>) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: Partial<ResourceState<T>>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  open() {
    this.opened = true;
    this.refresh();
  }
  close() {
    this.opened = false;
    this.epoch++;
    this.controller?.abort();
    this.controller = null;
    this.pending = false;
    this.update({ data: null, loading: true, error: null });
  }
  refresh = () => {
    if (!this.opened) return;
    if (this.controller) {
      this.pending = true;
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const epoch = this.epoch;
    this.update({ loading: true, error: null });
    void (async () => this.load(controller.signal))()
      .then(
        (data) => {
          if (epoch === this.epoch && this.opened) this.update({ data });
        },
        (error: unknown) => {
          if (epoch === this.epoch && this.opened) this.update({ error: connectionError(error) });
        },
      )
      .finally(() => {
        if (epoch !== this.epoch || !this.opened) return;
        this.controller = null;
        this.update({ loading: false });
        if (this.pending) {
          this.pending = false;
          this.refresh();
        }
      });
  };
}

export function useConnectionResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  const store = useMemo(() => new ConnectionResource(load), [load]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    store.open();
    return () => store.close();
  }, [store, enabled]);
  return { ...state, refresh: store.refresh };
}
