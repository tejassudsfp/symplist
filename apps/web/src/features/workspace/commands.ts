import type {
  TaskCollection,
  TaskCompleteMode,
  TaskId,
  TaskMoveRequest,
  TaskNode,
  TaskRestoreResponse,
} from "@symplist/contracts";
import type { ToastApi } from "@/components/ui/toast";
import { ApiError, type IdempotencyKeys } from "@/lib/api";
import { classifyFailure, writeFailureMessage } from "./errors.ts";
import type { TaskRunStatus } from "./run-state.ts";
import type { TaskStore } from "./task-store.ts";
import { childrenOf, type InsertPlacement, subtreeOf } from "./tree.ts";
import type { WorkspaceUiStore } from "./ui-store.ts";

/** Collection labels as the rail and menus name them. */
export const collectionLabels: Readonly<Record<TaskCollection, string>> = Object.freeze({
  now: "Now",
  later: "Later",
  unclassified: "Unclassified",
});

export function quoted(title: string): string {
  return `“${title}”`;
}

export interface TaskCommandDeps {
  readonly tasks: TaskStore;
  readonly ui: WorkspaceUiStore;
  readonly toast: ToastApi;
  readonly announce: (message: string) => void;
  readonly navigate: (href: string, options?: { readonly replace?: boolean }) => void;
  /** The task open in the workspace, so a completed or moved task keeps the address honest. */
  readonly openTaskId: () => string | null;
  readonly runStatus: (taskId: string) => TaskRunStatus;
  readonly keys: IdempotencyKeys;
}

interface CompletionPlan {
  readonly mode: TaskCompleteMode;
  readonly stopRun: boolean;
}

/**
 * Every task write the workspace performs, with the confirmations, Undo and retry paths the briefs
 * ask for (task_actions.md, workspace_later.md): the parent-with-subtasks question (decision P1), the
 * active-run question backed by the server's `task.run_active` refusal (§2.1), Undo toasts after a
 * move or a completion, and a revert with Try again when a write fails.
 */
export class TaskCommands {
  constructor(private readonly deps: TaskCommandDeps) {}

  private key(scope: string): string {
    return this.deps.keys.acquire(scope);
  }

  private release(scope: string): void {
    this.deps.keys.release(scope);
  }

  private node(taskId: string): TaskNode | undefined {
    return this.deps.tasks.findLoaded(taskId);
  }

  private titleOf(taskId: string, fallback = "this task"): string {
    return (
      this.node(taskId)?.title ?? this.deps.tasks.detail(taskId).detail?.task.title ?? fallback
    );
  }

  /** Adds the collection's quick-add draft as a task. Keeps the text when the write fails. */
  async addTask(collection: TaskCollection): Promise<void> {
    const draft = this.deps.ui.getState().drafts[collection].trim();
    if (draft.length === 0) return;
    const scope = `create:${collection}:${draft}`;
    if (this.deps.ui.isPending(scope)) return;
    this.deps.ui.setPending(scope, true);
    this.deps.ui.setDraft(collection, "");
    try {
      const response = await this.deps.tasks.create({ title: draft, collection }, this.key(scope));
      this.release(scope);
      this.deps.announce(`Added ${quoted(response.task.title)} to ${collectionLabels[collection]}`);
    } catch (error) {
      const failure = classifyFailure(error);
      this.deps.ui.setDraft(collection, draft);
      this.deps.toast.show({
        message: writeFailureMessage(failure, `add ${quoted(draft)}`),
        ...(failure.retryable
          ? { action: { label: "Try again", onAction: () => void this.addTask(collection) } }
          : {}),
      });
      if (!failure.retryable) this.release(scope);
    } finally {
      this.deps.ui.setPending(scope, false);
    }
  }

