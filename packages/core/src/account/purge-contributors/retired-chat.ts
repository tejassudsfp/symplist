import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * The tables cloud chat left behind (§5.6, note 18).
 *
 * Simon moved to the desktop and no core domain writes these tables any more, but migrations are
 * expand-only, so `conversations`, `runs`, `approvals`, `chat_transcript_*` and the BYOK key rows
 * stay in the schema — and every row an account wrote before the removal is still sitting in them.
 * Account deletion promises an owner's rows are gone, not merely unreachable, so the purge still has
 * to reach them. The statements are the ones the former `simon` and `ai` contributors ran, kept
 * together here because what is left is one retired feature rather than two live domains.
 *
 * This runs first: `conversations`, `runs`, `approvals` and `messages` reference `tasks`, whose
 * contributor runs late. The provider key rows reference only `users`, so they ride along at the end.
 */
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
  "ai_provider_keys",
  "ai_model_choices",
] as const;

/**
 * What must already be gone before a row of each table may go, so that one bounded pass never leaves
 * a dangling reference. Tables nothing points at delete unconditionally.
 */
const conditions: Record<(typeof tables)[number], string> = {
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
  ai_provider_keys: "1 = 1",
  ai_model_choices: "1 = 1",
};

/**
 * The column each table is deleted by. Most carry an `id`; the durable chat transcript is keyed by
 * its conversation and the runtime's own message id, and a model choice by its owner, so they have
 * none. Deleting by `rowid` keeps the bounded-batch shape rather than inventing a surrogate key the
 * rest of the schema would not use.
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
  ai_provider_keys: "rowid",
  ai_model_choices: "owner_id",
};

export const retiredChatPurgeContributor: PurgeContributor = {
  domain: "retired-chat",
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
