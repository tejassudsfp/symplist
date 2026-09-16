import {
  ComposioSessions,
  ConnectionMutations,
  ConnectionsService,
  ConnectionWebhooks,
} from "@symplist/core/connections";
import { SimonRepository } from "@symplist/core/simon";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import {
  ComposioLifecycleProvider,
  createComposioClient,
  executionClient,
  IntegrationError,
  ToolkitCatalogue,
  unavailableConnectionProvider,
} from "@symplist/integrations";
import type { Clock } from "../../common/clock.ts";
import type { ApiConfig } from "../../infra/config/api-config.ts";

export const CONNECTIONS_RUNTIME = "symplist:CONNECTIONS_RUNTIME";
export interface ConnectionsRuntime {
  readonly enabled: boolean;
  readonly service: ConnectionsService;
  readonly mutations: ConnectionMutations;
  readonly catalogue: Pick<ToolkitCatalogue, "list">;
  readonly webhooks: ConnectionWebhooks;
  readonly client?: ReturnType<typeof createComposioClient>;
}

export function createConnectionsRuntime(
  db: DbClient,
  keys: KeyProvider,
  clock: Clock,
  config: ApiConfig,
  changed: (owner: string, id: string) => Promise<void>,
): ConnectionsRuntime {
  const client = config.COMPOSIO_API_KEY
    ? createComposioClient(config.COMPOSIO_API_KEY)
    : undefined;
  const provider =
    client && config.COMPOSIO_API_KEY
      ? new ComposioLifecycleProvider(client, config.COMPOSIO_API_KEY)
      : unavailableConnectionProvider();
  const policy = { betaAccessRequired: config.BETA_ACCESS_REQUIRED };
  const now = () => clock.now();
  const sessions = client
    ? new ComposioSessions({ db, client: executionClient(client), policy, now })
    : {
        use: async (): Promise<never> => {
          throw new IntegrationError("integration.unavailable");
        },
      };
  const catalogue = client
    ? new ToolkitCatalogue(client.getClient(), now)
    : { list: async () => [] };
  const repository = new SimonRepository({
    db,
    keys,
    policy,
    now,
    quickChatTtlHours: config.QUICK_CHAT_TTL_HOURS,
  });
  return {
    enabled: client !== undefined,
    client,
    catalogue,
    service: new ConnectionsService({
      db,
      keys,
      policy,
      now,
      sessions,
      provider,
      catalogue,
      apiOrigin: config.API_ORIGIN,
    }),
    mutations: new ConnectionMutations({ repository, provider, sessions, changed }),
    webhooks: new ConnectionWebhooks(repository, sessions, changed),
  };
}