  /** Adds the open subtask draft under its parent and keeps the field open for the next one. */
  async addSubtask(): Promise<void> {
    const draft = this.deps.ui.getState().subDraft;
    const title = draft?.text.trim() ?? "";
    if (!draft || title.length === 0) return;
    const scope = `create:${draft.parentId}:${title}`;
    if (this.deps.ui.isPending(scope)) return;
    this.deps.ui.setPending(scope, true);
    this.deps.ui.setSubDraft(draft.parentId, "");
    try {
      const response = await this.deps.tasks.create(
        { title, parentId: draft.parentId as TaskId },
        this.key(scope),
      );
      this.release(scope);
      this.deps.ui.setExpanded(draft.parentId, true);
      this.deps.announce(
        `Added ${quoted(response.task.title)} under ${quoted(this.titleOf(draft.parentId))}`,
      );
    } catch (error) {
      const failure = classifyFailure(error);
      this.deps.ui.setSubDraft(draft.parentId, title);
      this.deps.toast.show({
        message: writeFailureMessage(failure, `add ${quoted(title)}`),
        ...(failure.retryable
          ? { action: { label: "Try again", onAction: () => void this.addSubtask() } }
          : {}),
      });
      if (!failure.retryable) this.release(scope);
    } finally {
      this.deps.ui.setPending(scope, false);
    }
  }

  /** Commits the open inline rename. An unchanged or empty title just closes the field. */
  async commitRename(): Promise<void> {
    const renaming = this.deps.ui.getState().renaming;
    if (!renaming || renaming.saving) return;
    const title = renaming.text.trim();
    const taskId = renaming.taskId;
    const current = this.titleOf(taskId, "");
    if (title.length === 0 || title === current) {
      this.deps.ui.stopRename();
      this.deps.ui.requestFocus(taskId);
      return;
    }
    const scope = `rename:${taskId}:${title}`;
    this.deps.ui.setRenameState({ saving: true, failed: false });
    try {
      await this.deps.tasks.rename(taskId, title, this.key(scope));
      this.release(scope);
      this.deps.ui.stopRename();
      this.deps.ui.requestFocus(taskId);
      this.deps.announce(`Renamed to ${quoted(title)}`);
    } catch (error) {
      const failure = classifyFailure(error);
      this.deps.ui.setRenameState({ saving: false, failed: true });
      if (!failure.retryable) this.release(scope);
      this.deps.announce(writeFailureMessage(failure, `rename ${quoted(current)}`));
    }
  }

  /** Moves a task to another collection, with Undo (decision P3, workspace_later.md). */
  moveToCollection(taskId: string, collection: TaskCollection): Promise<void> {
    return this.move(
      taskId,
      { collection },
      { collection, parentId: null },
      `to ${collectionLabels[collection]}`,
    );
  }

  /**
   * Moves or reorders a task. `request` is what the server decides from (a collection, a parent or a
   * neighbour); `placement` is where the list shows it until the server's own tree arrives.
   */
  async move(
    taskId: string,
    request: TaskMoveRequest,
    placement: InsertPlacement,
    describe: string,
  ): Promise<void> {
    const title = this.titleOf(taskId);
    const scope = `move:${taskId}:${JSON.stringify(request)}`;
    if (this.deps.ui.isPending(taskId)) return;
    this.deps.ui.setPending(taskId, true);
    try {
      const response = await this.deps.tasks.move(taskId, request, placement, this.key(scope));
      this.release(scope);
      const carried = response.movedTaskIds.length - 1;
      const withSubtasks = carried > 0 ? ` with ${carried} subtask${carried === 1 ? "" : "s"}` : "";
      if (this.deps.openTaskId() === taskId) {
        this.deps.navigate(`/${response.collection}/${taskId}`, { replace: true });
      }
      this.deps.toast.show({
        message: `Moved ${quoted(title)} ${describe}${withSubtasks}`,
        action: {
          label: "Undo",
          onAction: () => {
            void this.undoMove(taskId, response.previous);
          },
        },
      });
      this.deps.announce(`Moved ${quoted(title)} ${describe}`);
    } catch (error) {
      const failure = classifyFailure(error);
      this.deps.toast.show({
        message: `${writeFailureMessage(failure, `move ${quoted(title)}`)} It's back where it was.`,
        ...(failure.retryable
          ? {
              action: {
                label: "Try again",
                onAction: () => void this.move(taskId, request, placement, describe),
              },
            }
          : {}),
      });
      if (!failure.retryable) this.release(scope);
    } finally {
      this.deps.ui.setPending(taskId, false);
    }
  }

