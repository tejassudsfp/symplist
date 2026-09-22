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
  confirmedConnectionGuard,
  connectionApprovalMode,
} from "../connections/authority.ts";
import { continuationStatements, pauseGuard } from "./continuations.ts";
import {
  assertFoldOwner,
  guardedCompletion,
  releaseUnapplied,
  type SimonWriteFold,
} from "./fold.ts";
import { type SimonRepository, simonField } from "./repository.ts";
import { runFromRow, type SimonCheckpointData, SimonError, type SimonRun } from "./types.ts";

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
  readonly connectionToolkit: string | null;
  readonly connectionAlias: string | null;
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
    checkpoint: { text: string; steps: number } & SimonCheckpointData,
    reservedId?: string,
  ): Promise<string> {
    if (proposal.connection.ownerId !== run.ownerId) throw new SimonError("not_found");
    const now = this.repository.options.now();
    const id = reservedId ?? uuidv7(now);
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
          ...checkpoint,
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
      connectionToolkit: row.display_connection_toolkit
        ? String(row.display_connection_toolkit)
        : null,
      connectionAlias: row.display_connection_alias_enc
        ? decryptFieldText(
            key,
            {
              ownerId: String(row.owner_id),
              table: "connections",
              rowId: String(row.connection_id),
              column: "alias_enc",
              purpose: "connection_alias",
            },
            String(row.display_connection_alias_enc),
          )
        : null,
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
        `SELECT a.*,c.toolkit AS display_connection_toolkit,
        c.alias_enc AS display_connection_alias_enc
        FROM approvals a LEFT JOIN connections c ON c.id=a.connection_id AND c.owner_id=a.owner_id
        WHERE a.id = :id AND a.owner_id = :owner AND ${this.repository.access()}
        AND EXISTS (SELECT 1 FROM conversations conversation WHERE conversation.id = a.conversation_id
          AND (conversation.expires_at IS NULL OR conversation.expires_at > :now))`,
        { id: approvalId, owner: ownerId, now: int(this.repository.options.now()) },
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
    fold?: SimonWriteFold,
  ): Promise<{ approvalId: string; runId: string; status: ApprovalView["status"] }> {
    assertFoldOwner(fold, ownerId);
    const decision = simonApprovalDecisionSchema.parse(input);
    const params = { id: approvalId, owner: ownerId };
    const loaded = await this.repository.options.db.batch([
      sql(
        `SELECT * FROM approvals WHERE id = :id AND owner_id = :owner AND ${this.repository.access()}`,
        params,
      ),
      sql(
        `SELECT r.* FROM runs r JOIN approvals a ON a.run_id = r.id
        WHERE a.id = :id AND a.owner_id = :owner AND r.owner_id = :owner`,
        params,
      ),
      this.repository.accountKeys.selectStatement(ownerId),
      sql(
        `SELECT c.* FROM connections c JOIN approvals a ON a.connection_id = c.id
        WHERE a.id = :id AND a.owner_id = :owner AND c.owner_id = :owner AND c.status = 'active'
        AND c.connected_account_id = a.connected_account_id
        AND c.generation = COALESCE(a.connection_generation, 1)`,
        params,
      ),
    ]);
    const approvalRow = loaded[0]?.results[0];
    const runRow = loaded[1]?.results[0];
    const keyRow = loaded[2]?.results[0];
    if (!approvalRow || !runRow || !keyRow) throw new SimonError("not_found");
    const key = this.repository.accountKeys.unwrapRow(keyRow);
    try {
      const connectionRow = loaded[3]?.results[0];
      const approval = this.decode(
        {
          ...approvalRow,
          display_connection_toolkit: connectionRow?.toolkit ?? null,
          display_connection_alias_enc: connectionRow?.alias_enc ?? null,
        },
        key,
      );
      const run = runFromRow(runRow);
      const connection: ConfirmedConnection | null = connectionRow
        ? {
            id: String(connectionRow.id),
            ownerId,
            toolkit: String(connectionRow.toolkit),
            connectedAccountId: String(connectionRow.connected_account_id),
            generation: Number(connectionRow.generation),
            approvalMode: connectionApprovalMode(connectionRow.approval_mode),
          }
        : null;
      const edited = decision.editedArguments !== undefined;
      if (edited && (decision.decision !== "approve" || !validateEdit))
        throw new SimonError("validation");
      const eligible =
        approval.status === "pending" &&
        approval.expiresAt > this.repository.options.now() &&
        approval.argDigest === decision.argDigest &&
        (decision.decision !== "approve" || connection !== null);
      if (!eligible && !fold) throw new SimonError("approval.stale");
      const validated =
        eligible && edited && validateEdit
          ? await validateEdit({ approval, editedArguments: decision.editedArguments ?? {} })
          : null;
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
      const changeGuard =
        decision.decision === "approve" && connection ? confirmedConnectionGuard(connection) : null;
      const statements: Statement[] = [
        ...(fold?.statements ?? []),
        sql(
          `UPDATE approvals SET status = :status, decided_at = :now, write_id = :w
      WHERE id = :id AND owner_id = :owner AND status = 'pending' AND expires_at > :now AND arg_digest = :digest
      AND ${this.repository.access()} AND ${pauseGuard(this.repository, "approvals")}
      AND ${eligible ? "1" : "0"}
      AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
      ${fold ? `AND ${fold.claim.guard.exists}` : ""}
      ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}
      ${changeGuard ? `AND ${changeGuard.sql}` : ""}`,
          {
            id: approvalId,
            owner: ownerId,
            status,
            now: int(now),
            w: writeId,
            digest: decision.argDigest,
            ...changeGuard?.params,
            ...fold?.claim.guard.params,
            ...fold?.authorization?.params,
          },
        ),
      ];
      if (validated && connection) {
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
      const response: { approvalId: string; runId: string; status: ApprovalView["status"] } =
        validated
          ? { approvalId: nextId, runId: run.id, status: "pending" }
          : { approvalId, runId: nextId, status };
      const applied = sql(
        "EXISTS (SELECT 1 FROM approvals WHERE id = :id AND owner_id = :owner AND write_id = :w)",
        { id: approvalId, owner: ownerId, w: writeId },
      );
      const authority = sql(
        `EXISTS (SELECT 1 FROM approvals a JOIN conversations c ON c.id = a.conversation_id
      WHERE a.id = :id AND a.owner_id = :owner AND ${this.repository.access()}
      AND ${this.repository.activeTask("c")}
      AND (c.expires_at IS NULL OR c.expires_at > :now)
      AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner))
      ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}`,
        { id: approvalId, owner: ownerId, now: int(now), ...fold?.authorization?.params },
      );
      if (fold)
        statements.push(
          releaseUnapplied(fold, applied),
          guardedCompletion(fold.completion({ status: 200, body: response }, key), applied),
        );
      statements.push({
        sql: `SELECT (${applied.sql}) AS applied, (${authority.sql}) AS allowed`,
        params: [...applied.params, ...authority.params],
      });
      const results = await this.repository.options.db.batch(statements);
      const row = results.at(-1)?.results[0];
      if (row?.allowed !== 1) throw new SimonError(fold ? "not_found" : "approval.stale");
      if (fold) {
        const outcome = fold.decide(results, key, 0);
        if (outcome.kind === "replay") return outcome.body as typeof response;
      }
      if (row.applied !== 1) throw new SimonError("approval.stale");
      return response;
    } finally {
      zeroize(key.key);
    }
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
