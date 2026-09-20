import type { ReactNode } from "react";

/**
 * One extra entry in a task's menu, contributed by another feature (task_actions.md: the menu also
 * carries the deadline, reminder, handoff and sharing entries those features own). A feature adds its
 * entries to `taskMenuExtensions` in place, the same way features fill their `actions.ts` seam
 * (§2.3); the workspace renders them between Move to… and Complete, in registration order.
 */
export interface TaskMenuExtension {
  /** Stable id, prefixed with the owning feature (`scheduling.set_deadline`). */
  readonly id: string;
  readonly label: ReactNode;
  /** An action id from the registry, so the item shows its current shortcut (§10.2). */
  readonly actionId?: string;
  /** Whether the entry applies to this task; a missing predicate means always. */
  readonly available?: (taskId: string) => boolean;
  readonly onSelect: (taskId: string) => void;
}

/** Extra task-menu entries. Empty until a feature contributes; never reordered by the workspace. */
export const taskMenuExtensions: TaskMenuExtension[] = [];
