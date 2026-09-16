"use client";

/**
 * The task page's imperative handle for the action registry (§10.2). Buttons inside the pane call the
 * same methods, so Mod+S, the menu and the palette never take a second path around a check.
 */
export interface DocumentController {
  readonly taskId: string;
  /** Whether the editor currently accepts changes (a read-only page reports false). */
  readonly editable: boolean;
  /** Publishes the buffer now, as Mod+S does. */
  save(): void;
  /** Opens the in-document find bar; false when this view has no find. */
  find(): boolean;
}

let active: DocumentController | null = null;

/** The mounted task page, or null. The pane registers itself while it is on screen. */
export function activeDocument(): DocumentController | null {
  return active;
}

/** Registers (or clears, with null) the mounted task page. */
export function setActiveDocument(controller: DocumentController | null): void {
  if (controller === null) {
    active = null;
    return;
  }
  active = controller;
}

/** Clears the registration only when `controller` is still the active one (unmount ordering). */
export function clearActiveDocument(controller: DocumentController): void {
  if (active === controller) active = null;
}
