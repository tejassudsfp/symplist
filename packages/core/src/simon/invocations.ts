import {
  type AccountDataKey,
  canonicalJson,
  decryptFieldText,
  encryptFieldText,
  verifyApprovalArgsDigest,
} from "@symplist/crypto";
import { type DbRow, int, sql, uuidv7 } from "@symplist/db";
import {
  type ConfirmedConnection,
  confirmedConnection,
  confirmedConnectionGuard,
} from "../connections/authority.ts";
import { type ApprovalView, SimonApprovals } from "./approvals.ts";
import { type SimonRepository, simonField } from "./repository.ts";
import { SimonError, type SimonRun } from "./types.ts";

export type InvocationOutcome =
  | { readonly status: "succeeded" | "failed"; readonly result: unknown }
  | { readonly status: "uncertain" }
  | { readonly status: "denied" | "dismissed" | "expired" };

export type ApprovedEffect = (input: {
  readonly toolSlug: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly connection: ConfirmedConnection;
  readonly idempotencyKey: string;
}) => Promise<{
  readonly status: "succeeded" | "failed";
  readonly result: unknown;
}>;

/** An intent ledger, not a lease: a started external effect is never stolen or retried (§8.4). */
export class SimonInvocations {
  constructor(readonly repository: SimonRepository) {}

  private recorded(row: DbRow, key: AccountDataKey): InvocationOutcome {
    if (row.status === "started" || row.status === "uncertain" || row.result_enc === null)
      return { status: "uncertain" };
    return {
      status: row.status as "succeeded" | "failed",
      result: JSON.parse(
        decryptFieldText(
          key,
          simonField(String(row.owner_id), "tool_invocations", String(row.id), "result_enc"),
          String(row.result_enc),
        ),
      ) as unknown,
    };
  }

  private async existing(ownerId: string, approvalId: string): Promise<DbRow | null> {
    return this.repository.options.db.first(
      sql(
        `SELECT * FROM tool_invocations WHERE owner_id = :owner
      AND idempotency_key = :key AND ${this.repository.access()}`,
        { owner: ownerId, key: approvalId },
      ),
    );
  }

  /** The caller supplies a no-retry transport. This method calls it at most once, even after a crash. */
  async executeApproved(
    run: SimonRun,
    key: AccountDataKey,
    approvalId: string,
    effect: ApprovedEffect,
  ): Promise<InvocationOutcome> {
    if (run.approvalId !== approvalId || !["continuation", "retry"].includes(run.kind))
      throw new SimonError("approval.stale");
    if (!(await this.repository.mayExecute(run))) throw new SimonError("simon.stale");
    const approval = await new SimonApprovals(this.repository).load(run.ownerId, approvalId);
    const previous = await this.existing(run.ownerId, approvalId);
    if (previous) return this.recorded(previous, key);
    if (
      approval.status === "denied" ||
      approval.status === "dismissed" ||
      approval.status === "expired"
    )
      return { status: approval.status };
    if (approval.status !== "approved") throw new SimonError("approval.stale");
    if (approval.expiresAt <= this.repository.options.now()) return { status: "expired" };
    if (
      !verifyApprovalArgsDigest(
        key,
        {
          toolSlug: approval.toolSlug,
          connectedAccountId: approval.connectedAccountId,
          arguments: approval.arguments,
        },
        approval.argDigest,
      )
    )
      throw new SimonError("approval.stale");
    const connection = await confirmedConnection(
      this.repository.options.db,
      run.ownerId,
      approval.connectionId,
    );
    if (
      !connection ||
      connection.connectedAccountId !== approval.connectedAccountId ||
      connection.generation !== approval.connectionGeneration
    )
      return { status: "expired" };
    const id = uuidv7(this.repository.options.now());
    const writeId = uuidv7(this.repository.options.now());
    const claimed = await this.claim(run, key, approval, connection, id, writeId);
    if (!claimed) {
      const recorded = await this.existing(run.ownerId, approvalId);
      if (recorded) return this.recorded(recorded, key);
      throw new SimonError("approval.stale");
    }
    let outcome: InvocationOutcome;
    try {
      // No catch can lead back here. Provider exceptions may contain all the arguments: discard them.
      outcome = await effect({
        toolSlug: approval.toolSlug,
        arguments: approval.arguments,
        connection,
        idempotencyKey: approval.id,
      });
    } catch {
      outcome = { status: "uncertain" };
    }
    try {
      const saved = await this.finish(run, key, id, writeId, outcome);
      return saved ? outcome : { status: "uncertain" };
    } catch {
      // Even an unknown checkpoint outcome must never send the action again. Re-read on retry.
      return { status: "uncertain" };
    }
  }

