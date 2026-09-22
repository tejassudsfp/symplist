import { createHash } from "node:crypto";
import type {
  TaskCreateToolInput,
  TaskMoveToolInput,
  TaskScheduleToolInput,
} from "@symplist/contracts";
import { int } from "@symplist/db";
import { IdempotencyStore } from "../idempotency/store.ts";
import { type SchedulingOptions, SchedulingService } from "../scheduling/service.ts";
import { taskScheduleTool } from "../scheduling/tools.ts";
import type { TaskAuthorization } from "../tasks/authorization.ts";
import { TaskService, type TaskWriteFold } from "../tasks/service.ts";
import { taskCreateTool, taskMoveTool } from "../tasks/tools.ts";
import type { SimonRepository } from "./repository.ts";
import { type ClaimedSimonRun, SimonError } from "./types.ts";

/** Largest task search result Simon receives, so a big workspace cannot fill the prompt. */
export const SIMON_TASK_SEARCH_LIMIT = 20;

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
    const now = this.repository.options.now;
    return {
      sql: `EXISTS (SELECT 1 FROM runs WHERE id=:task_auth_run AND owner_id=:task_auth_run_owner AND executor_generation=CAST(:task_auth_generation AS INTEGER) AND ${this.repository.runGuard().replaceAll(":now", ":task_auth_now")})`,
      get params() {
        return {
          task_auth_run: run.id,
          task_auth_run_owner: run.ownerId,
          task_auth_generation: int(run.generation),
          task_auth_now: int(now()),
        };
      },
    };
  }

  private fold(
    tool: "task_create" | "task_move",
    input: unknown,
    toolCallId: string,
  ): TaskWriteFold {
    const now = this.repository.options.now();
    // Native receipts belong to the retained run, not the HTTP client's 24-hour replay window.
    // Quick-chat deletion and account purge remove them with that authority/history.
    const store = new IdempotencyStore({
      ...this.repository.options,
      ttlMs: Number.MAX_SAFE_INTEGER - now,
    });
    const request = {
      scope: "simon.native.task",
      userId: this.claim.run.ownerId,
      key: this.callId(toolCallId),
      input: { tool, arguments: input },
      now,
    };
    const folded = store.foldedClaim(request);
    return {
      ...folded,
      completion: (response, accountKey) =>
        store.completeStatement({
          claim: folded.claim,
          response,
          accountKey,
          now: this.repository.options.now(),
        }),
      decide: (results, accountKey, offset) => {
        const decision = store.decideFoldedClaim({ request, folded, results, accountKey, offset });
        if (decision.kind === "mismatch") throw new SimonError("idempotency.mismatch");
        if (decision.kind === "in_progress") throw new SimonError("idempotency.in_progress");
        return decision.kind === "replay"
          ? { kind: "replay", body: decision.response.body }
          : decision;
      },
    };
  }

  /**
   * Finds the owner's open tasks by title (§2.1). Every other task tool takes an id the run already
   * has, which leaves Simon unable to act on a task the owner names in words — in a quick chat,
   * where the run carries no task at all, he cannot resolve "the Vatsal task" to anything and has to
   * ask for an id the owner has no reason to know. Read-only, so no idempotency fold: it takes the
   * same authorization fence as every write, and returns bounded summaries rather than documents.
   */
  async search(input: { query: string; limit?: number }) {
    const query = input.query.trim().toLowerCase();
    if (query.length === 0 || query.length > 200) throw new SimonError("validation");
    const limit = Math.max(
      1,
      Math.min(input.limit ?? SIMON_TASK_SEARCH_LIMIT, SIMON_TASK_SEARCH_LIMIT),
    );
    const state = await this.tasks.state(this.claim.run.ownerId);
    // The fence is checked against the same tree version the results came from, so a relock or an
    // executor switch between read and answer cannot leak titles.
    await this.tasks.authorize(this.claim.run.ownerId, this.authorization(), state.version);
    const terms = query.split(/\s+/u).filter(Boolean);
    const matches = [...state.tree.byId.values()]
      .filter((task) => task.status === "active")
      .map((task) => {
        const title = task.title.toLowerCase();
        // Exact, then prefix, then all-terms-present; enough to disambiguate a named task.
        const score =
          title === query
            ? 0
            : title.startsWith(query)
              ? 1
              : title.includes(query)
                ? 2
                : terms.every((t) => title.includes(t))
                  ? 3
                  : -1;
        return { task, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score || b.task.updatedAt - a.task.updatedAt)
      .slice(0, limit);
    return {
      tasks: matches.map(({ task }) => ({
        taskId: task.id,
        title: task.title,
        collection: task.collection,
        parentId: task.parentId,
        updatedAt: task.updatedAt,
      })),
      truncated: matches.length === limit,
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
      fold: this.fold("task_create", input, toolCallId),
    });
  }

  move(input: TaskMoveToolInput, toolCallId: string) {
    this.callId(toolCallId);
    return taskMoveTool(this.tasks, {
      ownerId: this.claim.run.ownerId,
      actor: { kind: "simon" },
      arguments: input,
      authorization: this.authorization(),
      fold: this.fold("task_move", input, toolCallId),
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
