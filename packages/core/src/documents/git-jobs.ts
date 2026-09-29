import {
  type DocumentGitPayload,
  documentGitPayloadSchema,
  taskDocumentDiffInputSchema,
  taskDocumentHistoryInputSchema,
  taskDocumentRestoreInputSchema,
  taskDocumentUpdateSectionInputSchema,
} from "@symplist/contracts";
import type { AccountDataKey } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import { type DbClient, int, sql, uuidv7 } from "@symplist/db";
import {
  type DocumentArtifacts,
  DocumentError,
  isDocumentError,
  type JobRef,
  type SqlGuard,
} from "@symplist/docs";
import type { AccountKeyStore } from "../account/keys.ts";
import { mcpAuthorization } from "../mcp/grants.ts";
import type { McpDocumentActor } from "./actor.ts";
import type { RetrievalBudget } from "./budgets.ts";
import { DocumentAccessDeniedError } from "./context.ts";
import type { AgentDocumentActor, DocumentTools } from "./tools.ts";

/** The `document-git` Trigger task id (§8.8). */
export const DOCUMENT_GIT_TASK_ID = "document-git";

/** The document tools that reconstruct Git, and so run in `document-git` when `DURABLE=true` (§9.1). */
export type DocumentGitOperation = DocumentGitPayload["op"];

/**
 * The trusted context of a document-git job; written only inside the encrypted input object. Git
 * work reaches the durable task on behalf of an MCP grant (§14.6) — the only agent caller left now
 * that chat runs on the desktop (note 18) — so the job carries the grant it was authorized under and
 * nothing the caller could restate at execution time.
 */
export interface DocumentGitJobActor {
  /** Groups the job objects of one call: `u/<ownerId>/jobs/<runId>/<toolCallId>` (§8.3). */
  readonly runId: string;
  readonly toolCallId: string;
  readonly grantId: string;
  /** The grant generation the call was authorized under; re-scoping the grant fences the job. */
  readonly grantGeneration: number;
  readonly scopes: readonly string[];
  /** The grant's task scope, or null for every task. */
  readonly taskIds: readonly string[] | null;
  /** A request id unique per MCP call, for publication idempotency (§9.2). */
  readonly requestId: string;
  /** The executor generation the caller was authorized under; writes are guarded by it (§8.1). */
  readonly executorGeneration: number;
}

/** The plaintext of `u/<ownerId>/jobs/<runId>/<toolCallId>.in.sym` (§8.3). */
export interface DocumentGitJobInput {
  readonly v: 1;
  readonly op: DocumentGitOperation;
  readonly actor: DocumentGitJobActor;
  readonly args: unknown;
  /** Bytes the turn may still retrieve (diffs draw from the per-turn budget). */
  readonly remainingBudgetBytes: number;
}

/** The plaintext of the `.out.sym` job object. */
export type DocumentGitJobOutput =
  | { readonly v: 1; readonly ok: true; readonly result: unknown; readonly retrievedBytes: number }
  | {
      readonly v: 1;
      readonly ok: false;
      readonly code: string;
      readonly details: Readonly<Record<string, string | number | boolean | null>> | null;
    };

/** The executor generation guard folded into job writes (§8.1). */
export function executorGenerationGuard(generation: number): SqlGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND generation = CAST(:doc_executor_generation AS INTEGER))",
    params: { doc_executor_generation: int(generation) },
  };
}

function budgetOf(bytes: number): RetrievalBudget {
  let consumed = 0;
  return {
    remaining: () => Math.max(0, bytes - consumed),
    consume: (amount) => {
      consumed += Math.max(0, Math.trunc(amount));
    },
    get consumedBytes() {
      return consumed;
    },
  };
}

/**
 * The grant must still authorize this exact task when the job's write lands, not merely when the
 * call was accepted: a job object outlives the request that wrote it, so revocation, expiry and
 * re-scoping have to be re-read from D1 inside the deciding batch.
 */
function grantGuard(
  ownerId: string,
  actor: DocumentGitJobActor,
  taskId: string,
  op: DocumentGitOperation,
  now: number,
): SqlGuard {
  const writes = op === "update_section" || op === "restore";
  return mcpAuthorization(
    { id: actor.grantId, ownerId, generation: actor.grantGeneration },
    writes ? "tasks:write" : "tasks:read",
    now,
    [taskId],
  );
}

/**
 * Runs one Git-backed document tool operation. The same function serves the in-process path
 * (`DURABLE=false`) and the `document-git` task, so both executors behave identically (§9.1).
 */
