import { simonApprovalDecisionSchema } from "@symplist/contracts";
import {
  type AccountDataKey,
  canonicalJson,
  computeApprovalArgsDigest,
  decryptFieldText,
  encryptFieldText,
  zeroize,
} from "@symplist/crypto";
import { type DbRow, int, type Statement, sql, uuidv7 } from "@symplist/db";
import {
  type ConfirmedConnection,
  confirmedConnection,
  confirmedConnectionGuard,
} from "../connections/authority.ts";
import { continuationStatements, pauseGuard } from "./continuations.ts";
import { type SimonRepository, simonField } from "./repository.ts";
import { SimonError, type SimonRun } from "./types.ts";

export const APPROVAL_TTL_MS = 24 * 3_600_000;
export interface ApprovalProposal {
  readonly toolCallId: string;
  readonly toolSlug: string;
  readonly connection: ConfirmedConnection;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly preview: Readonly<Record<string, unknown>>;
  readonly policyVersion: string;
}

export interface ApprovalView {
  readonly id: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolSlug: string;
  readonly connectionId: string;
  readonly connectedAccountId: string;
  readonly connectionGeneration: number;
  readonly status: "pending" | "approved" | "denied" | "dismissed" | "expired" | "superseded";
  readonly argDigest: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly preview: Readonly<Record<string, unknown>>;
  readonly expiresAt: number;
  readonly policyVersion: string;
}

/** The tool catalogue validates edits and reruns policy; the model never supplies this validator. */
export type ApprovalEditValidator = (input: {
  readonly approval: ApprovalView;
  readonly editedArguments: Readonly<Record<string, unknown>>;
}) => Promise<Pick<ApprovalProposal, "arguments" | "preview" | "policyVersion">>;

export class SimonApprovals {
  constructor(readonly repository: SimonRepository) {}

  private insert(
    id: string,
    run: SimonRun,
    key: AccountDataKey,
    proposal: ApprovalProposal,
    now: number,
    writeId: string,
    guard: { readonly sql: string; readonly params: Readonly<Record<string, string>> },
    supersedesId: string | null = null,
  ): Statement {
    return sql(
      `INSERT INTO approvals (id, owner_id, conversation_id, task_id, run_id, tool_call_id, tool_slug,
      connection_id, connected_account_id, connection_generation, arguments_enc, arg_digest, preview_enc,
      policy_version, expires_at, supersedes_id, created_at, write_id)
      SELECT :id, :owner, :conversation, :task, :run, :call, :slug, :connection, :account, :generation,
      :arguments, :digest, :preview, :policy, :expiry, :supersedes, :now, :w WHERE ${guard.sql}`,
      {
        id,
        owner: run.ownerId,
        conversation: run.conversationId,
        task: run.taskId,
        run: run.id,
        call: proposal.toolCallId,
        slug: proposal.toolSlug,
        connection: proposal.connection.id,
        account: proposal.connection.connectedAccountId,
        generation: int(proposal.connection.generation),
        arguments: encryptFieldText(
          key,
          simonField(run.ownerId, "approvals", id, "arguments_enc"),
          canonicalJson(proposal.arguments),
        ),
        digest: computeApprovalArgsDigest(key, {
          toolSlug: proposal.toolSlug,
          connectedAccountId: proposal.connection.connectedAccountId,
          arguments: proposal.arguments,
        }),
        preview: encryptFieldText(
          key,
          simonField(run.ownerId, "approvals", id, "preview_enc"),
          canonicalJson(proposal.preview),
        ),
        policy: proposal.policyVersion,
        expiry: int(now + APPROVAL_TTL_MS),
        supersedes: supersedesId,
        now: int(now),
        w: writeId,
        ...guard.params,
      },
    );
  }

  /** A pending action and the assistant checkpoint become visible together, never before commit. */
  async pause(
    run: SimonRun,
    key: AccountDataKey,
    proposal: ApprovalProposal,
    checkpoint: { text: string; steps: number },
  ): Promise<string> {
    if (proposal.connection.ownerId !== run.ownerId) throw new SimonError("not_found");
    const now = this.repository.options.now();
    const id = uuidv7(now);
    const writeId = uuidv7(now);
    const result = await this.repository.options.db.batch(
      this.repository.checkpointStatements(
        run,
        key,
        checkpoint.text,
        checkpoint.steps,
        "awaiting_approval",
        {
          now,
          writeId,
          guard: confirmedConnectionGuard(proposal.connection),
          statements: [
            this.insert(id, run, key, proposal, now, writeId, {
              sql: "EXISTS (SELECT 1 FROM runs WHERE id = :paused_run AND write_id = :paused_write)",
              params: { paused_run: run.id, paused_write: writeId },
            }),
          ],
        },
      ),
    );
    if (!result.at(-1)?.results[0]) throw new SimonError("simon.stale");
    return id;
  }

