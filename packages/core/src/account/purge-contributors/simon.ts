import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

const tables = [
  "chat_transcript_messages",
  "chat_transcript_state",
  "tool_invocations",
  "message_parts",
  "messages",
  "approvals",
  "user_asks",
  "runs",
  "conversations",
] as const;
const conditions = {
  chat_transcript_messages: "1 = 1",
  chat_transcript_state: "1 = 1",
  tool_invocations: "1 = 1",
  message_parts: "1 = 1",
  messages: "NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = r.id)",
  approvals:
    "NOT EXISTS (SELECT 1 FROM tool_invocations t WHERE t.approval_id = r.id) AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.supersedes_id = r.id)",
  user_asks: "1 = 1",
  runs: "NOT EXISTS (SELECT 1 FROM messages m WHERE m.run_id = r.id) AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id) AND NOT EXISTS (SELECT 1 FROM user_asks a WHERE a.run_id = r.id) AND NOT EXISTS (SELECT 1 FROM tool_invocations t WHERE t.run_id = r.id) AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.continues_run_id = r.id)",
  conversations:
    "NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = r.id) AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.conversation_id = r.id)",
};

/**
 * The column each table is deleted by. Most carry an `id`; the durable chat transcript is keyed by
 * its conversation and the runtime's own message id, so it has none. Deleting by `rowid` keeps the
 * bounded-batch shape rather than inventing a surrogate key the rest of the schema would not use.
 */
const keys: Record<(typeof tables)[number], string> = {
  chat_transcript_messages: "rowid",
  chat_transcript_state: "chat_id",
  tool_invocations: "id",
  message_parts: "id",
  messages: "id",
  approvals: "id",
  user_asks: "id",
  runs: "id",
  conversations: "id",
};

/**
 * Simon purge statements (§5.6). Messages, message parts, runs, approvals, user asks, tool
 * invocations and the durable chat transcript. The transcript rows go first: they reference
 * `conversations`, and a session's history must not outlive the account that owned it.
 */
export const simonPurgeContributor: PurgeContributor = {
  domain: "simon",
  statements: ({ userId, batchLimit }) =>
    tables.map((table) =>
      sql(
        `DELETE FROM ${table} WHERE ${keys[table]} IN (SELECT r.${keys[table]} FROM ${table} r WHERE r.owner_id = :owner AND ${conditions[table]} LIMIT :limit)`,
        { owner: userId, limit: int(batchLimit) },
      ),
    ),
  remaining: ({ userId }) => [
    sql(
      `SELECT (${tables.map((table) => `EXISTS (SELECT 1 FROM ${table} WHERE owner_id = :owner)`).join(" OR ")}) AS remaining`,
      { owner: userId },
    ),
  ],
};
