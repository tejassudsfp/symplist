import { decryptFieldText } from "@symplist/crypto";
import { int, sql } from "@symplist/db";
import { DocumentError, type ReceiptDraft } from "@symplist/docs";
import { authorizeActor, type SimonDocumentActor } from "../documents/actor.ts";
import { TurnRetrievalBudget } from "../documents/budgets.ts";
import {
  type DocumentGitOperation,
  type DurableDocumentGit,
  executeDocumentGitOperation,
} from "../documents/git-jobs.ts";
import type { DocumentTools } from "../documents/tools.ts";
import { taskTitleContext } from "../tasks/sql.ts";
import type { SimonRepository } from "./repository.ts";
import { type ClaimedSimonRun, type SimonCheckpointData, SimonError } from "./types.ts";

/** One claimed turn's native document capabilities; no caller-supplied identity is accepted. */
export class SimonDocumentSession {
  private readonly receipts: { toolCallId: string; receipt: ReceiptDraft }[] = [];
  private constructor(
    readonly repository: SimonRepository,
    readonly claim: ClaimedSimonRun,
    readonly tools: DocumentTools,
    readonly git: DurableDocumentGit | null,
    readonly contextEpoch: number,
    readonly budget: TurnRetrievalBudget,
  ) {}

  static async create(input: {
    repository: SimonRepository;
    claim: ClaimedSimonRun;
    tools: DocumentTools;
    /** Required in durable mode; null means the in-process Git implementation. */
    git: DurableDocumentGit | null;
  }): Promise<SimonDocumentSession> {
    if ((input.claim.run.executor === "trigger") !== (input.git !== null))
      throw new SimonError("simon.executor_mismatch");
    const { repository, claim } = input;
    const row = await repository.options.db.first(
      sql(
        `SELECT c.context_epoch, r.retrieved_bytes FROM conversations c JOIN runs r ON r.conversation_id = c.id
      WHERE r.id = :run AND r.owner_id = :owner AND EXISTS (SELECT 1 FROM runs WHERE id = :run AND executor_generation = :generation AND ${repository.runGuard()})`,
        {
          run: claim.run.id,
          owner: claim.run.ownerId,
          generation: int(claim.run.generation),
          now: int(repository.options.now()),
        },
      ),
    );
    if (!row) throw new SimonError("simon.stale");
    return new SimonDocumentSession(
      repository,
      claim,
      input.tools,
      input.git,
      Number(row.context_epoch),
      new TurnRetrievalBudget(96_000, Number(row.retrieved_bytes)),
    );
  }

  actor(toolCallId: string): SimonDocumentActor {
    const { run } = this.claim;
    const { repository } = this;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(toolCallId)) throw new SimonError("validation");
    return {
      kind: "simon",
      userId: run.ownerId,
      conversationId: run.conversationId,
      runId: run.id,
      toolCallId,
      contextEpoch: this.contextEpoch,
      mode: run.taskId ? "task" : "quick",
      taskId: run.taskId,
      // Re-read time when a core service builds its deciding batch, including after R2 work.
      get guards() {
        return [
          {
            sql: `EXISTS (SELECT 1 FROM runs WHERE id = :simon_guard_run AND owner_id = :simon_guard_owner AND executor_generation = :simon_guard_generation AND ${repository.runGuard().replaceAll(":now", ":simon_guard_now")})`,
            params: {
              simon_guard_run: run.id,
              simon_guard_owner: run.ownerId,
              simon_guard_generation: int(run.generation),
              simon_guard_now: int(repository.options.now()),
            },
          },
        ];
      },
    };
  }

  async context(taskId: string, toolCallId: string) {
    await this.assertActive();
    const row = await this.repository.options.db.first(
      sql("SELECT title_enc FROM tasks WHERE id = :task AND owner_id = :owner", {
        task: taskId,
        owner: this.claim.run.ownerId,
      }),
    );
    if (!row) throw new DocumentError("not_found");
    const title = decryptFieldText(
      this.claim.key,
      taskTitleContext(this.claim.run.ownerId, taskId),
      String(row.title_enc),
    );
    const positions = await this.tools.readPositions(this.actor(toolCallId), taskId);
    return { taskId, title, ...positions };
  }

  async assertActive(): Promise<void> {
    if (!(await this.repository.mayExecute(this.claim.run))) throw new SimonError("simon.stale");
  }

  stageReceipt(toolCallId: string, receipt: ReceiptDraft | null): void {
    if (receipt) this.receipts.push({ toolCallId, receipt });
  }

  checkpointData(
    deliveredToolCallIds: readonly string[],
  ): Pick<SimonCheckpointData, "receipts" | "retrievedBytes"> {
    const delivered = new Set(deliveredToolCallIds);
    return {
      receipts: this.receipts
        .filter((entry) => delivered.has(entry.toolCallId))
        .map((entry) => entry.receipt),
      retrievedBytes: this.budget.totalBytes,
    };
  }

  async gitOperation(
    op: DocumentGitOperation,
    args: { readonly taskId: string },
    toolCallId: string,
  ): Promise<unknown> {
    await this.assertActive();
    const actor = this.actor(toolCallId);
    authorizeActor(
      actor,
      args.taskId,
      op === "update_section" || op === "restore" ? "write" : "read",
    );
    if (!this.git) return executeDocumentGitOperation(this.tools, actor, op, args, this.budget);
    const result = await this.git.run({
      ownerId: actor.userId,
      taskId: args.taskId,
      accountKey: this.claim.key,
      actor: {
        conversationId: actor.conversationId,
        runId: actor.runId,
        toolCallId,
        contextEpoch: actor.contextEpoch,
        mode: actor.mode,
        taskId: actor.taskId,
        executorGeneration: this.claim.run.generation,
      },
      op,
      args,
      remainingBudgetBytes: this.budget.remaining(),
    });
    this.budget.consume(result.retrievedBytes);
    return result.result;
  }
}