  private async claim(
    run: SimonRun,
    key: AccountDataKey,
    approval: ApprovalView,
    connection: ConfirmedConnection,
    id: string,
    writeId: string,
  ): Promise<boolean> {
    const now = this.repository.options.now();
    const connectionGuard = confirmedConnectionGuard(connection);
    const results = await this.repository.options.db.batch([
      sql(
        `INSERT INTO tool_invocations (id, owner_id, run_id, tool_call_id, tool_slug, connected_account_id, approval_id,
        idempotency_key, arguments_enc, status, started_at, write_id)
        SELECT :id, :owner, :run, :call, :slug, :account, :approval, :approval, :arguments, 'started', :now, :w
        WHERE EXISTS (SELECT 1 FROM runs WHERE id = :run AND owner_id = :owner AND executor_generation = :generation
          AND approval_id = :approval AND ${this.repository.runGuard()})
        AND EXISTS (SELECT 1 FROM approvals WHERE id = :approval AND owner_id = :owner AND status = 'approved'
          AND arg_digest = :digest AND expires_at > :now AND connection_id = :connection_id
          AND connected_account_id = :account AND COALESCE(connection_generation, 1) = CAST(:connection_generation AS INTEGER))
        AND ${connectionGuard.sql} ON CONFLICT (owner_id, idempotency_key) DO NOTHING`,
        {
          id,
          owner: run.ownerId,
          run: run.id,
          call: approval.toolCallId,
          slug: approval.toolSlug,
          account: approval.connectedAccountId,
          approval: approval.id,
          generation: int(run.generation),
          digest: approval.argDigest,
          arguments: encryptFieldText(
            key,
            simonField(run.ownerId, "tool_invocations", id, "arguments_enc"),
            canonicalJson(approval.arguments),
          ),
          now: int(now),
          w: writeId,
          ...connectionGuard.params,
        },
      ),
      sql(
        "SELECT id FROM tool_invocations WHERE id = :id AND owner_id = :owner AND write_id = :w",
        { id, owner: run.ownerId, w: writeId },
      ),
    ]);
    return Boolean(results[1]?.results[0]);
  }

  private async finish(
    run: SimonRun,
    key: AccountDataKey,
    id: string,
    claimWriteId: string,
    outcome: InvocationOutcome,
  ): Promise<boolean> {
    const now = this.repository.options.now();
    const writeId = uuidv7(now);
    const content =
      "result" in outcome
        ? encryptFieldText(
            key,
            simonField(run.ownerId, "tool_invocations", id, "result_enc"),
            canonicalJson(outcome.result),
          )
        : null;
    const results = await this.repository.options.db.batch([
      sql(
        `UPDATE tool_invocations SET status = :status, result_enc = :result, finished_at = :now, write_id = :w
        WHERE id = :id AND owner_id = :owner AND status = 'started' AND write_id = :claim
        AND EXISTS (SELECT 1 FROM runs WHERE id = :run AND owner_id = :owner AND executor_generation = :generation
          AND ${this.repository.runGuard().replace("cancel_requested_at IS NULL", "1 = 1")})`,
        {
          id,
          owner: run.ownerId,
          status: outcome.status,
          result: content,
          now: int(now),
          w: writeId,
          claim: claimWriteId,
          run: run.id,
          generation: int(run.generation),
        },
      ),
      sql(
        "SELECT id FROM tool_invocations WHERE id = :id AND owner_id = :owner AND write_id = :w",
        { id, owner: run.ownerId, w: writeId },
      ),
    ]);
    return Boolean(results[1]?.results[0]);
  }
}
