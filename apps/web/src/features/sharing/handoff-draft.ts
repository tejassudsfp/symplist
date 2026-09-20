"use client";

import type { HandoffRequest } from "@symplist/contracts";

export interface HandoffDraftInput {
  readonly taskId: string;
  readonly revision: string;
  readonly target: HandoffRequest["target"];
  readonly outcome: string;
  readonly artifactIds: readonly string[];
  /** Stops waiting in this surface. The accepted Simon run continues in task chat. */
  readonly signal: AbortSignal;
}

export type HandoffDraftHandler = (input: HandoffDraftInput) => Promise<string>;
export type HandoffDraftFailureCode =
  | "simon.handoff_busy"
  | "simon.handoff_cancelled"
  | "simon.handoff_failed"
  | "simon.handoff_needs_attention"
  | "simon.handoff_timeout";

export class HandoffDraftError extends Error {
  readonly code: HandoffDraftFailureCode;
  constructor(code: HandoffDraftFailureCode) {
    super(code);
    this.name = "HandoffDraftError";
    this.code = code;
  }
}

let handler: HandoffDraftHandler | null = null;
const listeners = new Set<() => void>();

/** Registered by Simon while its owner-scoped provider is mounted. */
export function setHandoffDraftHandler(next: HandoffDraftHandler | null): void {
  if (handler === next) return;
  handler = next;
  for (const listener of listeners) listener();
}

export function handoffDraftHandler(): HandoffDraftHandler | null {
  return handler;
}

export function subscribeHandoffDraftHandler(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function handoffDraftFailure(error: unknown): string | null {
  if (!(error instanceof HandoffDraftError)) return null;
  if (error.code === "simon.handoff_cancelled") return "";
  if (error.code === "simon.handoff_busy")
    return "Simon already has a handoff request to finish. Keep this outcome unchanged and try again to resume it.";
  if (error.code === "simon.handoff_timeout")
    return "Simon is taking longer than this screen waits. The request is still in task chat; try again with the same outcome to resume it.";
  if (error.code === "simon.handoff_needs_attention")
    return "Simon needs your attention in task chat before this draft can finish.";
  return "Simon could not finish this draft. The task conversation keeps any saved reply, so review it before trying again.";
}
