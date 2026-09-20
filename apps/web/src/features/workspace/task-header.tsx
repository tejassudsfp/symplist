"use client";

import { type KeyboardEvent, useEffect, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { DeadlineChip } from "@/features/scheduling/deadline-chip";
import { collectionLabels } from "./commands.ts";
import { runActivityLabel, useTaskRunState } from "./run-state.ts";
import { TaskHistoryMenuItem, TaskMenu } from "./task-menu.tsx";
import { useTaskDetail, useWorkspace, useWorkspaceUi } from "./workspace-provider.tsx";

/**
 * The task page header (task_document.md, workspace_now.md): completion, the title, its collection
 * and parent, the deadline chip and the task menu with a link to the page's history. The shell's page
 * frame supplies the mobile Back control and the Chat switch around it.
 */
export function TaskHeader({ taskId }: { readonly taskId: string }) {
  const { tasks, ui, commands, collection, navigate } = useWorkspace();
  const snapshot = useTaskDetail(taskId);
  const loaded = tasks.findLoaded(taskId);
  const renaming = useWorkspaceUi((state) =>
    state.renaming?.taskId === taskId && state.renaming.surface === "header"
      ? state.renaming
      : null,
  );
  const pending = useWorkspaceUi((state) => state.pending.has(taskId));
  const runState = useTaskRunState(taskId);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const renamingTaskId = renaming ? taskId : null;
  const detail = snapshot.detail;
  const title = detail?.task.title ?? loaded?.title ?? "";
  const taskCollection = detail?.task.collection ?? loaded?.collection ?? collection;
  const parent = detail?.ancestors.at(-1) ?? null;
  const archived = detail?.task.status === "archived";
  const activity = runActivityLabel(runState);

  // A task moved on another device keeps the address honest, so Back and refresh land in the right list.
  useEffect(() => {
    if (detail?.task.status !== "active") return;
    if (collection && detail.task.collection !== collection) {
      navigate(`/${detail.task.collection}/${taskId}`, { replace: true });
    }
  }, [detail, collection, taskId, navigate]);

  // Renaming from the header is an explicit request to edit the title, so the field takes focus once.
  useEffect(() => {
    if (renamingTaskId === null) return;
    const field = renameRef.current;
    field?.focus();
    field?.select();
  }, [renamingTaskId]);

  if (snapshot.status === "error" && snapshot.failure?.kind === "not_found") {
    return (
      <div className="sym-task-header">
        <h1 className="sym-task-header-title">This task isn't available</h1>
        <span className="sym-task-chip">Pick another task from the list</span>
      </div>
    );
  }

  if (!detail && !loaded) {
    return (
      <div className="sym-task-header" aria-busy="true">
        <Skeleton className="h-4 w-48" />
        <span className="sr-only">Loading this task</span>
      </div>
    );
  }

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commands.commitRename();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      ui.stopRename();
    }
  };

  return (
    <div className="sym-task-header">
      {archived ? null : (
        <input
          type="checkbox"
          checked={false}
          aria-label={`Complete ${title}`}
          className="sym-task-check sym-task-check--header"
          disabled={pending}
          onChange={() => void commands.complete(taskId)}
        />
      )}
      {renaming ? (
        <>
          <input
            ref={renameRef}
            className="sym-rename-input sym-rename-input--header"
            aria-label={`Rename ${title}`}
            value={renaming.text}
            disabled={renaming.saving}
            onChange={(event) => ui.setRenameText(event.target.value)}
            onKeyDown={onRenameKeyDown}
            onBlur={() => {
              if (!renaming.failed) void commands.commitRename();
            }}
          />
          {renaming.failed ? (
            <span role="alert" className="sym-task-error">
              Rename didn't save.{" "}
              <button
                type="button"
                className="sym-text-button"
                onClick={() => void commands.commitRename()}
              >
                Try again
              </button>
            </span>
          ) : null}
        </>
      ) : (
        <h1 className="sym-task-header-title" title={title}>
          {title}
        </h1>
      )}
      <span className="sym-task-header-meta">
        {taskCollection ? (
          <span className="sym-task-chip">
            <span aria-hidden="true" className="sym-task-chip-dot" />
            {archived
              ? `Archived from ${collectionLabels[taskCollection]}`
              : collectionLabels[taskCollection]}
          </span>
        ) : null}
        {parent ? <span className="sym-task-parent">{`in “${parent.title}”`}</span> : null}
        {activity ? <span className="sym-task-activity">{activity}</span> : null}
        <DeadlineChip taskId={taskId} />
      </span>
      {archived || !taskCollection ? null : (
        <TaskMenu
          task={{ id: taskId, title, collection: taskCollection }}
          surface="header"
          className="sym-icon-button"
          extra={<TaskHistoryMenuItem taskId={taskId} />}
        />
      )}
    </div>
  );
}

/** The chat panel's subtitle: the task the conversation belongs to. */
export function ChatTitle({ taskId }: { readonly taskId: string }) {
  const { tasks } = useWorkspace();
  const snapshot = useTaskDetail(taskId);
  const title = snapshot.detail?.task.title ?? tasks.findLoaded(taskId)?.title ?? "";
  return title ? <span className="truncate">{title}</span> : null;
}
