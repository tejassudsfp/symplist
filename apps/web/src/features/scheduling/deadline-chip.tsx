"use client";

export interface DeadlineChipProps {
  readonly taskId: string;
}

/**
 * A task's subtle due chip for task list rows and the task page (§12, task_schedule.md). Workspace
 * and documents import it where they show a task. PLACEHOLDER: renders nothing until the scheduling
 * feature implements it.
 */
export function DeadlineChip(_props: DeadlineChipProps) {
  return null;
}