export async function executeDocumentGitOperation(
  tools: DocumentTools,
  actor: AgentDocumentActor,
  op: DocumentGitOperation,
  args: unknown,
  budget?: RetrievalBudget,
): Promise<unknown> {
  switch (op) {
    case "update_section": {
      const input = taskDocumentUpdateSectionInputSchema.parse(args);
      return tools.updateSection(actor, {
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        placement: input.placement,
        markdown: input.markdown,
        ...(input.sectionId ? { sectionId: input.sectionId } : {}),
      });
    }
    case "diff": {
      const input = taskDocumentDiffInputSchema.parse(args);
      return tools.diff(
        actor,
        {
          taskId: input.taskId,
          baseRevision: input.baseRevision,
          ...(input.targetRevision ? { targetRevision: input.targetRevision } : {}),
          ...(input.sectionIds ? { sectionIds: input.sectionIds } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
        },
        budget ? { budget } : {},
      );
    }
    case "history": {
      const input = taskDocumentHistoryInputSchema.parse(args);
      return tools.history(actor, {
        taskId: input.taskId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });
    }
    case "restore": {
      const input = taskDocumentRestoreInputSchema.parse(args);
      return tools.restore(actor, input);
    }
  }
}

function jobRef(
  ownerId: string,
  payload: Pick<DocumentGitPayload, "runId" | "toolCallId">,
  direction: "in" | "out",
): JobRef {
  return { ownerId, runId: payload.runId, toolCallId: payload.toolCallId, direction };
}

/** Starts a Trigger task and waits for it (`tasks.triggerAndWait`). */
export type TriggerAndWait = (
  taskId: typeof DOCUMENT_GIT_TASK_ID,
  payload: DocumentGitPayload,
  options: { readonly idempotencyKey: string },
) => Promise<{ readonly ok: boolean }>;

/**
 * The caller's side of a durable document-git call (§9.1): the operation input goes into an encrypted
 * job object, the ids-only payload is triggered with `idempotencyKey` = the tool call id, and the
 * result comes back from the encrypted output object. Both objects are deleted afterwards; the hourly sweep
 * removes any left by a crash (§8.3).
 */
export class DurableDocumentGit {
  constructor(
    private readonly options: {
      readonly artifacts: DocumentArtifacts;
      readonly triggerAndWait: TriggerAndWait;
      readonly now: () => number;
    },
  ) {}

  async run(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly accountKey: AccountDataKey;
    readonly actor: DocumentGitJobActor;
    readonly op: DocumentGitOperation;
    readonly args: unknown;
    readonly remainingBudgetBytes: number;
  }): Promise<{ readonly result: unknown; readonly retrievedBytes: number }> {
    const payload = documentGitPayloadSchema.parse({
      runId: input.actor.runId,
      toolCallId: input.actor.toolCallId,
      taskId: input.taskId,
      op: input.op,
    });
    const { artifacts } = this.options;
    const jobInput: DocumentGitJobInput = {
      v: 1,
      op: input.op,
      actor: input.actor,
      args: input.args,
      remainingBudgetBytes: input.remainingBudgetBytes,
    };
    await artifacts.putJob(
      input.accountKey,
      jobRef(input.ownerId, payload, "in"),
      jobInput,
      uuidv7(this.options.now()),
    );
    try {
      const run = await this.options.triggerAndWait(DOCUMENT_GIT_TASK_ID, payload, {
        idempotencyKey: payload.toolCallId,
      });
      const output = (await artifacts.getJob(
        input.accountKey,
        jobRef(input.ownerId, payload, "out"),
      )) as DocumentGitJobOutput | null;
      if (output?.v !== 1) {
        throw new DocumentError(
          run.ok ? "document.integrity_failed" : "rate.limited",
          run.ok ? {} : { retryAfter: 5 },
        );
      }
      if (!output.ok) {
        throw new DocumentError(
          output.code as never,
          output.details ? { details: output.details } : {},
        );
      }
      return { result: output.result, retrievedBytes: output.retrievedBytes };
    } finally {
      await artifacts.deleteJob(jobRef(input.ownerId, payload, "in"));
      await artifacts.deleteJob(jobRef(input.ownerId, payload, "out"));
    }
  }
}

/** Failures a later attempt can overcome; the task rethrows them so Trigger retries (§8.8). */
function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === "rate.limited" ||
    code === "db.unavailable" ||
    code === "db.unknown_outcome" ||
    code === "git.busy" ||
    code === "git.timeout" ||
    code === "git.unavailable" ||
    (typeof code === "string" && code.startsWith("storage.") && code !== "storage.invalid_key")
  );
}

/**
 * The `document-git` task body (§8.8, §9.1): resolve the owner from the task, read and check the
 * encrypted input (its job group and tool call must match the payload), run the operation with the
 * input's trusted actor, its grant guard and the executor generation guard, and write the encrypted
 * output. A completed output is reused on a retried attempt, and publications are idempotent by
 * request id, so a retry never publishes twice. Returns ids and codes only.
 */
