"use client";

/**
 * "Ask Simon for an outline" on the empty page (task_document.md) is an action seam: the documents
 * feature owns the control and the empty state, the Simon feature owns what happens when it runs.
 * Until Simon registers a handler the action is present but unavailable, with a reason, so the
 * control never pretends to have started something.
 */
export type OutlineRequestHandler = (taskId: string) => void | Promise<void>;

let handler: OutlineRequestHandler | null = null;

/** Registered by the Simon feature; pass null to remove it. */
export function setOutlineRequestHandler(next: OutlineRequestHandler | null): void {
  handler = next;
}

export function outlineRequestHandler(): OutlineRequestHandler | null {
  return handler;
}
