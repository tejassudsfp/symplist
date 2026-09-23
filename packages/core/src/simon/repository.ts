import { createHash } from "node:crypto";
import { simonMessageInputSchema } from "@symplist/contracts";
import {
  type AccountDataKey,
  canonicalJson,
  decryptFieldText,
  encryptFieldText,
  zeroize,
} from "@symplist/crypto";
import { int, type Statement, sql, uuidv7 } from "@symplist/db";
import { receiptStatement } from "@symplist/docs";
import { evaluateAccess } from "../access/evaluate.ts";
import { accessCondition, accessStateFromRow, accessStateSelectList } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";
import type { ExecutorKind } from "../events/execution.ts";
import { searchIntentStatement } from "../search/intents.ts";
import {
  assertAuthorization,
  assertFoldOwner,
  guardedCompletion,
  releaseUnapplied,
  type SimonAuthorization,
  type SimonWriteFold,
} from "./fold.ts";
import { dispatchSimonStatements, releaseSimonStatements } from "./lifecycle.ts";
import {
  type ClaimedSimonRun,
  runFromRow,
  type SimonCheckpointData,
  SimonError,
  type SimonRepositoryOptions,
  type SimonRun,
  type SimonRunStatus,
  type SimonTier,
} from "./types.ts";

export function simonField(ownerId: string, table: string, rowId: string, column: string) {
  return { ownerId, table, rowId, column, purpose: `simon_${column.replace(/_enc$/, "")}` };
}

export interface AcceptedMessage {
  readonly messageId: string;
  readonly runId: string | null;
  readonly status: "accepted" | "queued";
}

/** All persistent chat mutations share this implementation in both executors. */
export class SimonRepository {
  nextId(): string {
    return uuidv7(this.options.now());
  }

  releaseClaim(claim: ClaimedSimonRun): void {
    zeroize(claim.key.key);
  }
  readonly accountKeys: AccountKeyStore;
  constructor(readonly options: SimonRepositoryOptions) {
    this.accountKeys = new AccountKeyStore(options);
  }

  access(ownerParam = "owner"): string {
    return accessCondition({
      level: "admitted",
      policy: this.options.policy,
      userParam: ownerParam,
    });
  }

  /** Correlated against a conversations or runs row; task-less quick chats are still owner-bound. */
  activeTask(alias: string): string {
    if (alias !== "c" && alias !== "runs") throw new SimonError("internal");
    return `(${alias}.task_id IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${alias}.task_id AND t.owner_id = ${alias}.owner_id AND t.status = 'active'))`;
  }

  async createConversation(
    ownerId: string,
    taskId: string | null,
    fold?: SimonWriteFold,
  ): Promise<string> {
    assertFoldOwner(fold, ownerId);
    if (fold) return this.createFoldedConversation(ownerId, taskId, fold);
    const now = this.options.now();
    const id = uuidv7(now);
    const result = await this.options.db.batch([
      sql(
        `INSERT INTO conversations (id, owner_id, kind, task_id, expires_at, created_at, updated_at, write_id)
        SELECT :id, :owner, :kind, :task, :expiry, :now, :now, :id
        WHERE ${this.access()} AND (:task IS NULL OR EXISTS
          (SELECT 1 FROM tasks WHERE id = :task AND owner_id = :owner AND status = 'active'))
        ON CONFLICT (task_id) DO NOTHING`,
        {
          id,
          owner: ownerId,
          kind: taskId ? "task" : "quick",
          task: taskId,
          expiry: taskId ? null : int(now + this.options.quickChatTtlHours * 3_600_000),
          now: int(now),
        },
      ),
      sql(
        `SELECT id FROM conversations c WHERE owner_id = :owner AND ${this.access()} AND ${this.activeTask("c")}
        AND (id = :id OR (task_id = :task AND kind = 'task')) LIMIT 1`,
        { owner: ownerId, id, task: taskId },
      ),
    ]);
    const row = result[1]?.results[0];
    if (!row) throw new SimonError("not_found");
    return String(row.id);
  }

