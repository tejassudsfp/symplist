import { auth, sessions, TriggerClient } from "@trigger.dev/sdk";
import type { TriggerRunsClient } from "./executor.ts";

/**
 * The real Trigger.dev client for the api (§8.1), configured per instance with the api's
 * `TRIGGER_SECRET_KEY` rather than the global `configure()`. Only created when durable work may
 * exist, so a local-mode api never needs Trigger credentials.
 *
 * `sessions` has no per-instance counterpart on `TriggerClient` — it reads the ambient API client —
 * so each call runs inside `auth.withAuth`, which scopes the same secret key to that call alone.
 */
export function createTriggerRunsClient(secretKey: string): TriggerRunsClient {
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
        return { runId: created.runId };
      },
    },
  };
}
