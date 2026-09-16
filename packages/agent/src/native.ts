import {
  schedulingErrorCodes,
  taskCreateToolInputSchema,
  taskMoveToolInputSchema,
  taskScheduleToolInputSchema,
  workspaceErrorCodes,
} from "@symplist/contracts";
import { type SimonNativeOptions, SimonNativeSession } from "@symplist/core/simon";
import { type ToolSet, tool } from "ai";
import type { SimonToolContext } from "./turn.ts";

export function simonNativeTools(context: SimonToolContext, options: SimonNativeOptions): ToolSet {
  const session = new SimonNativeSession(context.repository, context.claim, options);
  const result = async (work: () => Promise<unknown>) => {
    if (context.signal.aborted) return { status: "failed", code: "simon.stale" };
    try {
      return await work();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (
        typeof code === "string" &&
        (Object.hasOwn(workspaceErrorCodes, code) ||
          Object.hasOwn(schedulingErrorCodes, code) ||
          code === "not_found")
      )
        return { status: "failed", code };
      throw error;
    }
  };
  return {
    task_create: tool({
      description:
        "Create an owned task or subtask. Without a parent or collection it goes to Unclassified.",
      inputSchema: taskCreateToolInputSchema,
      execute: (args, { toolCallId }) => result(() => session.create(args, toolCallId)),
    }),
    task_move: tool({
      description: "Move an owned task and its entire subtree into a collection.",
      inputSchema: taskMoveToolInputSchema,
      execute: (args, { toolCallId }) => result(() => session.move(args, toolCallId)),
    }),
    task_schedule: tool({
      description:
        "Read or change an owned task's deadline and reminders. Writes require the expected schedule version; reminders are local-hour due-date notices, not alarms.",
      inputSchema: taskScheduleToolInputSchema,
      execute: (args, { toolCallId }) => result(() => session.schedule(args, toolCallId)),
    }),
  };
}