  private async createFoldedConversation(
    ownerId: string,
    taskId: string | null,
    fold: SimonWriteFold,
  ): Promise<string> {
    const loaded = await this.options.db.batch([
      this.accountKeys.selectStatement(ownerId),
      sql(
        "SELECT id FROM conversations WHERE owner_id = :owner AND task_id = :task AND kind = 'task'",
        { owner: ownerId, task: taskId },
      ),
    ]);
    const keyRow = loaded[0]?.results[0];
    if (!keyRow) throw new SimonError("not_found");
    const key = this.accountKeys.unwrapRow(keyRow);
    try {
      const now = this.options.now();
      const id = String(loaded[1]?.results[0]?.id ?? uuidv7(now));
      const authority = sql(
        `${this.access()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
        AND (:task IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE id = :task AND owner_id = :owner AND status = 'active'))
        ${fold.authorization ? `AND (${fold.authorization.sql})` : ""}`,
        { owner: ownerId, task: taskId, ...fold.authorization?.params },
      );
      const exists = sql(
        "EXISTS (SELECT 1 FROM conversations WHERE id = :id AND owner_id = :owner)",
        { id, owner: ownerId },
      );
      const applied = {
        sql: `(${authority.sql}) AND (${exists.sql})`,
        params: [...authority.params, ...exists.params],
      };
      const response = { conversationId: id };
      const results = await this.options.db.batch([
        ...fold.statements,
        sql(
          `INSERT INTO conversations (id, owner_id, kind, task_id, expires_at, created_at, updated_at, write_id)
          SELECT :id, :owner, :kind, :task, :expiry, :now, :now, :id
          WHERE ${this.access()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
          AND (:task IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE id = :task AND owner_id = :owner AND status = 'active'))
          AND ${fold.claim.guard.exists}
          ${fold.authorization ? `AND (${fold.authorization.sql})` : ""} ON CONFLICT DO NOTHING`,
          {
            id,
            owner: ownerId,
            kind: taskId ? "task" : "quick",
            task: taskId,
            expiry: taskId ? null : int(now + this.options.quickChatTtlHours * 3_600_000),
            now: int(now),
            ...fold.claim.guard.params,
            ...fold.authorization?.params,
          },
        ),
        releaseUnapplied(fold, applied),
        guardedCompletion(fold.completion({ status: 201, body: response }, key), applied),
        {
          sql: `SELECT (${authority.sql}) AS allowed, (${exists.sql}) AS applied`,
          params: [...authority.params, ...exists.params],
        },
      ]);
      if (results.at(-1)?.results[0]?.allowed !== 1) throw new SimonError("not_found");
      const decision = fold.decide(results, key, 0);
      if (decision.kind === "replay") return (decision.body as typeof response).conversationId;
      if (results.at(-1)?.results[0]?.applied !== 1) throw new SimonError("simon.stale");
      return id;
    } finally {
      zeroize(key.key);
    }
  }

  async loadConversation(
    ownerId: string,
    conversationId: string,
    write = false,
    requestId?: string,
  ) {
    const result = await this.options.db.batch([
      sql(
        `SELECT c.*, t.status AS task_status, ${accessStateSelectList("u", "u_")}
        FROM conversations c JOIN users u ON u.id = c.owner_id LEFT JOIN tasks t ON t.id = c.task_id
        WHERE c.id = :id AND c.owner_id = :owner`,
        { id: conversationId, owner: ownerId },
      ),
      this.accountKeys.selectStatement(ownerId),
      ...(requestId === undefined
        ? []
        : [
            sql(
              `SELECT * FROM messages WHERE conversation_id = :conversation AND owner_id = :owner AND request_id = :request`,
              { conversation: conversationId, owner: ownerId, request: requestId },
            ),
          ]),
    ]);
    const row = result[0]?.results[0];
    if (!row) throw new SimonError("not_found");
    const access = evaluateAccess(accessStateFromRow(row, "u_"), "admitted", this.options.policy);
    if (!access.allowed) throw new SimonError(access.code);
    if (write && row.task_id !== null && row.task_status !== "active")
      throw new SimonError("task.archived");
    if (row.expires_at !== null && Number(row.expires_at) <= this.options.now())
      throw new SimonError("simon.conversation_expired");
    const keyRow = result[1]?.results[0];
    if (!keyRow) throw new SimonError("not_found");
    return { row, key: this.accountKeys.unwrapRow(keyRow), existingMessage: result[2]?.results[0] };
  }

