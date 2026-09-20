import { APPROVAL_POLICY_VERSION, actionPolicy } from "@symplist/agent/policy";
import {
  ComposioSessions,
  createApprovalEditValidator,
  createOwnerConnectionAuthority,
} from "@symplist/core/connections";
import type { ApprovalEditValidator } from "@symplist/core/simon";
import type { DbClient } from "@symplist/db";
import type { ConnectionToolAuthority } from "@symplist/integrations";
import {
  ConnectionTools,
  createComposioClient,
  executionClient,
  IntegrationError,
  readExternalToolSchema,
} from "@symplist/integrations";
import type { Clock } from "../../common/clock.ts";
import type { ApiConfig } from "../../infra/config/api-config.ts";

export const SIMON_CONNECTIONS_RUNTIME = Symbol("SIMON_CONNECTIONS_RUNTIME");

/** Simon-owned adapter over shared core/integration seams; no Connections Nest provider coupling. */
export interface SimonConnectionsRuntime {
  schema(slug: string): ReturnType<typeof readExternalToolSchema>;
  tools(authority: ConnectionToolAuthority): Promise<ConnectionTools>;
  editValidator(ownerId: string): ApprovalEditValidator;
}

export function createSimonConnectionsRuntime(
  db: DbClient,
  clock: Clock,
  config: ApiConfig,
): SimonConnectionsRuntime {
  const client = config.COMPOSIO_API_KEY
    ? createComposioClient(config.COMPOSIO_API_KEY)
    : undefined;
  const policy = { betaAccessRequired: config.BETA_ACCESS_REQUIRED };
  const schema = (slug: string) => {
    if (!client) throw new IntegrationError("integration.unavailable");
    return readExternalToolSchema(client, slug);
  };
  const sessions = client
    ? new ComposioSessions({ db, client: executionClient(client), policy, now: () => clock.now() })
    : undefined;
  return {
    schema,
    tools: async (authority) => {
      if (!client || !sessions) throw new IntegrationError("integration.unavailable");
      return new ConnectionTools(
        executionClient(client),
        await sessions.use(authority.ownerId),
        authority,
      );
    },
    editValidator: (ownerId) =>
      createApprovalEditValidator({
        authority: createOwnerConnectionAuthority({ db, ownerId, policy, schema }),
        actionPolicy,
        policyVersion: APPROVAL_POLICY_VERSION,
      }),
  };
}
