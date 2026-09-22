import type { SimonTranscriptStorage } from "@symplist/core/simon";
import type { DbClient } from "@symplist/db";
import { sql } from "@symplist/db";
import { WorkerError } from "../../infra/errors.ts";

/**
 * Bridges Symplist's D1 transcript to the chat runtime's storage contract (note 07, §8.1).
 *
 * The runtime hands every call a `chatId` and a `clientData` blob that originate in the browser, so
 * neither is a trust boundary: the upstream guidance is explicit that a storage's own `clientData`
 * check is a backstop rather than the boundary. The owner is therefore resolved from the
 * `conversations` row keyed by that chat id, server side, and a chat id with no row reads and writes
 * nothing. A caller who learns another account's chat id gets `not_found`, not their transcript.
 */

export interface TranscriptScope {
  readonly chatId: string;
}
export interface TranscriptLoadOptions {
  readonly limit?: number;
  readonly before?: string;
}

/** Resolves the owner of a conversation. Never accepts one supplied by a caller. */
export async function conversationOwner(db: DbClient, chatId: string): Promise<string> {
  if (typeof chatId !== "string" || chatId.length === 0 || chatId.length > 64)
    throw new WorkerError("simon.payload_invalid");
  const row = await db.first(
    sql("SELECT owner_id FROM conversations WHERE id = :chat", { chat: chatId }),
  );
  // An unknown chat id is not an empty conversation: nothing may be written under it either.
  if (!row) throw new WorkerError("simon.not_found");
  return String(row.owner_id);
}

/**
 * The storage the chat agent is registered with. Registering any storage is what stops the runtime
 * writing its own plaintext transcript snapshot to platform object storage after every turn, which
 * is the condition for a durable chat existing here at all.
 */
export function createTranscriptStorage(db: DbClient, storage: SimonTranscriptStorage) {
  return {
    async load(scope: TranscriptScope, options?: TranscriptLoadOptions) {
      const owner = await conversationOwner(db, scope.chatId);
      const result = await storage.load(owner, scope.chatId, options ?? {});
      // The runtime's contract is a mutable array of UIMessages.
      return { ...result, messages: [...result.messages] } as never;
    },
    async save(context: TranscriptScope, changeset: unknown) {
      const owner = await conversationOwner(db, context.chatId);
      await storage.save(
        owner,
        context.chatId,
        changeset as Parameters<SimonTranscriptStorage["save"]>[2],
      );
    },
  };
}