  /** A repeated request is reconciled by its encrypted fingerprint, never by plaintext content. */
  async acceptMessage(
    ownerId: string,
    conversationId: string,
    requestId: string,
    input: { text: string; tier: SimonTier },
    fold?: SimonWriteFold,
  ): Promise<AcceptedMessage> {
    assertFoldOwner(fold, ownerId);
    const parsed = simonMessageInputSchema.parse(input);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw new SimonError("validation");
    const loaded = await this.loadConversation(
      ownerId,
      conversationId,
      true,
      fold ? requestId : undefined,
    );
    try {
      const now = this.options.now();
      const messageId = uuidv7(now);
      const runId = uuidv7(now);
      const writeId = uuidv7(now);
      const fingerprint = createHash("sha256").update(canonicalJson(parsed)).digest("hex");
      const existing = loaded.existingMessage;
      if (
        existing &&
        decryptFieldText(
          loaded.key,
          simonField(ownerId, "messages", String(existing.id), "request_fingerprint_enc"),
          String(existing.request_fingerprint_enc),
        ) !== fingerprint
      )
        throw new SimonError("idempotency.mismatch");
      const content = encryptFieldText(
        loaded.key,
        simonField(ownerId, "messages", messageId, "content_enc"),
        parsed.text,
      );
      const fingerprintEnc = encryptFieldText(
        loaded.key,
        simonField(ownerId, "messages", messageId, "request_fingerprint_enc"),
        fingerprint,
      );
      const guard =
        "EXISTS (SELECT 1 FROM conversations WHERE id = :conversation AND owner_id = :owner AND write_id = :w)";
      const params = { owner: ownerId, conversation: conversationId, w: writeId };
      const authority = sql(
        `EXISTS (SELECT 1 FROM conversations c WHERE c.id = :conversation
        AND c.owner_id = :owner AND ${this.access()} AND ${this.activeTask("c")}
        AND (c.expires_at IS NULL OR c.expires_at > :now)
        AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner))
        ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}`,
        {
          conversation: conversationId,
          owner: ownerId,
          now: int(now),
          ...fold?.authorization?.params,
        },
      );
      const completions: Statement[] = [];
      if (fold) {
        const alternatives: { body: AcceptedMessage; condition: Statement }[] = [
          {
            body: { messageId, runId, status: "accepted" },
            condition: sql(
              `EXISTS (SELECT 1 FROM messages WHERE id = :id AND write_id = :w AND status = 'accepted')`,
              { id: messageId, w: writeId },
            ),
          },
          {
            body: { messageId, runId: null, status: "queued" },
            condition: sql(
              `EXISTS (SELECT 1 FROM messages WHERE id = :id AND write_id = :w AND status = 'queued')`,
              { id: messageId, w: writeId },
            ),
          },
        ];
        if (existing)
          alternatives.push({
            body: {
              messageId: String(existing.id),
              runId: existing.run_id as string | null,
              status: existing.status === "queued" ? "queued" : "accepted",
            },
            condition: sql(
              `EXISTS (SELECT 1 FROM messages WHERE id = :id AND owner_id = :owner
            AND request_fingerprint_enc = :fingerprint AND run_id IS :run AND status = :status)`,
              {
                id: String(existing.id),
                owner: ownerId,
                fingerprint: String(existing.request_fingerprint_enc),
                run: existing.run_id as string | null,
                status: String(existing.status),
              },
            ),
          });
        const applied = {
          sql: `(${alternatives.map(({ condition }) => condition.sql).join(" OR ")}) AND (${authority.sql})`,
          params: [
            ...alternatives.flatMap(({ condition }) => condition.params),
            ...authority.params,
          ],
        };
        completions.push(releaseUnapplied(fold, applied));
        for (const alternative of alternatives)
          completions.push(
            guardedCompletion(
              fold.completion({ status: 202, body: alternative.body }, loaded.key),
              {
                sql: `(${alternative.condition.sql}) AND (${authority.sql})`,
                params: [...alternative.condition.params, ...authority.params],
              },
            ),
          );
      }
      const result = await this.options.db.batch([
        ...(fold?.statements ?? []),
        sql(
          `UPDATE conversations AS c SET active_run_id = COALESCE(active_run_id, :run),
          next_message_seq = next_message_seq + 1, updated_at = :now, write_id = :w,
          expires_at = CASE WHEN kind = 'quick' THEN :expiry ELSE NULL END
          WHERE id = :conversation AND owner_id = :owner AND ${this.access()} AND ${this.activeTask("c")}
          AND (expires_at IS NULL OR expires_at > :now)
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
          ${fold ? `AND ${fold.claim.guard.exists}` : ""}
          ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}
          AND EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = :conversation AND request_id = :request)
          AND (SELECT COUNT(*) FROM messages WHERE conversation_id = :conversation AND status = 'queued') < 20`,
          {
            ...params,
            ...(fold?.claim.guard.params ?? {}),
            ...fold?.authorization?.params,
            run: runId,
            now: int(now),
            expiry: int(now + this.options.quickChatTtlHours * 3_600_000),
            request: requestId,
          },
        ),
        sql(
          `INSERT INTO runs (id, owner_id, conversation_id, task_id, kind, executor, executor_generation, tier, created_at, write_id)
          SELECT :run, :owner, c.id, c.task_id, 'turn', CASE e.mode WHEN 'durable' THEN 'trigger' ELSE 'local' END,
          e.generation, :tier, :now, :w FROM conversations c CROSS JOIN executor_state e
          WHERE c.id = :conversation AND c.active_run_id = :run AND e.id = 1 AND ${guard}`,
          {
            ...params,
            run: runId,
            tier: parsed.tier,
            now: int(now),
          },
        ),
        sql(
          `INSERT INTO messages (id, owner_id, conversation_id, run_id, request_id, seq, role, status, tier,
          content_enc, request_fingerprint_enc, created_at, write_id)
          SELECT :message, :owner, c.id, CASE WHEN c.active_run_id = :run THEN :run ELSE NULL END,
          :request, c.next_message_seq, 'user', CASE WHEN c.active_run_id = :run THEN 'accepted' ELSE 'queued' END,
          :tier, :content, :fingerprint, :now, :w FROM conversations c WHERE c.id = :conversation AND ${guard}`,
          {
            ...params,
            message: messageId,
            run: runId,
            request: requestId,
            tier: parsed.tier,
            content,
            fingerprint: fingerprintEnc,
            now: int(now),
          },
        ),
        searchIntentStatement(
          {
            ownerId,
            entity: "message",
            entityId: messageId,
            revisionOrSeq: 0,
            op: "upsert",
            now,
          },
          {
            exists:
              "EXISTS (SELECT 1 FROM messages WHERE id = :simon_message_intent AND owner_id = :simon_message_owner AND write_id = :w)",
            params: { simon_message_intent: messageId, simon_message_owner: ownerId, w: writeId },
          },
        ),
        ...this.dispatchStatements(runId, now),
        ...completions,
        ...(fold
          ? [
              sql(
                `SELECT 1 AS completed FROM idempotency_records WHERE scope = :idem_scope
          AND user_id = :idem_user AND key = :idem_key AND write_id = :idem_write_id AND status = 'completed'`,
                fold.claim.guard.params,
              ),
            ]
          : []),
        { sql: `SELECT (${authority.sql}) AS allowed`, params: authority.params },
        sql(
          `SELECT * FROM messages WHERE conversation_id = :conversation AND owner_id = :owner AND request_id = :request
          AND ${this.access()}`,
          { owner: ownerId, conversation: conversationId, request: requestId },
        ),
      ]);
      if (result.at(-2)?.results[0]?.allowed !== 1) throw new SimonError("simon.stale");
      if (fold) {
        const decision = fold.decide(result, loaded.key, 0);
        if (decision.kind === "replay") return decision.body as AcceptedMessage;
        if (result.at(-3)?.results[0]?.completed !== 1) throw new SimonError("simon.stale");
      }
      const row = result.at(-1)?.results[0];
      if (!row) throw new SimonError("simon.stale");
      if (
        decryptFieldText(
          loaded.key,
          simonField(ownerId, "messages", String(row.id), "request_fingerprint_enc"),
          String(row.request_fingerprint_enc),
        ) !== fingerprint
      ) {
        throw new SimonError("idempotency.mismatch");
      }
      return {
        messageId: String(row.id),
        runId: row.run_id as string | null,
        status: row.status === "queued" ? "queued" : "accepted",
      };
    } finally {
      zeroize(loaded.key.key);
    }
  }

