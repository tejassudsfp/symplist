import { ComposioSessions, ConnectionReconciler } from "@symplist/core/connections";
import { SimonRepository } from "@symplist/core/simon";
import {
  ComposioLifecycleProvider,
  createComposioClient,
  executionClient,
} from "@symplist/integrations";
import type { WorkerRuntime } from "./runtime.ts";

/** Builds the shared, ids-only Composio maintenance adapter for worker tasks. */
export function connectionReconcilerFor(runtime: WorkerRuntime): ConnectionReconciler | null {
  if (!runtime.config.COMPOSIO_API_KEY) return null;
  const client = createComposioClient(runtime.config.COMPOSIO_API_KEY);
  const provider = new ComposioLifecycleProvider(client, runtime.config.COMPOSIO_API_KEY);
  const policy = { betaAccessRequired: runtime.config.BETA_ACCESS_REQUIRED };
  const repository = new SimonRepository({
    db: runtime.db,
    keys: runtime.keys,
    now: Date.now,
    policy,
    quickChatTtlHours: runtime.config.QUICK_CHAT_TTL_HOURS,
  });
  const sessions = new ComposioSessions({
    db: runtime.db,
    client: executionClient(client),
    policy,
    now: Date.now,
  });
  return new ConnectionReconciler({
    repository,
    provider,
    sessions,
    changed: async (ownerId, connectionId) => {
      await runtime.events.announce({
        type: "connection.status_changed",
        ownerId,
        payload: { connectionId },
      });
    },
  });
}
