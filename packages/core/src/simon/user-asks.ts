import { simonAnswerSchema } from "@symplist/contracts";
import { type AccountDataKey, decryptFieldText, encryptFieldText, zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { continuationStatements, pauseGuard } from "./continuations.ts";
import {
  assertFoldOwner,
  guardedCompletion,
  releaseUnapplied,
  type SimonWriteFold,
} from "./fold.ts";
import { type SimonRepository, simonField } from "./repository.ts";
import { type SimonCheckpointData, SimonError, type SimonRun } from "./types.ts";

export class SimonUserAsks {
  constructor(readonly repository: SimonRepository) {}

  async pause(
    run: SimonRun,
    key: AccountDataKey,
    input: { toolCallId: string; question: string },
    checkpoint: { text: string; steps: number } & SimonCheckpointData,
    reservedId?: string,
  ): Promise<string> {
    const question = simonAnswerSchema.parse({ text: input.question }).text;
    const now = this.repository.options.now();
    const id = reservedId ?? uuidv7(now);
    const writeId = uuidv7(now);
    const result = await this.repository.options.db.batch(
      this.repository.checkpointStatements(
        run,
        key,
        checkpoint.text,
        checkpoint.steps,
        "awaiting_user",
        {
          now,
          writeId,
          ...checkpoint,
          statements: [
            sql(
              `INSERT INTO user_asks (id, owner_id, conversation_id, task_id, run_id, tool_call_id,
        question_enc, expires_at, created_at, write_id)
        SELECT :id, :owner, :conversation, :task, :run, :call, :question, :expiry, :now, :w
        WHERE EXISTS (SELECT 1 FROM runs WHERE id = :run AND write_id = :w)`,
              {
                id,
                owner: run.ownerId,
                conversation: run.conversationId,
                task: run.taskId,
                run: run.id,
                call: input.toolCallId,
                question: encryptFieldText(
                  key,
                  simonField(run.ownerId, "user_asks", id, "question_enc"),
                  question,
                ),
                expiry: int(now + 86_400_000),
                now: int(now),
                w: writeId,
              },
            ),
          ],
        },
      ),
    );
    if (!result.at(-1)?.results[0]) throw new SimonError("simon.stale");
    return id;
  }

  async load(ownerId: string, askId: string) {
    const result = await this.repository.options.db.batch([
      sql(
        `SELECT * FROM user_asks WHERE id = :id AND owner_id = :owner AND ${this.repository.access()}
        AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = user_asks.conversation_id
          AND (c.expires_at IS NULL OR c.expires_at > :now))`,
        { id: askId, owner: ownerId, now: int(this.repository.options.now()) },
      ),
      this.repository.accountKeys.selectStatement(ownerId),
    ]);
    const row = result[0]?.results[0];
    const keyRow = result[1]?.results[0];
    if (!row || !keyRow) throw new SimonError("not_found");
    const key = this.repository.accountKeys.unwrapRow(keyRow);
    try {
      return {
        id: String(row.id),
        runId: String(row.run_id),
        toolCallId: String(row.tool_call_id),
        status: row.status as "pending" | "answered" | "dismissed" | "expired",
        expiresAt: Number(row.expires_at),
        question: decryptFieldText(
          key,
          simonField(ownerId, "user_asks", askId, "question_enc"),
          String(row.question_enc),
        ),
        answer:
          row.answer_enc === null
            ? null
            : decryptFieldText(
                key,
                simonField(ownerId, "user_asks", askId, "answer_enc"),
                String(row.answer_enc),
              ),
      };
    } finally {
      zeroize(key.key);
    }
  }

  async decide(
    ownerId: string,
    askId: string,
    decision: { kind: "answer"; text: string } | { kind: "dismiss" },
    fold?: SimonWriteFold,
  ): Promise<string> {
    assertFoldOwner(fold, ownerId);
    const answer =
      decision.kind === "answer" ? simonAnswerSchema.parse({ text: decision.text }).text : null;
    const loaded = await this.repository.options.db.batch([
      sql(
        `SELECT run_id FROM user_asks WHERE id = :id AND owner_id = :owner AND ${this.repository.access()}`,
        { id: askId, owner: ownerId },
      ),
      this.repository.accountKeys.selectStatement(ownerId),
    ]);
    const ask = loaded[0]?.results[0];
    const keyRow = loaded[1]?.results[0];
    if (!ask || !keyRow) throw new SimonError("not_found");
    const key = this.repository.accountKeys.unwrapRow(keyRow);
    try {
      const now = this.repository.options.now();
      const writeId = uuidv7(now);
      const nextRunId = uuidv7(now);
      let encrypted: string | null = null;
      if (answer !== null) {
        encrypted = encryptFieldText(
          key,
          simonField(ownerId, "user_asks", askId, "answer_enc"),
          answer,
        );
      }
      const applied = sql(
        "EXISTS (SELECT 1 FROM user_asks WHERE id = :id AND owner_id = :owner AND write_id = :w)",
        { id: askId, owner: ownerId, w: writeId },
      );
      const authority = sql(
        `EXISTS (SELECT 1 FROM user_asks a JOIN conversations c ON c.id = a.conversation_id
      WHERE a.id = :id AND a.owner_id = :owner AND ${this.repository.access()}
      AND (c.expires_at IS NULL OR c.expires_at > :now)
      AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner))
      ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}`,
        { id: askId, owner: ownerId, now: int(now), ...fold?.authorization?.params },
      );
      const result = await this.repository.options.db.batch([
        ...(fold?.statements ?? []),
        sql(
          `UPDATE user_asks SET status = :status, answer_enc = :answer, decided_at = :now, write_id = :w
        WHERE id = :id AND owner_id = :owner AND status = 'pending' AND expires_at > :now
        AND ${this.repository.access()} AND ${pauseGuard(this.repository, "user_asks")}
        AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
        ${fold ? `AND ${fold.claim.guard.exists}` : ""}
        ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}`,
          {
            id: askId,
            owner: ownerId,
            now: int(now),
            w: writeId,
            status: answer === null ? "dismissed" : "answered",
            answer: encrypted,
            ...(fold?.claim.guard.params ?? {}),
            ...fold?.authorization?.params,
          },
        ),
        ...continuationStatements(this.repository, {
          table: "user_asks",
          pauseId: askId,
          ownerId,
          runId: String(ask.run_id),
          nextRunId,
          writeId,
          now,
        }),
        ...(fold
          ? [
              releaseUnapplied(fold, applied),
              guardedCompletion(
                fold.completion({ status: 200, body: { runId: nextRunId } }, key),
                applied,
              ),
            ]
          : []),
        {
          sql: `SELECT (${applied.sql}) AS applied, (${authority.sql}) AS allowed`,
          params: [...applied.params, ...authority.params],
        },
      ]);
      const row = result.at(-1)?.results[0];
      if (row?.allowed !== 1) throw new SimonError("not_found");
      if (fold) {
        const decision = fold.decide(result, key, 0);
        if (decision.kind === "replay") return (decision.body as { runId: string }).runId;
      }
      if (row.applied !== 1) throw new SimonError("user_ask.stale");
      return nextRunId;
    } finally {
      zeroize(key.key);
    }
  }

  expireStatements(input: {
    ownerId: string;
    askId: string;
    runId: string;
    now: number;
    guard?: { sql: string; params: Readonly<Record<string, string>> };
  }) {
    const writeId = uuidv7(input.now);
    const nextRunId = uuidv7(input.now);
    return [
      sql(
        `UPDATE user_asks SET status = 'expired', decided_at = :now, write_id = :w
      WHERE id = :id AND owner_id = :owner AND run_id = :run AND status = 'pending' AND expires_at <= :now
      AND ${this.repository.access()} AND ${pauseGuard(this.repository, "user_asks")}
      ${input.guard ? `AND ${input.guard.sql}` : ""}`,
        {
          id: input.askId,
          owner: input.ownerId,
          run: input.runId,
          now: int(input.now),
          w: writeId,
          ...input.guard?.params,
        },
      ),
      ...continuationStatements(this.repository, {
        table: "user_asks",
        pauseId: input.askId,
        ownerId: input.ownerId,
        runId: input.runId,
        nextRunId,
        writeId,
        now: input.now,
      }),
    ];
  }
}