  dispatchStatements(runId: string, now: number): Statement[] {
    return dispatchSimonStatements(runId, now);
  }

  /** Conditional queued → running is the only entry to execution. A duplicate delivery does nothing. */
  async claim(runId: string, executor: ExecutorKind): Promise<ClaimedSimonRun | null> {
    const now = this.options.now();
    const writeId = uuidv7(now);
    const result = await this.options.db.batch([
      sql(
        `UPDATE runs SET status = 'running', started_at = :now, heartbeat_at = :now, write_id = :w
        WHERE id = :run AND status = 'queued' AND executor = :executor AND cancel_requested_at IS NULL
        AND ${this.activeTask("runs")} AND ${this.accessForRun}
        AND EXISTS (SELECT 1 FROM account_keys k WHERE k.owner_id = runs.owner_id)
        AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = runs.conversation_id AND c.active_run_id = runs.id
          AND (c.expires_at IS NULL OR c.expires_at > :now))
        AND EXISTS (SELECT 1 FROM executor_state e WHERE e.id = 1 AND e.generation = runs.executor_generation
          AND e.mode = :mode)`,
        {
          run: runId,
          executor,
          mode: executor === "trigger" ? "durable" : "local",
          now: int(now),
          w: writeId,
        },
      ),
      sql(
        `SELECT r.*, k.kek_version, k.wrapped_key FROM runs r JOIN account_keys k ON k.owner_id = r.owner_id
        WHERE r.id = :run AND r.write_id = :w`,
        { run: runId, w: writeId },
      ),
    ]);
    const row = result[1]?.results[0];
    return row ? { run: runFromRow(row), key: this.accountKeys.unwrapRow(row) } : null;
  }

  private get accessForRun(): string {
    return this.access("simon_owner").replaceAll(":simon_owner", "runs.owner_id");
  }

