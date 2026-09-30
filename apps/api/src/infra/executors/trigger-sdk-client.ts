import type { TriggerRunsClient } from "./executor.ts";

/**
 * The real Trigger.dev client for the api (§8.1), configured per instance with the api's
 * `TRIGGER_SECRET_KEY` rather than the global `configure()`.
 *
 * **The SDK is loaded on demand, and that is the point of this function being async.** It was already
 * only *called* when durable work may exist — the comment said so — but a static import put
 * `@trigger.dev/sdk` in the module graph regardless: about 35MB, plus the 82MB of `@opentelemetry` it
 * drags behind it. A `DURABLE=false` api never calls a line of it, and an offline install (note 18,
 * load it and need not have it installed at all, which is also what makes `DURABLE=false` the genuinely
 * dependency-free self-hosted topology the docs already claim it is.
 *
 * `sessions` has no per-instance counterpart on `TriggerClient` — it reads the ambient API client —
 * so each call runs inside `auth.withAuth`, which scopes the same secret key to that call alone.
 * That applies to `open(...).in.send` and `retrieve` exactly as it does to `start`.
 */
export async function createTriggerRunsClient(secretKey: string): Promise<TriggerRunsClient> {
  const { auth, sessions, TriggerClient } = await import("@trigger.dev/sdk");
  const client = new TriggerClient({ secretKey });
  return {
    tasks: {
      trigger: async (taskIdentifier, payload, options) => {
        const handle = await client.tasks.trigger(taskIdentifier, payload as never, options);
        return { id: handle.id };
      },
    },
    runs: {
      retrieve: async (runId) => {
        const run = await client.runs.retrieve(runId);
        return { id: run.id, status: run.status };
      },
      cancel: async (runId) => {
        await client.runs.cancel(runId);
      },
    },
    sessions: {
      start: async (input) => {
        const created = await auth.withAuth({ accessToken: secretKey }, () =>
          sessions.start(input),
        );
        return { runId: created.runId, isCached: created.isCached === true };
      },
      append: async (externalId, record) => {
        await auth.withAuth({ accessToken: secretKey }, () =>
          sessions.open(externalId).in.send(record as never),
        );
      },
      currentRunId: async (externalId) => {
        const session = await auth.withAuth({ accessToken: secretKey }, () =>
          sessions.retrieve(externalId),
        );
        return typeof session.currentRunId === "string" ? session.currentRunId : null;
      },
    },
  };
}
