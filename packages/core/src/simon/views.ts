import { simonConversationViewSchema, simonVisiblePartSchema } from "@symplist/contracts";
import { decryptFieldText, zeroize } from "@symplist/crypto";
import { int, sql } from "@symplist/db";
import { type SimonRepository, simonField } from "./repository.ts";
import { SimonError } from "./types.ts";

/** Public history is a projection, never the encrypted model continuation (which contains reasoning). */
export function visibleSimonParts(
  snapshot: string | null,
  text: string,
): (typeof simonVisiblePartSchema._output)[] {
  if (snapshot === null) return text ? [{ type: "text", text }] : [];
  const parsed = JSON.parse(snapshot) as { parts?: unknown };
  if (!Array.isArray(parsed.parts)) throw new SimonError("internal");
  return parsed.parts.flatMap((value): (typeof simonVisiblePartSchema._output)[] => {
    if (value === null || typeof value !== "object") return [];
    const part = value as Record<string, unknown>;
    if (part.type === "data-approval-result" || part.type === "data-user-answer") {
      const data = part.data;
      if (data === null || typeof data !== "object") return [];
      const fields = data as Record<string, unknown>;
      const parsed = simonVisiblePartSchema.safeParse({
        type: part.type,
        data: {
          status: fields.status,
          ...(part.type === "data-approval-result" && fields.result !== undefined
            ? { result: fields.result }
            : {}),
          ...(part.type === "data-user-answer" && fields.text !== undefined
            ? { text: fields.text }
            : {}),
        },
      });
      return parsed.success ? [parsed.data] : [];
    }
    if (part.type === "text" && typeof part.text === "string")
      return [{ type: "text", text: part.text }];
    if (
      part.type !== "dynamic-tool" ||
      typeof part.toolCallId !== "string" ||
      typeof part.toolName !== "string"
    )
      return [];
    if (!["input-available", "output-available", "output-error"].includes(String(part.state)))
      return [];
    return [
      {
        type: "tool",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        state: part.state as "input-available" | "output-available" | "output-error",
        ...(part.state === "output-available" ? { output: part.output } : {}),
        ...(part.state === "output-error" ? { errorCode: "tool.failed" } : {}),
      },
    ];
  });
}

/** One bounded, owner-authorized read transaction per history page or reconnect snapshot. */
export class SimonViews {
  constructor(readonly repository: SimonRepository) {}

  async owns(ownerId: string, conversationId: string): Promise<boolean> {
    return Boolean(
      await this.repository.options.db.first(
        sql(
          `SELECT c.id FROM conversations c
      WHERE c.id = :conversation AND c.owner_id = :owner AND ${this.repository.access()}
      AND (c.expires_at IS NULL OR c.expires_at > :now)
      AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)`,
          { owner: ownerId, conversation: conversationId, now: int(this.repository.options.now()) },
        ),
      ),
    );
  }

  async conversation(ownerId: string, conversationId: string, beforeSeq?: number) {
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1))
      throw new SimonError("validation");
    const repository = this.repository;
    const params = {
      owner: ownerId,
      conversation: conversationId,
      now: int(repository.options.now()),
    };
    const allowed = `c.id = :conversation AND c.owner_id = :owner AND ${repository.access()}
      AND (c.expires_at IS NULL OR c.expires_at > :now)`;
    const result = await repository.options.db.batch([
      sql(
        `SELECT c.*, r.status AS run_status, r.tier AS run_tier, r.cancel_requested_at,
        (SELECT a.id FROM approvals a WHERE a.run_id = c.active_run_id AND a.owner_id = c.owner_id AND a.status = 'pending' LIMIT 1) AS approval_id,
        (SELECT a.id FROM user_asks a WHERE a.run_id = c.active_run_id AND a.owner_id = c.owner_id AND a.status = 'pending' LIMIT 1) AS ask_id
        FROM conversations c LEFT JOIN runs r ON r.id = c.active_run_id AND r.owner_id = c.owner_id WHERE ${allowed}`,
        params,
      ),
      repository.accountKeys.selectStatement(ownerId),
      sql(
        `WITH candidates AS (
        SELECT m.id, m.seq, LENGTH(CAST(m.content_enc AS BLOB)) + COALESCE(LENGTH(CAST(p.content_enc AS BLOB)), 0) AS size
        FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id
        LEFT JOIN message_parts p ON p.message_id = m.id AND p.owner_id = m.owner_id AND p.seq = 0
        WHERE ${allowed} ${beforeSeq === undefined ? "" : "AND m.seq < :before"}
        ORDER BY m.seq DESC LIMIT 51
      ), bounded AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY seq DESC) AS position,
        SUM(size) OVER (ORDER BY seq DESC) AS bytes FROM candidates
      ) SELECT m.id, m.seq, m.role, m.status, m.run_id, m.content_enc, p.content_enc AS snapshot_enc
        FROM bounded b JOIN messages m ON m.id = b.id AND m.owner_id = :owner
        LEFT JOIN message_parts p ON p.message_id = m.id AND p.owner_id = m.owner_id AND p.seq = 0
        WHERE b.bytes <= 2097152 OR b.position = 1 ORDER BY b.seq DESC`,
        { ...params, ...(beforeSeq === undefined ? {} : { before: int(beforeSeq) }) },
      ),
    ]);
    const conversation = result[0]?.results[0];
    const keyRow = result[1]?.results[0];
    if (!conversation || !keyRow) throw new SimonError("not_found");
    const key = repository.accountKeys.unwrapRow(keyRow);
    try {
      const rows = result[2]?.results ?? [];
      const page = rows.slice(0, 50);
      const messages = [...page].reverse().map((row) => {
        const id = String(row.id);
        const text = decryptFieldText(
          key,
          simonField(ownerId, "messages", id, "content_enc"),
          String(row.content_enc),
        );
        const snapshot =
          row.snapshot_enc === null
            ? null
            : decryptFieldText(
                key,
                simonField(ownerId, "message_parts", id, "content_enc"),
                String(row.snapshot_enc),
              );
        return {
          id,
          seq: Number(row.seq),
          role: row.role,
          status: row.status,
          runId: row.run_id,
          text,
          parts: visibleSimonParts(snapshot, text),
        };
      });
      // A byte-limited page can have fewer than 50 rows. A final empty page is safe; skipping rows is not.
      const oldest = messages[0]?.seq ?? null;
      return simonConversationViewSchema.parse({
        conversationId,
        kind: conversation.kind,
        taskId: conversation.task_id,
        activeRun:
          conversation.active_run_id === null
            ? null
            : {
                runId: conversation.active_run_id,
                conversationId,
                taskId: conversation.task_id,
                status: conversation.run_status,
                tier: conversation.run_tier,
                stopRequested: conversation.cancel_requested_at !== null,
              },
        pendingApprovalId: conversation.approval_id,
        pendingAskId: conversation.ask_id,
        messages,
        nextBeforeSeq: oldest !== null && oldest > 1 ? oldest : null,
      });
    } finally {
      zeroize(key.key);
    }
  }
}