  /** Fencing is in each deciding write, not just the turn's initial read. */
  runGuard(): string {
    return `status = 'running' AND cancel_requested_at IS NULL AND ${this.activeTask("runs")}
      AND ${this.accessForRun} AND EXISTS (SELECT 1 FROM executor_state e WHERE e.id = 1
      AND e.generation = runs.executor_generation AND e.mode = CASE runs.executor WHEN 'trigger' THEN 'durable' ELSE 'local' END)
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = runs.conversation_id AND c.active_run_id = runs.id
        AND (c.expires_at IS NULL OR c.expires_at > :now))`;
  }

  async mayExecute(run: SimonRun): Promise<boolean> {
    return Boolean(
      await this.options.db.first(
        sql(
          `SELECT id FROM runs WHERE id = :run
      AND owner_id = :owner AND executor_generation = :generation AND ${this.runGuard()}`,
          {
            run: run.id,
            owner: run.ownerId,
            generation: int(run.generation),
            now: int(this.options.now()),
          },
        ),
      ),
    );
  }

  async history(ownerId: string, conversationId: string, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new SimonError("validation");
    const { key } = await this.loadConversation(ownerId, conversationId);
    try {
      const rows = await this.options.db.all(
        sql(
          `SELECT * FROM messages WHERE conversation_id = :conversation
        AND owner_id = :owner AND ${this.access()} ORDER BY seq DESC LIMIT :limit`,
          {
            owner: ownerId,
            conversation: conversationId,
            limit: int(limit),
          },
        ),
      );
      return [...rows].reverse().map((row) => ({
        id: String(row.id),
        seq: Number(row.seq),
        role: row.role as "user" | "assistant" | "tool",
        status: String(row.status),
        runId: row.run_id as string | null,
        text: decryptFieldText(
          key,
          simonField(ownerId, "messages", String(row.id), "content_enc"),
          String(row.content_enc),
        ),
      }));
    } finally {
      zeroize(key.key);
    }
  }

  /** Step checkpoints replace one encrypted assistant snapshot, without writes per token. */
  async checkpoint(
    run: SimonRun,
    key: AccountDataKey,
    text: string,
    steps: number,
    status: SimonRunStatus = "running",
    data?: SimonCheckpointData,
  ): Promise<boolean> {
    const result = await this.options.db.batch(
      this.checkpointStatements(
        run,
        key,
        text,
        steps,
        status,
        data
          ? {
              now: this.options.now(),
              writeId: uuidv7(this.options.now()),
              statements: [],
              ...data,
            }
          : undefined,
      ),
    );
    return Boolean(result.at(-1)?.results[0]);
  }

