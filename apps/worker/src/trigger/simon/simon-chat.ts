import { SimonTranscriptStorage } from "@symplist/core/simon";
import { sql } from "@symplist/db";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { reportingD1Counters } from "../../infra/d1-counters.ts";
import { WorkerError } from "../../infra/errors.ts";
import { type WorkerRuntime, workerRuntime } from "../../infra/runtime.ts";
import { d1 } from "../../queues.ts";
import { runDurableSimon } from "./simon-run.ts";
import { conversationOwner, createTranscriptStorage } from "./transcript-adapter.ts";

/**
 * Simon hosted in a durable chat session (note 07 §8.1, §8.3).
 *
 * The session exists for one reason: it keeps a run parked between turns, so a follow-up arriving
 * inside the idle window answers without the cold boot a fresh `simon-run` pays every time. It is
 * deliberately only that. The turn itself is `runDurableSimon`, unchanged and shared with
 * `simon-run`, so the two executors cannot drift: same tools, same approval pauses, same document
 * and Vault authority, same checkpoints, same relay.
 *
 * Three things therefore stay exactly where they were:
 *
 * - Messages and runs are Symplist's. Nest accepts the message and records the run before this task
 *   hears about it; the session is handed only a run id. Ids enter, enums and counts leave.
 * - Approvals stay ours. A gated action pauses the run against an `approvals` row bound to exact
 *   arguments, connection and expiry. The runtime's own human-in-the-loop path is unused.
 * - Delivery stays Nest. `run()` returns a result rather than a stream, so the runtime pipes nothing
 *   to its output channel; chunks reach the browser through the signed relay as before.
 *
 * What the session does hold is the transcript, and registering a storage is what stops the runtime
 * writing its own plaintext copy to platform object storage after every turn. Ours is D1 under the
 * account data key, and account purge reaches it.
 */

/** Idle before the session releases its run. Longer keeps a follow-up warm; it also holds compute. */
export const SIMON_CHAT_IDLE_SECONDS = 120;

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Resolves the runtime lazily, so a payload is refused before any credential loads. */
async function resolveRuntime(): Promise<WorkerRuntime> {
  const runtime = await workerRuntime();
  if (!runtime.config.DURABLE) throw new AbortTaskRunError("simon.local_disabled");
  return runtime;
}

/**
 * The run this turn executes, proved to belong to this chat.
 *
 * `claim` fences a run on owner access, executor and generation, but it is reached with a run id
 * alone -- correct for `simon-run`, whose payload comes from our own dispatcher. A session is
 * addressed by chat id and its client data is not a trust boundary, so the two are tied together
 * here: the run must already belong to this conversation, or the turn does not start.
 */
export async function runForChat(
  runtime: WorkerRuntime,
  chatId: string,
  clientData: unknown,
): Promise<string> {
  const runId = (clientData as { runId?: unknown } | undefined)?.runId;
  if (typeof runId !== "string" || !runIdPattern.test(runId))
    throw new WorkerError("simon.payload_invalid");
  const ownerId = await conversationOwner(runtime.db, chatId);
  const row = await runtime.db.first(
    sql(
      "SELECT 1 AS ok FROM runs WHERE id = :run AND conversation_id = :chat AND owner_id = :owner",
      {
        run: runId,
        chat: chatId,
        owner: ownerId,
      },
    ),
  );
  if (!row) throw new WorkerError("simon.not_found");
  return runId;
}

function transcripts(runtime: WorkerRuntime): SimonTranscriptStorage {
  return new SimonTranscriptStorage({
    db: runtime.db,
    keys: runtime.keys,
    now: () => Date.now(),
  });
}

export const simonChat = chat.agent({
  id: "simon-chat",
  queue: d1,
  machine: "micro",
  maxDuration: 900,
  idleTimeoutInSeconds: SIMON_CHAT_IDLE_SECONDS,

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

  async run({ chatId, clientData, signal, ctx }) {
    const runtime = await resolveRuntime();
    return reportingD1Counters(
      runtime.d1Counters,
      { task: "simon-chat", runId: ctx.run.id },
      async () => {
        const runId = await runForChat(runtime, chatId, clientData);
        // The same turn simon-run executes. Returning its result rather than a stream is what keeps
        // browser delivery on the relay instead of the session's output channel.
        return runDurableSimon({ runId }, runtime, ctx.attempt.number, signal);
      },
    );
  },
});
