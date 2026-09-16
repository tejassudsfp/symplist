import { createHash } from "node:crypto";
import type {
  TaskCreateToolInput,
  TaskMoveToolInput,
  TaskScheduleToolInput,
} from "@symplist/contracts";
import { int } from "@symplist/db";
import { type SchedulingOptions, SchedulingService } from "../scheduling/service.ts";
import { taskScheduleTool } from "../scheduling/tools.ts";
import type { TaskAuthorization } from "../tasks/authorization.ts";
import { TaskService } from "../tasks/service.ts";
import { taskCreateTool, taskMoveTool } from "../tasks/tools.ts";
import type { SimonRepository } from "./repository.ts";
import { type ClaimedSimonRun, SimonError } from "./types.ts";

export interface SimonNativeOptions {
  readonly scheduling: Pick<SchedulingOptions, "remindersEnabled" | "emailEnabled" | "defaultZone">;
  readonly onScheduleChanged?: (ownerId: string, taskId: string, version: number) => Promise<void>;
}

/** A claimed run, not model-supplied arguments, supplies every identity and deciding predicate. */
export class SimonNativeSession {
  readonly tasks: TaskService;
  readonly schedules: SchedulingService;
  constructor(
    readonly repository: SimonRepository,
    readonly claim: ClaimedSimonRun,
    readonly options: SimonNativeOptions,
  ) {
    this.tasks = new TaskService(repository.options);
    this.schedules = new SchedulingService({ ...repository.options, ...options.scheduling });
  }

  private callId(toolCallId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(toolCallId)) throw new SimonError("validation");
    return `${this.claim.run.id}:${toolCallId}`;
  }

  authorization(): TaskAuthorization {
    const { run } = this.claim;
    return {
      sql: `EXISTS (SELECT 1 FROM runs WHERE id=:task_auth_run AND owner_id=:task_auth_run_owner AND executor_generation=CAST(:task_auth_generation AS INTEGER) AND ${this.repository.runGuard().replaceAll(":now", ":task_auth_now")})`,
      params: {
        task_auth_run: run.id,
        task_auth_run_owner: run.ownerId,
        task_auth_generation: int(run.generation),
        task_auth_now: int(this.repository.options.now()),
      },
    };
  }

  create(input: TaskCreateToolInput, toolCallId: string) {
    const call = this.callId(toolCallId);
    // Preserve the run's UUIDv7 timestamp; hash the namespaced call for stable random bits.
    // A lost native result cannot create another task when the same call is reconciled.
    const bytes = createHash("sha256").update(`simon.task_create:${call}`).digest().subarray(0, 16);
    Buffer.from(this.claim.run.id.replaceAll("-", "").slice(0, 12), "hex").copy(bytes, 0);
    bytes[6] = ((bytes[6] ?? 0) & 15) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
    const hex = bytes.toString("hex");
    const taskId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return taskCreateTool(this.tasks, {
      ownerId: this.claim.run.ownerId,
      actor: { kind: "simon" },
      arguments: input,
      taskId,
      authorization: this.authorization(),
    });
  }

  move(input: TaskMoveToolInput, toolCallId: string) {
    this.callId(toolCallId);
    return taskMoveTool(this.tasks, {
      ownerId: this.claim.run.ownerId,
      actor: { kind: "simon" },
      arguments: input,
      authorization: this.authorization(),
    });
  }

  async schedule(input: TaskScheduleToolInput, toolCallId: string) {
    const result = await taskScheduleTool(
      this.schedules,
      {
        kind: "simon",
        ownerId: this.claim.run.ownerId,
        requestId: this.callId(toolCallId),
        taskIds: null,
        scopes: [],
        guards: [this.authorization()],
      },
      input,
    );
    if (input.operation !== "read") {
      try {
        await this.options.onScheduleChanged?.(
          this.claim.run.ownerId,
          input.taskId,
          result.version,
        );
      } catch {
        // Reconnect reads canonical state; a failed announcement cannot undo a committed save.
      }
    }
    return result;
  }
}