  /** Pause services fold the pending approval/question into the same checkpoint batch. */
  checkpointStatements(
    run: SimonRun,
    key: AccountDataKey,
    text: string,
    steps: number,
    status: SimonRunStatus,
    extra?: SimonCheckpointData & {
      readonly writeId: string;
      readonly now: number;
      readonly guard?: { readonly sql: string; readonly params: Readonly<Record<string, string>> };
      readonly statements: readonly Statement[];
    },
  ): Statement[] {
    if (
      !Number.isSafeInteger(steps) ||
      steps < 0 ||
      steps > 10 ||
      ![
        "running",
        "completed",
        "failed",
        "stopped",
        "interrupted",
        "awaiting_approval",
        "awaiting_user",
      ].includes(status)
    )
      throw new SimonError("validation");
    if (
      (status === "awaiting_approval" || status === "awaiting_user") &&
      !extra?.statements.length
    ) {
      throw new SimonError("validation");
    }
    const now = extra?.now ?? this.options.now();
    const writeId = extra?.writeId ?? uuidv7(now);
    const messageId = run.id;
    const terminal = ["completed", "failed", "stopped", "interrupted"].includes(status);
    const guard = "EXISTS (SELECT 1 FROM runs WHERE id = :run AND write_id = :w)";
    const params = { run: run.id, w: writeId };
    const stopGuard =
      status === "stopped"
        ? this.runGuard().replace("cancel_requested_at IS NULL", "cancel_requested_at IS NOT NULL")
        : this.runGuard();
    if (extra?.snapshotJson !== undefined) {
      if (Buffer.byteLength(extra.snapshotJson) > 1_048_576) throw new SimonError("validation");
      const snapshot = JSON.parse(extra.snapshotJson) as Record<string, unknown>;
      if (snapshot.id !== run.id || snapshot.role !== "assistant" || !Array.isArray(snapshot.parts))
        throw new SimonError("validation");
    }
    const telemetry = extra?.telemetry;
    if (
      extra?.retrievedBytes !== undefined &&
      (!Number.isSafeInteger(extra.retrievedBytes) ||
        extra.retrievedBytes < 0 ||
        extra.retrievedBytes > 96_000)
    )
      throw new SimonError("validation");
    if (
      extra?.receipts &&
      (extra.receipts.length > 10 ||
        extra.snapshotJson === undefined ||
        extra.receipts.some(
          (receipt) =>
            receipt.ownerId !== run.ownerId ||
            receipt.runId !== run.id ||
            receipt.reader.kind !== "conversation" ||
            receipt.reader.id !== run.conversationId,
        ))
    )
      throw new SimonError("validation");
    if (
      telemetry &&
      (![
        telemetry.inputTokens,
        telemetry.cachedInputTokens,
        telemetry.cacheWriteTokens,
        telemetry.outputTokens,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(telemetry.model) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(telemetry.rulesVersion))
    )
      throw new SimonError("validation");
    return [
      sql(
        `UPDATE runs SET status = :status, steps = :steps, heartbeat_at = :now,
        finished_at = CASE WHEN :status = 'running' THEN NULL ELSE :now END, write_id = :w,
        outcome_code = CASE WHEN :status = 'failed' THEN :outcome ELSE outcome_code END
        ${telemetry ? ", provider = :provider, model = :model, rules_version = :rules, input_tokens = :input_tokens, cached_input_tokens = :cached_input_tokens, cache_write_tokens = :cache_write_tokens, output_tokens = :output_tokens" : ""}
        ${extra?.retrievedBytes !== undefined ? ", retrieved_bytes = MAX(retrieved_bytes, CAST(:retrieved_bytes AS INTEGER))" : ""}
        WHERE id = :run AND owner_id = :owner AND executor_generation = :generation AND ${stopGuard}
        ${extra?.guard ? `AND ${extra.guard.sql}` : ""}`,
        {
          ...params,
          owner: run.ownerId,
          generation: int(run.generation),
          status,
          outcome: extra?.outcomeCode ?? "ai.provider_failed",
          steps: int(steps),
          now: int(now),
          ...extra?.guard?.params,
          ...(extra?.retrievedBytes !== undefined
            ? { retrieved_bytes: int(extra.retrievedBytes) }
            : {}),
          ...(telemetry
            ? {
                provider: telemetry.provider,
                model: telemetry.model,
                rules: telemetry.rulesVersion,
                input_tokens: int(telemetry.inputTokens),
                cached_input_tokens: int(telemetry.cachedInputTokens),
                cache_write_tokens: int(telemetry.cacheWriteTokens),
                output_tokens: int(telemetry.outputTokens),
              }
            : {}),
        },
      ),
      sql(
        `UPDATE conversations SET next_message_seq = next_message_seq + 1
        WHERE id = :conversation AND ${guard} AND NOT EXISTS (SELECT 1 FROM messages WHERE id = :message)`,
        {
          ...params,
          conversation: run.conversationId,
          message: messageId,
        },
      ),
      sql(
        `INSERT INTO messages (id, owner_id, conversation_id, run_id, request_id, seq, role, status, tier,
        content_enc, request_fingerprint_enc, created_at, write_id)
        SELECT :message, :owner, c.id, :run, :request, c.next_message_seq, 'assistant', 'completed', :tier,
        :content, :fingerprint, :now, :w FROM conversations c WHERE c.id = :conversation AND ${guard}
        ON CONFLICT (id) DO UPDATE SET content_enc = excluded.content_enc, write_id = excluded.write_id`,
        {
          ...params,
          message: messageId,
          owner: run.ownerId,
          conversation: run.conversationId,
          request: `assistant:${run.id}`,
          tier: run.tier,
          now: int(now),
          content: encryptFieldText(
            key,
            simonField(run.ownerId, "messages", messageId, "content_enc"),
            text,
          ),
          fingerprint: encryptFieldText(
            key,
            simonField(run.ownerId, "messages", messageId, "request_fingerprint_enc"),
            "assistant",
          ),
        },
      ),
      searchIntentStatement(
        {
          ownerId: run.ownerId,
          entity: "message",
          entityId: messageId,
          revisionOrSeq: steps,
          op: "upsert",
          now,
        },
        {
          exists:
            "EXISTS (SELECT 1 FROM messages WHERE id = :simon_checkpoint_message AND owner_id = :simon_checkpoint_owner AND write_id = :w)",
          params: {
            simon_checkpoint_message: messageId,
            simon_checkpoint_owner: run.ownerId,
            w: writeId,
          },
        },
      ),
      ...(extra?.snapshotJson !== undefined
        ? [
            sql(
              `INSERT INTO message_parts (id, message_id, owner_id, seq, content_enc, created_at, write_id)
        SELECT :id, :id, :owner, 0, :content, :now, :w WHERE ${guard}
        ON CONFLICT (id) DO UPDATE SET content_enc = excluded.content_enc, write_id = excluded.write_id`,
              {
                ...params,
                id: messageId,
                owner: run.ownerId,
                now: int(now),
                content: encryptFieldText(
                  key,
                  simonField(run.ownerId, "message_parts", messageId, "content_enc"),
                  extra.snapshotJson,
                ),
              },
            ),
          ]
        : []),
      ...(extra?.statements ?? []),
      ...(extra?.receipts ?? []).map((receipt) =>
        receiptStatement(receipt, now, {
          sql: "EXISTS (SELECT 1 FROM runs WHERE id = :checkpoint_run AND write_id = :checkpoint_write)",
          params: { checkpoint_run: run.id, checkpoint_write: writeId },
        }),
      ),
      ...(terminal ? this.releaseStatements(run.id, writeId, now) : []),
      sql("SELECT id FROM runs WHERE id = :run AND write_id = :w", params),
    ];
  }

  /** Model history excludes queued/cancelled follow-ups and uses encrypted structured checkpoints. */
  async executionHistory(run: SimonRun, key: AccountDataKey) {
    const guard = `EXISTS (SELECT 1 FROM runs WHERE id = :run AND owner_id = :owner AND executor_generation = :generation AND ${this.runGuard()})`;
    const params = {
      owner: run.ownerId,
      conversation: run.conversationId,
      run: run.id,
      generation: int(run.generation),
      now: int(this.options.now()),
    };
    const rows = await this.options.db.all(
      sql(
        `SELECT m.id, m.seq, m.role, m.content_enc, p.content_enc AS snapshot_enc FROM messages m
      LEFT JOIN message_parts p ON p.message_id = m.id AND p.owner_id = m.owner_id AND p.seq = 0
      WHERE m.owner_id = :owner AND m.conversation_id = :conversation AND m.status IN ('accepted', 'completed')
      AND ${guard}
      ORDER BY m.seq DESC LIMIT 100`,
        params,
      ),
    );
    return [...rows].reverse().map((row) => ({
      id: String(row.id),
      seq: Number(row.seq),
      role: row.role as "user" | "assistant" | "tool",
      text: decryptFieldText(
        key,
        simonField(run.ownerId, "messages", String(row.id), "content_enc"),
        String(row.content_enc),
      ),
      snapshotJson:
        row.snapshot_enc === null
          ? null
          : decryptFieldText(
              key,
              simonField(run.ownerId, "message_parts", String(row.id), "content_enc"),
              String(row.snapshot_enc),
            ),
    }));
  }

  /** A byte/count history compaction invalidates older document read receipts exactly once. */
  async advanceHistoryFloor(run: SimonRun, floorSeq: number): Promise<boolean> {
    if (!Number.isSafeInteger(floorSeq) || floorSeq < 1) throw new SimonError("validation");
    const now = this.options.now();
    const params = {
      run: run.id,
      owner: run.ownerId,
      conversation: run.conversationId,
      generation: int(run.generation),
      floor: int(floorSeq),
      now: int(now),
      write: this.nextId(),
    };
    const guardParams = {
      run: params.run,
      owner: params.owner,
      conversation: params.conversation,
      generation: params.generation,
      floor: params.floor,
      now: params.now,
    };
    const currentRun = `EXISTS (SELECT 1 FROM runs WHERE id=:run AND owner_id=:owner
      AND executor_generation=:generation AND ${this.runGuard()})`;
    const results = await this.options.db.batch([
      sql(
        `UPDATE conversations SET context_epoch=context_epoch+1, history_floor_seq=:floor, write_id=:write
        WHERE id=:conversation AND owner_id=:owner
        AND COALESCE(history_floor_seq,0) < CAST(:floor AS INTEGER)
        AND ${currentRun}`,
        params,
      ),
      sql(
        `SELECT 1 AS current WHERE ${currentRun}
        AND EXISTS (SELECT 1 FROM conversations WHERE id=:conversation AND owner_id=:owner
          AND history_floor_seq >= CAST(:floor AS INTEGER))`,
        guardParams,
      ),
    ]);
    return results[1]?.results[0]?.current === 1;
  }

  /** A continuation replaces only its own paused tool result, under its live execution guard. */
  async resolvePauseSnapshot(
    run: SimonRun,
    key: AccountDataKey,
    pausedRunId: string,
    snapshotJson: string,
  ): Promise<boolean> {
    const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
    if (
      Buffer.byteLength(snapshotJson) > 1_048_576 ||
      snapshot.id !== pausedRunId ||
      snapshot.role !== "assistant" ||
      !Array.isArray(snapshot.parts)
    )
      throw new SimonError("validation");
    const writeId = this.nextId();
    const results = await this.options.db.batch([
      sql(
        `UPDATE message_parts SET content_enc = :content, write_id = :w WHERE id = :paused AND owner_id = :owner
        AND EXISTS (SELECT 1 FROM runs WHERE id = :run AND owner_id = :owner
          AND (EXISTS (SELECT 1 FROM approvals a WHERE a.id = runs.approval_id AND a.run_id = :paused
            AND a.owner_id = runs.owner_id AND a.conversation_id = runs.conversation_id)
            OR EXISTS (SELECT 1 FROM user_asks a WHERE a.id = runs.ask_id AND a.run_id = :paused
            AND a.owner_id = runs.owner_id AND a.conversation_id = runs.conversation_id))
          AND executor_generation = :generation AND ${this.runGuard()})`,
        {
          content: encryptFieldText(
            key,
            simonField(run.ownerId, "message_parts", pausedRunId, "content_enc"),
            snapshotJson,
          ),
          w: writeId,
          paused: pausedRunId,
          owner: run.ownerId,
          run: run.id,
          generation: int(run.generation),
          now: int(this.options.now()),
        },
      ),
      sql("SELECT id FROM message_parts WHERE id = :id AND owner_id = :owner AND write_id = :w", {
        id: pausedRunId,
        owner: run.ownerId,
        w: writeId,
      }),
    ]);
    return Boolean(results[1]?.results[0]);
  }

  /** Release and advance the oldest queued message atomically; queue order uses seq, never ids. */
  releaseStatements(runId: string, writeId: string, now: number): Statement[] {
    return releaseSimonStatements(runId, writeId, now, this.options.policy);
  }

  async run(
    ownerId: string,
    runId: string,
    authorization?: SimonAuthorization,
  ): Promise<SimonRun | null> {
    assertAuthorization(authorization);
    const row = await this.options.db.first(
      sql(
        `SELECT * FROM runs WHERE id = :run AND owner_id = :owner AND ${this.access()}
        AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = runs.conversation_id
          AND (c.expires_at IS NULL OR c.expires_at > :now))
        ${authorization ? `AND (${authorization.sql})` : ""}`,
        {
          owner: ownerId,
          run: runId,
          now: int(this.options.now()),
          ...authorization?.params,
        },
      ),
    );
    return row ? runFromRow(row) : null;
  }

  async stop(ownerId: string, runId: string, fold?: SimonWriteFold): Promise<void> {
    assertFoldOwner(fold, ownerId);
    const key = fold ? await this.accountKeys.require(ownerId) : undefined;
    try {
      await this.stopWithKey(ownerId, runId, fold, key);
    } finally {
      if (key) zeroize(key.key);
    }
  }

  private async stopWithKey(
    ownerId: string,
    runId: string,
    fold?: SimonWriteFold,
    key?: AccountDataKey,
  ): Promise<void> {
    const now = this.options.now();
    const writeId = uuidv7(now);
    const guard = "EXISTS (SELECT 1 FROM runs WHERE id = :run AND write_id = :w)";
    const allowed = sql(
      `EXISTS (SELECT 1 FROM runs WHERE id = :run AND owner_id = :owner AND ${this.access()}
      AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner))
      ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}`,
      { run: runId, owner: ownerId, ...fold?.authorization?.params },
    );
    const result = await this.options.db.batch([
      ...(fold?.statements ?? []),
      sql(
        `UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, :now), write_id = :w,
        finished_at = CASE WHEN status = 'running' THEN NULL ELSE :now END,
        status = CASE WHEN status = 'running' THEN 'running' ELSE 'stopped' END
        WHERE id = :run AND owner_id = :owner AND status IN ('queued', 'running', 'awaiting_approval', 'awaiting_user') AND ${this.access()}
        AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
        ${fold ? `AND ${fold.claim.guard.exists}` : ""}
        ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}`,
        {
          run: runId,
          owner: ownerId,
          now: int(now),
          w: writeId,
          ...(fold?.claim.guard.params ?? {}),
          ...fold?.authorization?.params,
        },
      ),
      ...["approvals", "user_asks"].map((table) =>
        sql(
          `UPDATE ${table} SET status = 'expired', write_id = :w
        WHERE run_id = :run AND status = 'pending' AND ${guard}`,
          { run: runId, w: writeId },
        ),
      ),
      sql(
        `UPDATE dispatch_intents SET status = 'cancelled', cancelled_at = :now, updated_at = :now, write_id = :w
        WHERE kind = 'simon_run' AND subject_id = :run AND status = 'pending' AND ${guard}`,
        { run: runId, now: int(now), w: writeId },
      ),
      ...this.releaseStatements(runId, writeId, now),
      ...(fold && key
        ? [
            releaseUnapplied(fold, allowed),
            guardedCompletion(fold.completion({ status: 200, body: { runId } }, key), allowed),
          ]
        : []),
      { sql: `SELECT (${allowed.sql}) AS allowed`, params: allowed.params },
    ]);
    if (result.at(-1)?.results[0]?.allowed !== 1) throw new SimonError("not_found");
    if (fold && key) fold.decide(result, key, 0);
  }
}
