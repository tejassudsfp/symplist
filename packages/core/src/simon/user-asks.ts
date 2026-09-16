import { simonAnswerSchema } from "@symplist/contracts";
import { type AccountDataKey, decryptFieldText, encryptFieldText, zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { continuationStatements, pauseGuard } from "./continuations.ts";
import { type SimonRepository, simonField } from "./repository.ts";
import { SimonError, type SimonRun } from "./types.ts";

export class SimonUserAsks {
  constructor(readonly repository: SimonRepository) {}

  async pause(
    run: SimonRun,
    key: AccountDataKey,
    input: { toolCallId: string; question: string },
    checkpoint: { text: string; steps: number },
  ): Promise<string> {
    const question = simonAnswerSchema.parse({ text: input.question }).text;
    const now = this.repository.options.now();
    const id = uuidv7(now);
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
        `SELECT * FROM user_asks WHERE id = :id AND owner_id = :owner AND ${this.repository.access()}`,
        { id: askId, owner: ownerId },
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
  ): Promise<string> {
    const ask = await this.load(ownerId, askId);
    const answer =
      decision.kind === "answer" ? simonAnswerSchema.parse({ text: decision.text }).text : null;
    const now = this.repository.options.now();
    const writeId = uuidv7(now);
    const nextRunId = uuidv7(now);
    let encrypted: string | null = null;
    if (answer !== null) {
      const key = await this.repository.accountKeys.require(ownerId);
      try {
        encrypted = encryptFieldText(
          key,
          simonField(ownerId, "user_asks", askId, "answer_enc"),
          answer,
        );
      } finally {
        zeroize(key.key);
      }
    }
    const result = await this.repository.options.db.batch([
      sql(
        `UPDATE user_asks SET status = :status, answer_enc = :answer, decided_at = :now, write_id = :w
        WHERE id = :id AND owner_id = :owner AND status = 'pending' AND expires_at > :now
        AND ${this.repository.access()} AND ${pauseGuard(this.repository, "user_asks")}`,
        {
          id: askId,
          owner: ownerId,
          now: int(now),
          w: writeId,
          status: answer === null ? "dismissed" : "answered",
          answer: encrypted,
        },
      ),
      ...continuationStatements(this.repository, {
        table: "user_asks",
        pauseId: askId,
        ownerId,
        runId: ask.runId,
        nextRunId,
        writeId,
        now,
      }),
      sql("SELECT id FROM user_asks WHERE id = :id AND owner_id = :owner AND write_id = :w", {
        id: askId,
        owner: ownerId,
        w: writeId,
      }),
    ]);
    if (!result.at(-1)?.results[0]) throw new SimonError("user_ask.stale");
    return nextRunId;
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
