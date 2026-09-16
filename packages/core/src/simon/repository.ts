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
import { evaluateAccess } from "../access/evaluate.ts";
import { accessCondition, accessStateFromRow, accessStateSelectList } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";
import type { ExecutorKind } from "../events/execution.ts";
import {
  type ClaimedSimonRun,
  runFromRow,
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

  async createConversation(ownerId: string, taskId: string | null): Promise<string> {
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
        `SELECT id FROM conversations WHERE owner_id = :owner AND ${this.access()}
        AND (id = :id OR (task_id = :task AND kind = 'task')) LIMIT 1`,
        { owner: ownerId, id, task: taskId },
      ),
    ]);
    const row = result[1]?.results[0];
    if (!row) throw new SimonError("not_found");
    return String(row.id);
  }

  async loadConversation(ownerId: string, conversationId: string, write = false) {
    const result = await this.options.db.batch([
      sql(
        `SELECT c.*, t.status AS task_status, ${accessStateSelectList("u", "u_")}
        FROM conversations c JOIN users u ON u.id = c.owner_id LEFT JOIN tasks t ON t.id = c.task_id
        WHERE c.id = :id AND c.owner_id = :owner`,
        { id: conversationId, owner: ownerId },
      ),
      this.accountKeys.selectStatement(ownerId),
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
    return { row, key: this.accountKeys.unwrapRow(keyRow) };
  }

  /** A repeated request is reconciled by its encrypted fingerprint, never by plaintext content. */
  async acceptMessage(
    ownerId: string,
    conversationId: string,
    requestId: string,
    input: { text: string; tier: SimonTier },
  ): Promise<AcceptedMessage> {
    const parsed = simonMessageInputSchema.parse(input);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw new SimonError("validation");
    const loaded = await this.loadConversation(ownerId, conversationId, true);
    try {
      const now = this.options.now();
      const messageId = uuidv7(now);
      const runId = uuidv7(now);
      const writeId = uuidv7(now);
      const fingerprint = createHash("sha256").update(canonicalJson(parsed)).digest("hex");
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
      const result = await this.options.db.batch([
        sql(
          `UPDATE conversations AS c SET active_run_id = COALESCE(active_run_id, :run),
          next_message_seq = next_message_seq + 1, updated_at = :now, write_id = :w,
          expires_at = CASE WHEN kind = 'quick' THEN :expiry ELSE NULL END
          WHERE id = :conversation AND owner_id = :owner AND ${this.access()} AND ${this.activeTask("c")}
          AND (expires_at IS NULL OR expires_at > :now)
          AND EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = :conversation AND request_id = :request)
          AND (SELECT COUNT(*) FROM messages WHERE conversation_id = :conversation AND status = 'queued') < 20`,
          {
            ...params,
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
        ...this.dispatchStatements(runId, now),
        sql(
          `SELECT * FROM messages WHERE conversation_id = :conversation AND owner_id = :owner AND request_id = :request
          AND ${this.access()}`,
          { owner: ownerId, conversation: conversationId, request: requestId },
        ),
      ]);
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
    return [
      sql(
        `INSERT INTO dispatch_intents (id, owner_id, kind, subject_id, executor_generation, created_at, updated_at, write_id)
      SELECT :intent, owner_id, 'simon_run', id, executor_generation, :now, :now, :intent FROM runs
      WHERE id = :run AND status = 'queued' ON CONFLICT (kind, subject_id) DO NOTHING`,
        {
          intent: uuidv7(now),
          run: runId,
          now: int(now),
        },
      ),
    ];
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
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(steps) ||
      steps < 0 ||
      steps > 10 ||
      !["running", "completed", "failed", "stopped", "interrupted"].includes(status)
    )
      throw new SimonError("validation");
    const now = this.options.now();
    const writeId = uuidv7(now);
    const messageId = run.id;
    const terminal = status !== "running";
    const guard = "EXISTS (SELECT 1 FROM runs WHERE id = :run AND write_id = :w)";
    const params = { run: run.id, w: writeId };
    const stopGuard =
      status === "stopped"
        ? this.runGuard().replace("cancel_requested_at IS NULL", "cancel_requested_at IS NOT NULL")
        : this.runGuard();
    const result = await this.options.db.batch([
      sql(
        `UPDATE runs SET status = :status, steps = :steps, heartbeat_at = :now,
        finished_at = CASE WHEN :status = 'running' THEN NULL ELSE :now END, write_id = :w
        WHERE id = :run AND owner_id = :owner AND executor_generation = :generation AND ${stopGuard}`,
        {
          ...params,
          owner: run.ownerId,
          generation: int(run.generation),
          status,
          steps: int(steps),
          now: int(now),
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
      ...(terminal ? this.releaseStatements(run.id, writeId, now) : []),
      sql("SELECT id FROM runs WHERE id = :run AND write_id = :w", params),
    ]);
    return Boolean(result.at(-1)?.results[0]);
  }

  /** Release and advance the oldest queued message atomically; queue order uses seq, never ids. */
  releaseStatements(runId: string, writeId: string, now: number): Statement[] {
    const nextRun = uuidv7(now);
    return [
      sql(
        `UPDATE conversations SET active_run_id = NULL, write_id = :w WHERE active_run_id = :run
        AND EXISTS (SELECT 1 FROM runs WHERE id = :run AND write_id = :w AND status IN ('completed', 'stopped', 'interrupted', 'failed'))`,
        { run: runId, w: writeId },
      ),
      sql(
        `UPDATE conversations AS c SET active_run_id = :next WHERE write_id = :w AND active_run_id IS NULL
        AND ${this.activeTask("c")} AND ${this.access("simon_owner").replaceAll(":simon_owner", "c.owner_id")}
        AND (expires_at IS NULL OR expires_at > :now) AND EXISTS
        (SELECT 1 FROM messages WHERE conversation_id = c.id AND status = 'queued')`,
        { next: nextRun, w: writeId, now: int(now) },
      ),
      sql(
        `INSERT INTO runs (id, owner_id, conversation_id, task_id, kind, executor, executor_generation, tier, created_at, write_id)
        SELECT :next, c.owner_id, c.id, c.task_id, 'turn', CASE e.mode WHEN 'durable' THEN 'trigger' ELSE 'local' END,
        e.generation, (SELECT tier FROM messages WHERE conversation_id = c.id AND status = 'queued' ORDER BY seq LIMIT 1), :now, :w
        FROM conversations c CROSS JOIN executor_state e WHERE c.active_run_id = :next AND c.write_id = :w AND e.id = 1`,
        {
          next: nextRun,
          w: writeId,
          now: int(now),
        },
      ),
      sql(
        `UPDATE messages SET status = 'accepted', run_id = :next, write_id = :w
        WHERE id = (SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.active_run_id = :next AND c.write_id = :w AND m.status = 'queued' ORDER BY m.seq LIMIT 1)`,
        { next: nextRun, w: writeId },
      ),
      ...this.dispatchStatements(nextRun, now),
    ];
  }

  async run(ownerId: string, runId: string): Promise<SimonRun | null> {
    const row = await this.options.db.first(
      sql(`SELECT * FROM runs WHERE id = :run AND owner_id = :owner AND ${this.access()}`, {
        owner: ownerId,
        run: runId,
      }),
    );
    return row ? runFromRow(row) : null;
  }

  async stop(ownerId: string, runId: string): Promise<void> {
    const now = this.options.now();
    const writeId = uuidv7(now);
    const guard = "EXISTS (SELECT 1 FROM runs WHERE id = :run AND write_id = :w)";
    const result = await this.options.db.batch([
      sql(
        `UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, :now), write_id = :w,
        finished_at = CASE WHEN status = 'running' THEN NULL ELSE :now END,
        status = CASE WHEN status = 'running' THEN 'running' ELSE 'stopped' END
        WHERE id = :run AND owner_id = :owner AND status IN ('queued', 'running', 'awaiting_approval', 'awaiting_user') AND ${this.access()}`,
        {
          run: runId,
          owner: ownerId,
          now: int(now),
          w: writeId,
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
      sql(`SELECT id FROM runs WHERE id = :run AND owner_id = :owner AND ${this.access()}`, {
        run: runId,
        owner: ownerId,
      }),
    ]);
    if (!result.at(-1)?.results[0]) throw new SimonError("not_found");
  }
}