  private async undoMove(
    taskId: string,
    previous: { collection: TaskCollection; parentId: string | null; afterId: string | null },
  ): Promise<void> {
    const list = this.deps.tasks.collection(previous.collection).tasks;
    const siblings = list.filter(
      (task) => task.parentId === previous.parentId && task.id !== taskId,
    );
    const neighbour =
      previous.afterId !== null
        ? { afterId: previous.afterId as TaskId }
        : siblings[0]
          ? { beforeId: siblings[0].id }
          : {};
    const request: TaskMoveRequest =
      previous.parentId === null
        ? { collection: previous.collection, parentId: null, ...neighbour }
        : { parentId: previous.parentId as TaskId, ...neighbour };
    const placement: InsertPlacement = {
      collection: previous.collection,
      parentId: previous.parentId,
      ...(previous.afterId !== null
        ? { afterId: previous.afterId }
        : siblings[0]
          ? { beforeId: siblings[0].id }
          : {}),
    };
    await this.move(taskId, request, placement, `back to ${collectionLabels[previous.collection]}`);
  }

  /**
   * Completes a task (§2.1). Asks first when open subtasks would go with it (P1) and when Simon is
   * still working on it; the server's `task.run_active` refusal asks the same question if the run
   * started while the person was deciding.
   */
  async complete(taskId: string, plan?: Partial<CompletionPlan>): Promise<void> {
    if (this.deps.ui.isPending(taskId)) return;
    const title = this.titleOf(taskId);
    const node = this.node(taskId);
    const subtasks = node ? subtreeOf(this.listOf(taskId), taskId).slice(1) : [];
    const openSubtasks = node?.childCount ?? 0;
    if (plan?.mode === undefined && openSubtasks > 0) {
      const total = subtasks.length + 1;
      this.deps.ui.openDialog({
        kind: "complete-subtasks",
        title: `Complete ${quoted(title)} and its ${subtasks.length === 1 ? "subtask" : `${subtasks.length} subtasks`}?`,
        description:
          "Open subtasks are archived with it. Keep them instead and they become tasks of their own.",
        items: subtasks.map((task) => task.title),
        confirmLabel: `Complete all ${total}`,
        confirm: () => {
          this.deps.ui.closeDialog();
          void this.complete(taskId, { mode: "all" });
        },
        altLabel: "Only the parent",
        alt: () => {
          this.deps.ui.closeDialog();
          void this.complete(taskId, { mode: "parent_only" });
        },
      });
      return;
    }
    const mode: TaskCompleteMode = plan?.mode ?? "all";
    const stopRun = plan?.stopRun ?? false;
    if (!stopRun && this.deps.runStatus(taskId) !== "idle") {
      this.askToStopRun(taskId, title, mode);
      return;
    }
    await this.submitCompletion(taskId, title, { mode, stopRun });
  }

  private listOf(taskId: string) {
    const node = this.deps.tasks.findLoaded(taskId);
    return node ? this.deps.tasks.collection(node.collection).tasks : [];
  }

  private askToStopRun(taskId: string, title: string, mode: TaskCompleteMode): void {
    this.deps.ui.openDialog({
      kind: "stop-run",
      title: "Stop Simon and complete this task?",
      description: `Simon is still working on ${quoted(title)}. Completing it now stops the run; anything already sent or saved stays as it is.`,
      confirmLabel: "Stop and complete",
      cancelLabel: "Keep working",
      confirm: () => {
        this.deps.ui.closeDialog();
        void this.submitCompletion(taskId, title, { mode, stopRun: true });
      },
    });
  }

