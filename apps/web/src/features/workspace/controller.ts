import type { TaskCollection, TaskNode } from "@symplist/contracts";
import type { PaneId } from "@/actions/types";
import type { TaskCommands } from "./commands.ts";
import type { TaskStore } from "./task-store.ts";
import { type TaskList, visibleRows } from "./tree.ts";
import type { TaskSurface, WorkspaceUiStore } from "./ui-store.ts";

/** The id of the quick-add field, so a keyboard action can focus it from anywhere in the shell. */
export const QUICK_ADD_ID = "sym-quick-add";

/** The DOM id of a task row, so a focus request can reach it. */
export function taskRowId(taskId: string): string {
  return `sym-task-${taskId}`;
}

/**
 * What a keyboard action or the command palette needs to reach the workspace. Actions are plain
 * objects in the registry (§10.2), so the mounted workspace publishes this bridge and the actions
 * look it up; without a mounted workspace every workspace action is unavailable with a reason.
 */
export interface WorkspaceCommandBridge {
  readonly tasks: TaskStore;
  readonly ui: WorkspaceUiStore;
  readonly commands: TaskCommands;
  /** The collection in the address bar, or null outside the workspace routes. */
  collection(): TaskCollection | null;
  openTaskId(): string | null;
  openTask(collection: TaskCollection, taskId: string): void;
}

let current: WorkspaceCommandBridge | null = null;

/** Publishes the mounted workspace. Passing `null` clears it only if `previous` is still current. */
export function setWorkspaceCommands(
  bridge: WorkspaceCommandBridge | null,
  previous?: WorkspaceCommandBridge,
): void {
  if (bridge === null) {
    if (previous === undefined || current === previous) current = null;
    return;
  }
  current = bridge;
}

export function workspaceCommands(): WorkspaceCommandBridge | null {
  return current;
}

/** The rows a collection's list is showing, in display order (search included). */
export function visibleTaskRows(
  bridge: WorkspaceCommandBridge,
  collection: TaskCollection,
): TaskList {
  const state = bridge.ui.getState();
  const rows = visibleRows(
    bridge.tasks.collection(collection).tasks,
    state.expanded,
    state.searchOpen[collection] ? state.queries[collection] : "",
  );
  return rows.map((row) => row.task);
}

/**
 * The task an action works on: the focused row while the task list has focus, otherwise the open
 * task (note 13: "Inbox/task navigation"). Falls back to the other one when either is missing.
 */
export function targetTaskId(bridge: WorkspaceCommandBridge, pane: PaneId | null): string | null {
  const collection = bridge.collection();
  const active = collection ? bridge.ui.getState().activeRow[collection] : null;
  const open = bridge.openTaskId();
  if (pane === "inbox") return active ?? open;
  return open ?? active;
}

/** The task itself, when it is loaded in a list or as the open task's detail. */
export function targetTask(
  bridge: WorkspaceCommandBridge,
  pane: PaneId | null,
): { readonly id: string; readonly title: string; readonly node: TaskNode | null } | null {
  const taskId = targetTaskId(bridge, pane);
  if (!taskId) return null;
  const node = bridge.tasks.findLoaded(taskId) ?? null;
  const title = node?.title ?? bridge.tasks.detail(taskId).detail?.task.title ?? "";
  return { id: taskId, title, node };
}

/** Where a command was started, so a rename or a menu opens on the surface that has focus. */
export function surfaceFor(pane: PaneId | null): TaskSurface {
  return pane === "inbox" ? "list" : "header";
}

/** Moves the focused row down (`1`) or up (`-1`); stops at the first and last row (note 13). */
export function moveActiveRow(bridge: WorkspaceCommandBridge, delta: 1 | -1): boolean {
  const collection = bridge.collection();
  if (!collection) return false;
  const rows = visibleTaskRows(bridge, collection);
  if (rows.length === 0) return false;
  const active = bridge.ui.getState().activeRow[collection];
  const index = rows.findIndex((task) => task.id === active);
  const next = index === -1 ? (delta === 1 ? 0 : rows.length - 1) : index + delta;
  if (next < 0 || next >= rows.length) return false;
  const target = rows[next];
  if (!target) return false;
  bridge.ui.setActiveRow(collection, target.id);
  bridge.ui.requestFocus(target.id);
  return true;
}

/** Opens the next or previous task in the list's visible order (`]` and `[`, note 13). */
export function openNeighbourTask(bridge: WorkspaceCommandBridge, delta: 1 | -1): boolean {
  const collection = bridge.collection();
  if (!collection) return false;
  const rows = visibleTaskRows(bridge, collection);
  if (rows.length === 0) return false;
  const open = bridge.openTaskId();
  const index = rows.findIndex((task) => task.id === open);
  const next = index === -1 ? (delta === 1 ? 0 : rows.length - 1) : index + delta;
  if (next < 0 || next >= rows.length) return false;
  const target = rows[next];
  if (!target) return false;
  bridge.ui.setActiveRow(collection, target.id);
  bridge.openTask(target.collection, target.id);
  return true;
}

/** Expands (`Right`) or collapses (`Left`) the focused row, or steps to its parent (WAI-ARIA tree). */
export function expandActiveRow(bridge: WorkspaceCommandBridge, expand: boolean): boolean {
  const collection = bridge.collection();
  if (!collection) return false;
  const taskId = bridge.ui.getState().activeRow[collection];
  if (!taskId) return false;
  const task = bridge.tasks.findLoaded(taskId);
  if (!task) return false;
  const open = bridge.ui.getState().expanded.has(taskId);
  if (expand) {
    if (task.childCount > 0 && !open) {
      bridge.ui.setExpanded(taskId, true);
      return true;
    }
    // Already open: step to the first subtask, as a tree does.
    return moveActiveRow(bridge, 1);
  }
  if (task.childCount > 0 && open) {
    bridge.ui.setExpanded(taskId, false);
    return true;
  }
  if (task.parentId) {
    bridge.ui.setActiveRow(collection, task.parentId);
    bridge.ui.requestFocus(task.parentId);
    return true;
  }
  return false;
}

/** Focuses the quick-add field of the open collection. */
export function focusQuickAdd(doc: Document | undefined = globalThis.document): boolean {
  const field = doc?.getElementById(QUICK_ADD_ID);
  if (!(field instanceof HTMLInputElement)) return false;
  field.focus();
  field.select();
  return true;
}