export async function runDocumentGitJob(input: {
  readonly payload: unknown;
  readonly db: DbClient;
  readonly accountKeys: AccountKeyStore;
  readonly artifacts: DocumentArtifacts;
  readonly tools: DocumentTools;
  readonly now: () => number;
}): Promise<{ readonly status: "completed" | "failed"; readonly code: string | null }> {
  const parsed = documentGitPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return { status: "failed", code: "document_git.payload_invalid" };
  const payload = parsed.data;
  const task = await input.db.first(
    sql(`SELECT owner_id FROM tasks WHERE id = :task`, { task: payload.taskId }),
  );
  if (!task) return { status: "failed", code: "not_found" };
  const ownerId = task.owner_id as string;
  const accountKey = await input.accountKeys.load(ownerId);
  if (!accountKey) return { status: "failed", code: "not_found" };
  try {
    const existing = await input.artifacts.getJob(accountKey, jobRef(ownerId, payload, "out"));
    if (existing) {
      const output = existing as DocumentGitJobOutput;
      return { status: output.ok ? "completed" : "failed", code: output.ok ? null : output.code };
    }
    let jobInput: DocumentGitJobInput | null;
    try {
      jobInput = (await input.artifacts.getJob(
        accountKey,
        jobRef(ownerId, payload, "in"),
      )) as DocumentGitJobInput | null;
    } catch {
      return { status: "failed", code: "document.integrity_failed" };
    }
    if (
      jobInput?.v !== 1 ||
      jobInput.op !== payload.op ||
      jobInput.actor?.runId !== payload.runId ||
      jobInput.actor?.toolCallId !== payload.toolCallId ||
      typeof jobInput.actor.grantId !== "string" ||
      typeof jobInput.actor.requestId !== "string" ||
      jobInput.actor.requestId.length === 0 ||
      !Number.isSafeInteger(jobInput.actor.executorGeneration) ||
      !Number.isSafeInteger(jobInput.actor.grantGeneration) ||
      jobInput.actor.grantGeneration < 1 ||
      !Array.isArray(jobInput.actor.scopes) ||
      jobInput.actor.scopes.some((scope) => typeof scope !== "string") ||
      (jobInput.actor.taskIds !== null &&
        (!Array.isArray(jobInput.actor.taskIds) ||
          jobInput.actor.taskIds.some((taskId) => typeof taskId !== "string"))) ||
      !Number.isSafeInteger(jobInput.remainingBudgetBytes) ||
      jobInput.remainingBudgetBytes < 0 ||
      jobInput.remainingBudgetBytes > 96_000 ||
      (jobInput.args as { taskId?: unknown } | null)?.taskId !== payload.taskId
    ) {
      return { status: "failed", code: "document_git.input_invalid" };
    }
    const claimGuard = grantGuard(ownerId, jobInput.actor, payload.taskId, payload.op, input.now());
    const actor: McpDocumentActor = {
      kind: "mcp",
      userId: ownerId,
      grantId: jobInput.actor.grantId,
      scopes: jobInput.actor.scopes,
      taskIds: jobInput.actor.taskIds,
      requestId: jobInput.actor.requestId,
      guards: [executorGenerationGuard(jobInput.actor.executorGeneration), claimGuard],
    };
    const budget = budgetOf(jobInput.remainingBudgetBytes);
    let output: DocumentGitJobOutput;
    try {
      if (
        !(await input.db.first(sql(`SELECT 1 AS live WHERE ${claimGuard.sql}`, claimGuard.params)))
      )
        throw new DocumentError("document.read_only");
      const result = await executeDocumentGitOperation(
        input.tools,
        actor,
        payload.op,
        jobInput.args,
        budget,
      );
      output = { v: 1, ok: true, result, retrievedBytes: budget.consumedBytes };
    } catch (error) {
      if (isRetryable(error)) throw error;
      if (isDocumentError(error)) {
        output = { v: 1, ok: false, code: error.code, details: error.details ?? null };
      } else if (error instanceof DocumentAccessDeniedError) {
        output = { v: 1, ok: false, code: error.code, details: null };
      } else if ((error as { name?: unknown } | null)?.name === "ZodError") {
        output = { v: 1, ok: false, code: "validation", details: null };
      } else {
        throw error;
      }
    }
    await input.artifacts.putJob(
      accountKey,
      jobRef(ownerId, payload, "out"),
      output,
      uuidv7(input.now()),
    );
    return { status: output.ok ? "completed" : "failed", code: output.ok ? null : output.code };
  } finally {
    zeroize(accountKey.key);
  }
}
