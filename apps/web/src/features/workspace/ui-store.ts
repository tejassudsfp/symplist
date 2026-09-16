import { type TaskCollection, taskCollections } from "@symplist/contracts";
import type { ReactNode } from "react";

/** Which surface a rename or a menu was opened from, so focus returns to the right control. */
export type TaskSurface = "list" | "header";

export interface RenameState {
  readonly taskId: string;
  readonly text: string;
  readonly surface: TaskSurface;
  readonly saving: boolean;
  /** Set when the save failed, so the row can offer Try again without losing the text. */
  readonly failed: boolean;
}

export interface MenuState {
  readonly taskId: string;
  readonly kind: "task" | "move";
  readonly surface: TaskSurface;
}

export interface WorkspaceDialog {
  readonly kind: "complete-subtasks" | "stop-run" | "restore-defaults";
  readonly title: string;
  readonly description: ReactNode;
  /** Named consequences, for example the subtasks a completion would archive. */
  readonly items?: readonly string[];
  readonly confirmLabel: string;
  readonly confirm: () => void;
  /** A second, quieter choice ("Only the parent"). */
  readonly altLabel?: string;
  readonly alt?: () => void;
  readonly cancelLabel?: string;
}

export interface WorkspaceUiState {
  /** The quick-add draft per collection; kept while the list is hidden or another task is open. */
  readonly drafts: Readonly<Record<TaskCollection, string>>;
  /** The Add subtask draft, under one parent at a time. */
  readonly subDraft: { readonly parentId: string; readonly text: string } | null;
  readonly searchOpen: Readonly<Record<TaskCollection, boolean>>;
  readonly queries: Readonly<Record<TaskCollection, string>>;
  readonly expanded: ReadonlySet<string>;
  /** The row that holds keyboard focus in each list (roving tabindex). */
  readonly activeRow: Readonly<Record<TaskCollection, string | null>>;
  readonly renaming: RenameState | null;
  readonly menu: MenuState | null;
  /** Task ids with a write in flight, so a second Enter or click cannot submit twice. */
  readonly pending: ReadonlySet<string>;
  readonly dialog: WorkspaceDialog | null;
  /** Bumped whenever a command asks the list to move focus back to a row. */
  readonly focusRequest: { readonly taskId: string; readonly nonce: number } | null;
}

function byCollection<Value>(value: Value): Record<TaskCollection, Value> {
  return Object.fromEntries(taskCollections.map((collection) => [collection, value])) as Record<
    TaskCollection,
    Value
  >;
}

export const initialWorkspaceUiState: WorkspaceUiState = {
  drafts: byCollection(""),
  subDraft: null,
  searchOpen: byCollection(false),
  queries: byCollection(""),
  expanded: new Set<string>(),
  activeRow: byCollection(null),
  renaming: null,
  menu: null,
  pending: new Set<string>(),
  dialog: null,
  focusRequest: null,
};

/**
 * Workspace view state that outlives a single component: quick-add drafts, the open sublists, the
 * focused row, an inline rename, the open task menu and the confirmation dialog. It lives outside
 * React state so typing in the quick-add field never re-renders the page or the chat, and so keyboard
 * actions (which run outside the list) can drive the same state.
 */
export class WorkspaceUiStore {
  private state: WorkspaceUiState = initialWorkspaceUiState;
  private readonly listeners = new Set<() => void>();
  private focusNonce = 0;

  getState = (): WorkspaceUiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(change: Partial<WorkspaceUiState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  setDraft(collection: TaskCollection, text: string): void {
    if (this.state.drafts[collection] === text) return;
    this.set({ drafts: { ...this.state.drafts, [collection]: text } });
  }

  setSubDraft(parentId: string | null, text = ""): void {
    if (parentId === null) {
      if (this.state.subDraft === null) return;
      this.set({ subDraft: null });
      return;
    }
    this.set({ subDraft: { parentId, text } });
  }

  setSearchOpen(collection: TaskCollection, open: boolean): void {
    this.set({
      searchOpen: { ...this.state.searchOpen, [collection]: open },
      ...(open ? {} : { queries: { ...this.state.queries, [collection]: "" } }),
    });
  }

  setQuery(collection: TaskCollection, query: string): void {
    if (this.state.queries[collection] === query) return;
    this.set({ queries: { ...this.state.queries, [collection]: query } });
  }

  setExpanded(taskId: string, expanded: boolean): void {
    const next = new Set(this.state.expanded);
    if (expanded) next.add(taskId);
    else next.delete(taskId);
    if (next.size === this.state.expanded.size) return;
    this.set({ expanded: next });
  }

  /** Opens every ancestor so a nested task stays visible when it is selected. */
  expandAll(taskIds: readonly string[]): void {
    if (taskIds.length === 0) return;
    const next = new Set(this.state.expanded);
    let changed = false;
    for (const taskId of taskIds) {
      if (!next.has(taskId)) {
        next.add(taskId);
        changed = true;
      }
    }
    if (changed) this.set({ expanded: next });
  }

  setActiveRow(collection: TaskCollection, taskId: string | null): void {
    if (this.state.activeRow[collection] === taskId) return;
    this.set({ activeRow: { ...this.state.activeRow, [collection]: taskId } });
  }

  /** Asks the list to move DOM focus to a row (after a keyboard move or a closed menu). */
  requestFocus(taskId: string | null): void {
    if (taskId === null) {
      if (this.state.focusRequest === null) return;
      this.set({ focusRequest: null });
      return;
    }
    this.focusNonce += 1;
    this.set({ focusRequest: { taskId, nonce: this.focusNonce } });
  }

  startRename(taskId: string, text: string, surface: TaskSurface): void {
    this.set({ renaming: { taskId, text, surface, saving: false, failed: false }, menu: null });
  }

  setRenameText(text: string): void {
    const renaming = this.state.renaming;
    if (!renaming || renaming.text === text) return;
    this.set({ renaming: { ...renaming, text } });
  }

  setRenameState(change: Partial<Pick<RenameState, "saving" | "failed">>): void {
    const renaming = this.state.renaming;
    if (!renaming) return;
    this.set({ renaming: { ...renaming, ...change } });
  }

  stopRename(): void {
    if (this.state.renaming === null) return;
    this.set({ renaming: null });
  }

  openMenu(taskId: string, kind: MenuState["kind"], surface: TaskSurface): void {
    this.set({ menu: { taskId, kind, surface } });
  }

  closeMenu(): void {
    if (this.state.menu === null) return;
    this.set({ menu: null });
  }

  setPending(taskId: string, pending: boolean): void {
    const next = new Set(this.state.pending);
    if (pending) next.add(taskId);
    else next.delete(taskId);
    if (next.size === this.state.pending.size) return;
    this.set({ pending: next });
  }

  isPending(taskId: string): boolean {
    return this.state.pending.has(taskId);
  }

  openDialog(dialog: WorkspaceDialog): void {
    this.set({ dialog });
  }

  closeDialog(): void {
    if (this.state.dialog === null) return;
    this.set({ dialog: null });
  }
}
