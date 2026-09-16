"use client";

import type { TaskCollection, TaskNode } from "@symplist/contracts";
import { ChevronRight, GripVertical } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { DeadlineChip } from "@/features/scheduling/deadline-chip";
import { taskRowId } from "./controller.ts";
import { useTaskDragState, useTaskRowDrag } from "./dnd.tsx";
import { runActivityLabel, useTaskRunState } from "./run-state.ts";
import { TaskMenu } from "./task-menu.tsx";
import { useWorkspace, useWorkspaceUi } from "./workspace-provider.tsx";

/** The list shows three levels of nesting; deeper subtasks keep the third level's indent. */
export const MAX_VISIBLE_DEPTH = 2;
const INDENT_PX = 18;

export interface TaskRowProps {
  readonly task: TaskNode;
  readonly collection: TaskCollection;
  readonly expanded: boolean;
  /** 1-based place among the rows shown at this row's level, not in the flat list. */
  readonly posInSet: number;
  readonly setSize: number;
  /** False for an ancestor kept only so a search result keeps its place in the hierarchy. */
  readonly matched?: boolean;
  /**
   * Whether this row is the tree's single tab stop. The list decides, because a tree must always have
   * exactly one, including before anything in it has been focused (WAI-ARIA tree pattern).
   */
  readonly tabStop: boolean;
}

/**
 * One task in the list (workspace_now.md): a completion checkbox that is not a selection control, the
 * title, an optional preview, a subtle activity marker, its deadline chip, and the controls that
 * appear on hover or focus. Selecting the row opens the task's page and chat together.
 *
 * The row is the tree's single tab stop (roving tabindex): every control inside it is reachable with
 * the pointer or through the task's own actions (`x`, `Shift+F10`, `Move to…`), so Tab always leaves
 * the tree instead of walking each row's controls.
 */
