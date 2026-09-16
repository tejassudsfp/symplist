"use client";
import { useCallback, useSyncExternalStore } from "react";
import { useScheduling } from "./provider.tsx";
import { scheduleOverlay } from "./store.ts";
import { deliveryLabel } from "./time-display.ts";

export interface DeadlineChipProps {
  readonly taskId: string;
}

/**
 * A task's subtle due chip for task list rows and the task page (§12, task_schedule.md). Workspace
 * and documents import it where they show a task. It reads only the mounted-task summary cache.
 */
export function DeadlineChip({ taskId }: DeadlineChipProps) {
  const scheduling = useScheduling();
  const subscribe = useCallback(
    (listener: () => void) => scheduling?.deadlines.subscribe(taskId, listener) ?? (() => {}),
    [scheduling, taskId],
  );
  const summary = useSyncExternalStore(
    subscribe,
    () => scheduling?.deadlines.get(taskId) ?? null,
    () => null,
  );
  if (!summary?.deadline) return null;
  const deadline = summary.deadline;
  const label =
    deadline.kind === "date"
      ? deadline.date
      : deliveryLabel(summary.deadlineAt ?? 0, deadline.zone);
  return (
    <button
      type="button"
      className="sym-deadline-chip"
      title={`${label} · ${deadline.zone}`}
      aria-label={`Deadline ${label}. Edit deadline`}
      onClick={(event) => {
        event.stopPropagation();
        scheduleOverlay.open(taskId);
      }}
    >
      {deadline.kind === "date"
        ? deadline.date
        : new Intl.DateTimeFormat(undefined, {
            timeZone: deadline.zone,
            month: "short",
            day: "numeric",
          }).format(summary.deadlineAt ?? 0)}
    </button>
  );
}
