"use client";

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";

/**
 * Whether Simon is working on a task, as the workspace needs to know it (§8.1 run statuses). There is
 * no run-state seam in the shell: the server's `task.run_active` refusal on complete is the authority
 * (decision WS14). This interface only decides what the UI shows *before* it asks, so the completion
 * flow can warn early instead of surprising the person with a refusal.
 */
export type TaskRunStatus = "idle" | "queued" | "running" | "awaiting_approval" | "awaiting_user";

export interface TaskRunState {
  readonly status: TaskRunStatus;
}

export const IDLE_RUN_STATE: TaskRunState = Object.freeze({ status: "idle" });

/**
 * Where run states come from. The workspace ships the idle source: every task reads `idle` until the
 * Simon feature supplies a source backed by `run.status` events on the user topic (§7), which it can
 * do by mounting `TaskRunStateProvider` with its own source — no workspace component changes.
 *
 * `TaskRunStateProvider` must be mounted **above** `WorkspaceProvider`. Rows read the source through
 * `useTaskRunState` and would see one mounted below, but `WorkspaceProvider` reads it once to build
 * the command layer's `runStatus`, so a source mounted inside the workspace shows the activity marker
 * while completion still fails to ask before stopping a run.
 */
export interface TaskRunStateSource {
  /** The current state of a task. Never throws; unknown tasks are idle. */
  get(taskId: string): TaskRunState;
  /** Calls `listener` whenever the task's state changes; returns the unsubscribe function. */
  subscribe(taskId: string, listener: () => void): () => void;
}

export const idleRunStateSource: TaskRunStateSource = Object.freeze({
  get: () => IDLE_RUN_STATE,
  subscribe: () => () => undefined,
});

const RunStateContext = createContext<TaskRunStateSource>(idleRunStateSource);

export function TaskRunStateProvider({
  source,
  children,
}: {
  readonly source: TaskRunStateSource;
  readonly children: ReactNode;
}) {
  return createElement(RunStateContext.Provider, { value: source }, children);
}

/** The source in scope, for code that needs to read a status without subscribing to it. */
export function useTaskRunStateSource(): TaskRunStateSource {
  return useContext(RunStateContext);
}

/**
 * The run state of one task, or idle when no task is given. Only the status crosses the store
 * boundary, so a source that builds a fresh object per read is still safe to subscribe to.
 */
export function useTaskRunState(taskId: string | null | undefined): TaskRunState {
  const source = useContext(RunStateContext);
  const status = useSyncExternalStore(
    (listener) => (taskId ? source.subscribe(taskId, listener) : () => undefined),
    () => (taskId ? source.get(taskId).status : IDLE_RUN_STATE.status),
    () => IDLE_RUN_STATE.status,
  );
  return useMemo(() => (status === "idle" ? IDLE_RUN_STATE : { status }), [status]);
}

/** Whether a run is in progress or waiting, so completing the task would stop Simon's work. */
export function isRunActive(state: TaskRunState): boolean {
  return state.status !== "idle";
}

/** The short activity marker shown on a task row and in the header (never color alone). */
export function runActivityLabel(state: TaskRunState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "queued":
      return "Simon is queued";
    case "running":
      return "Simon is working";
    case "awaiting_approval":
      return "Waiting for your approval";
    case "awaiting_user":
      return "Simon needs your input";
  }
}