  private decode(row: DbRow, key: AccountDataKey): ApprovalView {
    const field = (column: string) =>
      JSON.parse(
        decryptFieldText(
          key,
          simonField(String(row.owner_id), "approvals", String(row.id), column),
          String(row[column]),
        ),
      ) as Readonly<Record<string, unknown>>;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      toolCallId: String(row.tool_call_id),
      toolSlug: String(row.tool_slug),
      connectionId: String(row.connection_id),
      connectedAccountId: String(row.connected_account_id),
      connectionGeneration: Number(row.connection_generation ?? 1),
      status: row.status as ApprovalView["status"],
      argDigest: String(row.arg_digest),
      arguments: field("arguments_enc"),
      preview: field("preview_enc"),
      expiresAt: Number(row.expires_at),
      policyVersion: String(row.policy_version),
    };
  }

  async load(ownerId: string, approvalId: string): Promise<ApprovalView> {
    const { db } = this.repository.options;
    const results = await db.batch([
      sql(
        `SELECT * FROM approvals WHERE id = :id AND owner_id = :owner AND ${this.repository.access()}`,
        { id: approvalId, owner: ownerId },
      ),
      this.repository.accountKeys.selectStatement(ownerId),
    ]);
    const row = results[0]?.results[0];
    const keyRow = results[1]?.results[0];
    if (!row || !keyRow) throw new SimonError("not_found");
    const key = this.repository.accountKeys.unwrapRow(keyRow);
    try {
      return this.decode(row, key);
    } finally {
      zeroize(key.key);
    }
  }

  async decide(
    ownerId: string,
    approvalId: string,
    input: typeof simonApprovalDecisionSchema._input,
    validateEdit?: ApprovalEditValidator,
  ): Promise<{ approvalId: string; runId: string; status: ApprovalView["status"] }> {
    const decision = simonApprovalDecisionSchema.parse(input);
    const approval = await this.load(ownerId, approvalId);
    const run = await this.repository.run(ownerId, approval.runId);
    if (!run) throw new SimonError("not_found");
    const edited = decision.editedArguments !== undefined;
    if (edited && (decision.decision !== "approve" || !validateEdit))
      throw new SimonError("validation");
    if (
      approval.status !== "pending" ||
      approval.expiresAt <= this.repository.options.now() ||
      approval.argDigest !== decision.argDigest
    )
      throw new SimonError("approval.stale");
    const validated =
      edited && validateEdit
        ? await validateEdit({ approval, editedArguments: decision.editedArguments ?? {} })
        : null;
    const connection = validated
      ? await confirmedConnection(this.repository.options.db, ownerId, approval.connectionId)
      : null;
    if (
      validated &&
      (!connection ||
        connection.connectedAccountId !== approval.connectedAccountId ||
        connection.generation !== approval.connectionGeneration)
    )
      throw new SimonError("approval.stale");
    const now = this.repository.options.now();
    const writeId = uuidv7(now);
    const nextId = uuidv7(now);
    const status = validated
      ? "superseded"
      : decision.decision === "approve"
        ? "approved"
        : decision.decision === "deny"
          ? "denied"
          : "dismissed";
    const changeGuard = connection ? confirmedConnectionGuard(connection) : null;
    const statements: Statement[] = [
      sql(
        `UPDATE approvals SET status = :status, decided_at = :now, write_id = :w
      WHERE id = :id AND owner_id = :owner AND status = 'pending' AND expires_at > :now AND arg_digest = :digest
      AND ${this.repository.access()} AND ${pauseGuard(this.repository, "approvals")}
      ${changeGuard ? `AND ${changeGuard.sql}` : ""}`,
        {
          id: approvalId,
          owner: ownerId,
          status,
          now: int(now),
          w: writeId,
          digest: decision.argDigest,
          ...changeGuard?.params,
        },
      ),
    ];
    if (validated && connection) {
      const key = await this.repository.accountKeys.require(ownerId);
      try {
        statements.push(
          this.insert(
            nextId,
            run,
            key,
            {
              ...validated,
              connection,
              toolCallId: approval.toolCallId,
              toolSlug: approval.toolSlug,
            },
            now,
            writeId,
            {
              sql: "EXISTS (SELECT 1 FROM approvals WHERE id = :previous AND owner_id = :previous_owner AND write_id = :previous_write)",
              params: { previous: approvalId, previous_owner: ownerId, previous_write: writeId },
            },
            approvalId,
          ),
        );
      } finally {
        zeroize(key.key);
      }
    } else {
      statements.push(
        ...continuationStatements(this.repository, {
          table: "approvals",
          pauseId: approvalId,
          ownerId,
          runId: run.id,
          nextRunId: nextId,
          writeId,
          now,
        }),
      );
    }
    statements.push(
      sql("SELECT id FROM approvals WHERE id = :id AND owner_id = :owner AND write_id = :w", {
        id: approvalId,
        owner: ownerId,
        w: writeId,
      }),
    );
    const results = await this.repository.options.db.batch(statements);
    if (!results.at(-1)?.results[0]) throw new SimonError("approval.stale");
    return validated
      ? { approvalId: nextId, runId: run.id, status: "pending" }
      : { approvalId, runId: nextId, status };
  }

  /** Used by the bounded sweeper and connection mutations; caller folds these into its effect batch. */
  expireStatements(input: {
    ownerId: string;
    approvalId: string;
    runId: string;
    now: number;
    cause: "time" | "connection";
    guard?: { sql: string; params: Readonly<Record<string, string>> };
  }): Statement[] {
    const writeId = uuidv7(input.now);
    const nextRunId = uuidv7(input.now);
    return [
      sql(
        `UPDATE approvals SET status = 'expired', decided_at = :now, write_id = :w WHERE id = :id AND owner_id = :owner
        AND run_id = :run AND status = 'pending' ${input.cause === "time" ? "AND expires_at <= :now" : ""}
        AND ${this.repository.access()} AND ${pauseGuard(this.repository, "approvals")}
        ${input.guard ? `AND ${input.guard.sql}` : ""}`,
        {
          id: input.approvalId,
          owner: input.ownerId,
          run: input.runId,
          now: int(input.now),
          w: writeId,
          ...input.guard?.params,
        },
      ),
      ...continuationStatements(this.repository, {
        table: "approvals",
        pauseId: input.approvalId,
        ownerId: input.ownerId,
        runId: input.runId,
        nextRunId,
        writeId,
        now: input.now,
      }),
    ];
  }
}
