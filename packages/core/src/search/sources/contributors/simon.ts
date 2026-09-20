import { type AccountDataKey, decryptFieldText } from "@symplist/crypto";
import { type DbClient, int, sql } from "@symplist/db";
import type { SearchMessageRecord } from "@symplist/search";
import { accessCondition } from "../../../access/sql.ts";
import { simonField } from "../../../simon/repository.ts";
import type { MessageTextSource, SearchPage, SearchSourceContributor } from "../types.ts";

/** D1's 100-parameter ceiling leaves room for owner and admission bindings. */
export const MESSAGE_READ_CHUNK = 80;
export const MESSAGE_PAGE_LIMIT = 100;

function admitted(policy: { readonly betaAccessRequired: boolean } | undefined): string {
  return accessCondition({
    level: "admitted",
    policy: policy ?? { betaAccessRequired: true },
    userParam: "search_message_owner",
  });
}

function page(page: SearchPage): { readonly after: string; readonly limit: number } {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > MESSAGE_PAGE_LIMIT)
    throw new RangeError("Search message page is outside its bounded limit");
  return { after: page.after ?? "", limit: page.limit };
}

/**
 * Owner-scoped persisted task-chat source. Quick conversations, queued/cancelled messages and model
 * tool records never escape this boundary. Ciphertext is opened with the exact Simon field AAD.
 */
export class D1MessageTextSource implements MessageTextSource {
  constructor(
    private readonly db: DbClient,
    private readonly policy?: { readonly betaAccessRequired: boolean },
  ) {}

  async listMessages(ownerId: string, input: SearchPage): Promise<readonly string[]> {
    const checked = page(input);
    const rows = await this.db.all(
      sql(
        `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
         AND c.owner_id = m.owner_id
         WHERE m.owner_id = :owner AND m.id > :after AND c.kind = 'task'
         AND m.role IN ('user', 'assistant') AND m.status IN ('accepted', 'completed')
         AND ${admitted(this.policy)} ORDER BY m.id LIMIT :limit`,
        {
          owner: ownerId,
          after: checked.after,
          limit: int(checked.limit),
          search_message_owner: ownerId,
        },
      ),
    );
    return rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
  }

  async readMessages(
    ownerId: string,
    messageIds: readonly string[],
    key: AccountDataKey,
  ): Promise<ReadonlyMap<string, SearchMessageRecord>> {
    const found = new Map<string, SearchMessageRecord>();
    const unique = [...new Set(messageIds)];
    for (let start = 0; start < unique.length; start += MESSAGE_READ_CHUNK) {
      const ids = unique.slice(start, start + MESSAGE_READ_CHUNK);
      const rows = await this.db.all(
        sql(
          `SELECT m.id, m.conversation_id, c.task_id, m.role, m.content_enc, m.created_at
           FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id
           WHERE m.owner_id = :owner AND m.id IN (:ids) AND c.kind = 'task'
           AND m.role IN ('user', 'assistant') AND m.status IN ('accepted', 'completed')
           AND ${admitted(this.policy)}`,
          { owner: ownerId, ids, search_message_owner: ownerId },
        ),
      );
      for (const row of rows) {
        if (
          typeof row.id !== "string" ||
          typeof row.conversation_id !== "string" ||
          typeof row.task_id !== "string" ||
          typeof row.content_enc !== "string" ||
          typeof row.created_at !== "number" ||
          (row.role !== "user" && row.role !== "assistant")
        )
          continue;
        try {
          found.set(row.id, {
            id: row.id,
            taskId: row.task_id,
            conversationId: row.conversation_id,
            speaker: row.role === "assistant" ? "simon" : "user",
            createdAt: row.created_at,
            text: decryptFieldText(
              key,
              simonField(ownerId, "messages", row.id, "content_enc"),
              row.content_enc,
            ),
          });
        } catch {
          // A corrupt record is not searchable; the next full rebuild can recover the remaining corpus.
        }
      }
    }
    return found;
  }
}

/**
 * Simon's search source (§8, §10.1). It adds `messages`: a `MessageTextSource` over persisted
 * task-conversation messages (never quick chats). Until it does, there are no messages to index.
 */
export const simonSearchSourceContributor: SearchSourceContributor = {
  domain: "simon",
  messages: ({ db, accessPolicy }) => new D1MessageTextSource(db, accessPolicy),
};