  private async submitCompletion(
    taskId: string,
    title: string,
    plan: CompletionPlan,
  ): Promise<void> {
    const node = this.node(taskId);
    const list = this.listOf(taskId);
    const subtree = node ? subtreeOf(list, taskId) : [];
    const siblings = node ? childrenOf(list, node.parentId) : [];
    const index = siblings.findIndex((task) => task.id === taskId);
    const placement: InsertPlacement | null = node
      ? {
          collection: node.collection,
          parentId: node.parentId,
          ...(index > 0 && siblings[index - 1]
            ? { afterId: (siblings[index - 1] as TaskNode).id }
            : siblings[index + 1]
              ? { beforeId: (siblings[index + 1] as TaskNode).id }
              : {}),
        }
      : null;
    const wasOpen = this.deps.openTaskId() === taskId;
    const scope = `complete:${taskId}:${plan.mode}:${plan.stopRun ? "stop" : "keep"}`;
    this.deps.ui.setPending(taskId, true);
    try {
      const response = await this.deps.tasks.complete(
        taskId,
        { mode: plan.mode, stopRun: plan.stopRun },
        this.key(scope),
      );
      this.release(scope);
      if (wasOpen && node) this.deps.navigate(`/${node.collection}`);
      const archived = response.archivedTaskIds.length;
      const message =
        archived > 1
          ? `Completed ${quoted(title)} and ${archived - 1} subtask${archived === 2 ? "" : "s"} · moved to Archive`
          : `Completed ${quoted(title)} · moved to Archive`;
      this.deps.toast.show({
        message,
        action: {
          label: "Undo",
          onAction: () => {
            void this.undoCompletion(taskId, title, subtree, placement, wasOpen);
          },
        },
      });
      this.deps.announce(message);
    } catch (error) {
      if (error instanceof ApiError && error.code === "task.run_active" && !plan.stopRun) {
        this.askToStopRun(taskId, title, plan.mode);
        return;
      }
      const failure = classifyFailure(error);
      this.deps.toast.show({
        message: writeFailureMessage(failure, `complete ${quoted(title)}`),
        ...(failure.retryable
          ? {
              action: {
                label: "Try again",
                onAction: () => void this.submitCompletion(taskId, title, plan),
              },
            }
          : {}),
      });
      if (!failure.retryable) this.release(scope);
    } finally {
      this.deps.ui.setPending(taskId, false);
    }
  }

  private async undoCompletion(
    taskId: string,
    title: string,
    subtree: readonly TaskNode[],
    placement: InsertPlacement | null,
    reopen: boolean,
  ): Promise<void> {
    const scope = `restore:${taskId}`;
    try {
      const response = await this.deps.tasks.restore(
        taskId,
        this.key(scope),
        placement && subtree.length > 0 ? { subtree, placement } : undefined,
      );
      this.release(scope);
      if (reopen) this.deps.navigate(`/${response.collection}/${taskId}`);
      this.deps.announce(`${quoted(title)} is back in ${collectionLabels[response.collection]}`);
    } catch (error) {
      const failure = classifyFailure(error);
      this.deps.toast.show({
        message: writeFailureMessage(failure, `bring ${quoted(title)} back`),
        ...(failure.retryable
          ? {
              action: {
                label: "Try again",
                onAction: () => void this.undoCompletion(taskId, title, subtree, placement, reopen),
              },
            }
          : {}),
      });
      if (!failure.retryable) this.release(scope);
    }
  }

  /** Restores an archived task (P2). The archive page shows the result and any fallback itself. */
  async restore(taskId: string): Promise<TaskRestoreResponse> {
    const scope = `restore:${taskId}`;
    try {
      const response = await this.deps.tasks.restore(taskId, this.key(scope));
      this.release(scope);
      return response;
    } catch (error) {
      if (!classifyFailure(error).retryable) this.release(scope);
      throw error;
    }
  }

  /** Completes a restored task again, for the Undo beside a restore result. */
  async completeAgain(taskId: string): Promise<void> {
    await this.submitCompletion(taskId, this.titleOf(taskId), { mode: "all", stopRun: false });
  }
}
