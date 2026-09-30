import type { TranscriptStore } from "../transcripts.ts";
import type { HarnessSessionBook } from "./supervisor.ts";

/**
 * The transcript store, seen as the supervisor's session book.
 *
 * `HarnessSessionBook` is declared in `supervisor.ts` and deliberately left unimplemented there, because
 * the supervisor must not depend on where the id is kept. This is the implementation: the ACP session id
 * lives beside the conversation it belongs to, in the same SQLite file as that conversation's transcript,
 * so a relaunch reads one row and knows both what to show and which session to rejoin.
 *
 * Without this the supervisor still runs — `tryResume` returns null when no book is given and every
 * conversation starts a fresh session. What that costs is precise and worth naming: the user's transcript
 * survives a restart because we wrote it down, but the *agent's* context does not, so the pane looks
 * continuous while the model has forgotten everything. Wiring the book is what closes that gap.
 *
 * `cwd` is the one thing the book cannot discover. An ACP session pins exactly one absolute workspace and
 * the supervisor keys its children by that root, so the root the supervisor is running under is the root
 * the conversation belongs to; it is passed in rather than guessed.
 */
export function transcriptSessionBook(
  store: TranscriptStore,
  workspaceRoot: string,
): HarnessSessionBook {
  return {
    async get(conversationId: string): Promise<string | null> {
      return (await store.conversation(conversationId))?.acpSessionId ?? null;
    },

    /**
     * Two writes, and both are load-bearing. `upsertConversation` guarantees the row exists — a session
     * created before anything was ever stored for this conversation has no row to update — and it is
     * passed no session id because its `ON CONFLICT` coalesces, which would keep a stale id rather than
     * replace it. `setAcpSession` is the unconditional write that actually moves the pointer.
     */
    async set(conversationId: string, acpSessionId: string): Promise<void> {
      await store.upsertConversation({ conversationId, taskId: null, cwd: workspaceRoot });
      await store.setAcpSession(conversationId, acpSessionId);
    },

    /** Called when a session could not be resumed, so the next launch does not retry the same failure. */
    async forget(conversationId: string): Promise<void> {
      await store.setAcpSession(conversationId, null);
    },
  };
}
