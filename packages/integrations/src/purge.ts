import { createComposioClient } from "./client.ts";
import { normalizeIntegrationError } from "./errors.ts";
import { ComposioLifecycleProvider, type ProviderAccount } from "./lifecycle.ts";

export interface ConnectionPurgeProvider {
  accounts(ownerId: string): Promise<{ items: readonly ProviderAccount[]; cursor: string | null }>;
  revoke(accountId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

/** No account key or user content is required to remove provider state after crypto-shredding. */
export function createConnectionPurgeProvider(apiKey: string): ConnectionPurgeProvider {
  const client = createComposioClient(apiKey);
  const lifecycle = new ComposioLifecycleProvider(client, apiKey);
  return {
    accounts: (owner) => lifecycle.accounts(owner),
    revoke: (account) => lifecycle.revoke(account),
    deleteSession: async (id) => {
      try {
        await (await client.sessions.use(id)).delete({ signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        const mapped = normalizeIntegrationError(error);
        if (mapped.details.status !== 404) throw mapped;
      }
    },
  };
}
