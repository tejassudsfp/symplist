import {
  createSimonModels,
  SIMON_MAX_OUTPUT_TOKENS_PER_STEP,
  simonInstructions,
} from "@symplist/agent";
import { SimonRepository, SimonTranscriptStorage } from "@symplist/core/simon";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { toWorkerError, WorkerError } from "../../infra/errors.ts";
import { type WorkerRuntime, workerRuntime } from "../../infra/runtime.ts";
import { d1 } from "../../queues.ts";
import { conversationOwner, createTranscriptStorage } from "./transcript-adapter.ts";

/**
 * Simon as a durable chat session (note 07 §8.1, §8.3).
 *
 * A session keeps one conversation alive across runs, so a follow-up that arrives while the run is
 * still parked answers without paying the cold boot that a fresh `simon-run` pays every time. What
 * it must not do is move user content or the authorization record off Symplist:
 *
 * - **Transcript.** Registering a storage is what stops the runtime writing its own plaintext
 *   transcript to platform object storage after every turn. Ours is D1 under the account data key,
 *   and account purge reaches it (§5.6).
 * - **Approvals stay ours.** A connector action is gated by an `approvals` row bound to the exact
 *   arguments, connection and expiry, with one pending row per run. That record is the authorization,
 *   so this agent never delegates the gate to the runtime's own human-in-the-loop mechanism.
 * - **Delivery stays Nest.** Note 07 records backend-only browser delivery as the confirmed route
 *   and direct platform streaming as an evaluated alternative. Chunks reach the browser through the
 *   signed relay exactly as `simon-run` sends them.
 *
 * The session is keyed on the Symplist conversation id, so identity is ours and a run is only ever
 * the compute that happens to be serving it.
 */

/** Idle before the session releases its run. Longer keeps a follow-up warm; it also holds compute. */
export const SIMON_CHAT_IDLE_SECONDS = 120;

/** Resolves the runtime lazily so a content-bearing payload is refused before any credential loads. */
async function resolveRuntime(): Promise<WorkerRuntime> {
  const runtime = await workerRuntime();
  if (!runtime.config.DURABLE) throw new AbortTaskRunError("simon.local_disabled");
  return runtime;
}

export const simonChat = chat.agent({
  id: "simon-chat",
  queue: d1,
  machine: "micro",
  maxDuration: 900,
  idleTimeoutInSeconds: SIMON_CHAT_IDLE_SECONDS,

  /**
   * The conversation lives in D1, so the platform snapshot is never written. Resolved per call
   * rather than captured, because the runtime may serve a continuation in a fresh process.
   */
  storage: {
    async load(scope: { chatId: string }, options?: { limit?: number; before?: string }) {
      const runtime = await resolveRuntime();
      return reportingD1Counters(runtime.d1Counters, { task: "simon-chat" }, () =>
        createTranscriptStorage(runtime.db, transcripts(runtime)).load(scope, options),
      );
    },
    async save(context: { chatId: string }, changeset: unknown) {
      const runtime = await resolveRuntime();
      await reportingD1Counters(runtime.d1Counters, { task: "simon-chat" }, () =>
        createTranscriptStorage(runtime.db, transcripts(runtime)).save(context, changeset),
      );
    },
  } as never,

  async run({ chatId, messages, signal, streamText, ctx }) {
    const runtime = await resolveRuntime();
    return reportingD1Counters(
      runtime.d1Counters,
      { task: "simon-chat", runId: ctx.run.id },
      async () => {
        // The chat id is the Symplist conversation; the owner comes from D1, never from the client.
        const ownerId = await conversationOwner(runtime.db, chatId);
        const repository = new SimonRepository({
          db: runtime.db,
          keys: runtime.keys,
          now: () => Date.now(),
          policy: { betaAccessRequired: runtime.config.BETA_ACCESS_REQUIRED },
          quickChatTtlHours: runtime.config.QUICK_CHAT_TTL_HOURS,
        });
        // Beta access, task archival and quick-chat expiry are rechecked here, not just when the
        // message was accepted: a session parked between turns must not keep answering after a relock
        // (note 04). loadConversation throws a stable code for each of those.
        const conversation = await repository.loadConversation(ownerId, chatId);
        const kind = String(conversation.row.kind) === "quick" ? "quick" : "task";
        const models = createSimonModels(runtime.config);
        const selected = models.resolve(runtime.config.AI_DEFAULT_TIER);
        if (typeof selected.model !== "object") throw new WorkerError("ai.unavailable");

        try {
          return streamText({
            model: selected.model,
            system: simonInstructions(kind),
            messages,
            abortSignal: signal,
            maxOutputTokens: SIMON_MAX_OUTPUT_TOKENS_PER_STEP,
            maxRetries: 0,
            providerOptions: { openai: { parallelToolCalls: false, store: false } },
          });
        } catch (error) {
          // Provider text can quote the request; only a stable code leaves this boundary.
          throw toWorkerError(error);
        }
      },
    );
  },
});

function transcripts(runtime: WorkerRuntime): SimonTranscriptStorage {
  return new SimonTranscriptStorage({
    db: runtime.db,
    keys: runtime.keys,
    now: () => Date.now(),
  });
}