export function TaskRow({
  task,
  collection,
  expanded,
  posInSet,
  setSize,
  matched = true,
  tabStop,
}: TaskRowProps) {
  const { ui, commands, openTask, openTaskId } = useWorkspace();
  const renaming = useWorkspaceUi((state) =>
    state.renaming?.taskId === task.id && state.renaming.surface === "list" ? state.renaming : null,
  );
  const pending = useWorkspaceUi((state) => state.pending.has(task.id));
  const focusNonce = useWorkspaceUi((state) =>
    state.focusRequest?.taskId === task.id ? state.focusRequest.nonce : null,
  );
  const runState = useTaskRunState(task.id);
  const drag = useTaskRowDrag(task, renaming !== null);
  const dragState = useTaskDragState();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const selected = openTaskId === task.id;
  const activity = runActivityLabel(runState);
  const dropEdge = dragState.row?.taskId === task.id ? dragState.row.edge : null;
  const renamingTaskId = renaming ? task.id : null;

  useEffect(() => {
    if (focusNonce === null) return;
    rowRef.current?.focus({ preventScroll: false });
  }, [focusNonce]);

  // Renaming is an explicit request to edit the title, so the field takes focus when it opens —
  // once, rather than with `autofocus`, which would also steal focus on a server-rendered page.
  useEffect(() => {
    if (renamingTaskId === null) return;
    const field = renameRef.current;
    field?.focus();
    field?.select();
  }, [renamingTaskId]);

  const open = () => {
    ui.setActiveRow(collection, task.id);
    openTask(task.collection, task.id);
  };

  const select = (event: MouseEvent<HTMLDivElement>) => {
    if (
      (event.target as Element).closest("button, input, a, [data-slot='dropdown-menu-content']")
    ) {
      return;
    }
    open();
  };

  /**
   * Enter and Space are the tree's own activation keys (WAI-ARIA), the keyboard equivalent of
   * clicking the row. `preventDefault` stops the shared dispatcher running `workspace.open_task` for
   * the same press; that action stays the path for focus anywhere else in the list pane (note 13).
   */
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    open();
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commands.commitRename();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      ui.stopRename();
      ui.requestFocus(task.id);
    }
  };

  const indent = 6 + Math.min(task.depth, MAX_VISIBLE_DEPTH) * INDENT_PX;
  const subtaskCount = task.childCount;

  return (
    <div
      ref={(element) => {
        rowRef.current = element;
        drag.ref(element);
      }}
      id={taskRowId(task.id)}
      role="treeitem"
      aria-level={task.depth + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={selected}
      {...(subtaskCount > 0 ? { "aria-expanded": expanded } : {})}
      aria-busy={pending || undefined}
      tabIndex={tabStop ? 0 : -1}
      className="sym-task-row"
      data-selected={selected || undefined}
      data-context={matched ? undefined : "true"}
      data-dragging={drag.isDragSource || undefined}
      data-drop-edge={dropEdge ?? undefined}
      style={{ paddingInlineStart: `${indent}px` }}
      onClick={select}
      onKeyDown={onRowKeyDown}
      onFocus={() => ui.setActiveRow(collection, task.id)}
    >
      {subtaskCount > 0 ? (
        <button
          type="button"
          className="sym-task-twisty"
          tabIndex={-1}
          aria-label={
            expanded ? `Collapse ${task.title} subtasks` : `Expand ${task.title} subtasks`
          }
          onClick={() => ui.setExpanded(task.id, !expanded)}
        >
          <ChevronRight
            size={11}
            strokeWidth={2.5}
            aria-hidden="true"
            style={{ transform: expanded ? "rotate(90deg)" : undefined }}
          />
        </button>
      ) : (
        // A task with no subtasks keeps the twisty's space without an unlabelled control in the row.
        <span aria-hidden="true" className="sym-task-twisty" data-hidden="true" />
      )}
      <input
        type="checkbox"
        checked={false}
        aria-label={`Complete ${task.title}`}
        className="sym-task-check"
        tabIndex={-1}
        disabled={pending}
        onChange={() => void commands.complete(task.id)}
      />
      <div className="sym-task-body">
        {renaming ? (
          <>
            <input
              ref={renameRef}
              className="sym-rename-input"
              aria-label={`Rename ${task.title}`}
              value={renaming.text}
              disabled={renaming.saving}
              onChange={(event) => ui.setRenameText(event.target.value)}
              onKeyDown={onRenameKeyDown}
              onBlur={() => {
                if (!renaming.failed) void commands.commitRename();
              }}
            />
            {renaming.failed ? (
              <p role="alert" className="sym-task-error">
                Rename didn't save.{" "}
                <button
                  type="button"
                  className="sym-text-button"
                  onClick={() => void commands.commitRename()}
                >
                  Try again
                </button>
              </p>
            ) : null}
          </>
        ) : (
          <span className="sym-task-title">{task.title}</span>
        )}
        {task.preview && !renaming ? (
          <span className="sym-task-preview">{task.preview}</span>
        ) : null}
        <span className="sym-task-meta">
          {activity ? (
            <span className="sym-task-activity">
              {runState.status === "running" || runState.status === "queued" ? (
                <Spinner size={9} />
              ) : (
                <span aria-hidden="true" className="sym-task-dot" />
              )}
              {activity}
            </span>
          ) : null}
          {subtaskCount > 0 && !expanded ? (
            <span>{`${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}`}</span>
          ) : null}
          {task.source === "mcp" ? <span>Added by connected agent</span> : null}
          <DeadlineChip taskId={task.id} />
        </span>
      </div>
      <span className="sym-task-tools">
        <button
          type="button"
          ref={drag.handleRef}
          className="sym-task-grip"
          tabIndex={-1}
          aria-label={`Drag ${task.title}`}
          title="Drag to move"
        >
          <GripVertical size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        <TaskMenu task={task} surface="list" tabIndex={-1} />
      </span>
    </div>
  );
}
