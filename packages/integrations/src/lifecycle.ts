import type { Composio } from "@composio/core";
import { IntegrationError, normalizeIntegrationError } from "./errors.ts";

export interface ProviderAccount {
  readonly id: string;
  readonly toolkit: string;
  readonly status: string;
}

export interface ConnectionLifecycleProvider {
  authConfigs(
    toolkit: string,
    kind: "managed" | "api_key" | "none",
    cursor?: string,
  ): Promise<{
    items: readonly {
      id: string;
      toolkit: string;
      enabled: boolean;
      managed: boolean;
      scheme: string;
    }[];
    cursor: string | null;
  }>;
  createAuthConfig(toolkit: string, kind: "managed" | "api_key" | "none"): Promise<string>;
  link(
    ownerId: string,
    configId: string,
    callbackUrl: string,
    alias?: string,
  ): Promise<{ id: string; url: string }>;
  complete(sessionUri: string, ownerId: string): Promise<void>;
  account(id: string): Promise<ProviderAccount>;
  accounts(
    ownerId: string,
    cursor?: string,
  ): Promise<{ items: readonly ProviderAccount[]; cursor: string | null }>;
  revoke(id: string): Promise<void>;
}

/** Native reads/revocation remain available when an operator removes provider configuration. */
export function unavailableConnectionProvider(): ConnectionLifecycleProvider {
  const unavailable = async (): Promise<never> => {
    throw new IntegrationError("integration.unavailable");
  };
  return {
    authConfigs: unavailable,
    createAuthConfig: unavailable,
    link: unavailable,
    complete: unavailable,
    account: unavailable,
    accounts: unavailable,
    revoke: unavailable,
  };
}

/** All account creation uses hosted Connect Links; credentials never enter this process. */
export class ComposioLifecycleProvider implements ConnectionLifecycleProvider {
  constructor(
    private readonly client: Composio,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async authConfigs(toolkit: string, kind: "managed" | "api_key" | "none", cursor?: string) {
    try {
      const result = await this.client.authConfigs.list({
        toolkit,
        limit: 50,
        isComposioManaged: kind === "managed",
        ...(cursor ? { cursor } : {}),
      });
      return {
        items: result.items.map((item) => ({
          id: item.id,
          toolkit: item.toolkit.slug,
          enabled: item.status === "ENABLED",
          managed: item.isComposioManaged === true,
          scheme: item.authScheme ?? "",
        })),
        cursor: result.nextCursor,
      };
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }

  async createAuthConfig(toolkit: string, kind: "managed" | "api_key" | "none") {
    try {
      const result = await this.client
        .getClient()
        .withOptions({ maxRetries: 0, timeout: 15_000 })
        .authConfigs.create({
          toolkit: { slug: toolkit },
          auth_config:
            kind === "managed"
              ? { type: "use_composio_managed_auth", is_enabled_for_tool_router: true }
              : {
                  type: "use_custom_auth",
                  authScheme: kind === "api_key" ? "API_KEY" : "NO_AUTH",
                  credentials: {},
                  is_enabled_for_tool_router: true,
                },
        });
      if (result.toolkit.slug !== toolkit)
        throw new IntegrationError("integration.invalid_response");
      return result.auth_config.id;
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }

  async link(ownerId: string, configId: string, callbackUrl: string, alias?: string) {
    try {
      // Equivalent to connectedAccounts.link(..., {allowMultiple:true}), using the raw clone so
      // the creation cannot be retried. allowMultiple is an SDK preflight toggle, not a wire field.
      const result = await this.client
        .getClient()
        .withOptions({ maxRetries: 0, timeout: 15_000 })
        .link.create({
          user_id: ownerId,
          auth_config_id: configId,
          callback_url: callbackUrl,
          ...(alias ? { alias } : {}),
        });
      const url = result.redirect_url ? new URL(result.redirect_url) : null;
      if (url?.protocol !== "https:" || url.username || url.password || url.hash)
        throw new IntegrationError("integration.invalid_response");
      return { id: result.connected_account_id, url: url.href };
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }

  async complete(sessionUri: string, ownerId: string): Promise<void> {
    if (!sessionUri || sessionUri.length > 4096)
      throw new IntegrationError("integration.invalid_arguments");
    try {
      // This is a token sent to a fixed provider endpoint, NEVER a URL to fetch. The installed SDK
      // does not yet expose complete_auth. Do not retry this single-use identity attestation.
      const response = await this.fetcher(
        "https://backend.composio.dev/api/v3.1/connected_accounts/complete_auth",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
          body: JSON.stringify({ session_uri: sessionUri, user_id: ownerId }),
        },
      );
      await response.body?.cancel();
      if (!response.ok) throw { status: response.status };
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }

  async account(id: string): Promise<ProviderAccount> {
    try {
      const result = await this.client.connectedAccounts.get(id);
      return { id: result.id, toolkit: result.toolkit.slug, status: result.status };
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }

  async accounts(ownerId: string, cursor?: string) {
    try {
      const result = await this.client.connectedAccounts.list({
        userIds: [ownerId],
        statuses: [
          "ACTIVE",
          "EXPIRED",
          "FAILED",
          "REVOKED",
          "INACTIVE",
          "INITIATED",
          "INITIALIZING",
        ],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      return {
        items: result.items.map((item) => ({
          id: item.id,
          toolkit: item.toolkit.slug,
          status: item.status,
        })),
        cursor: result.nextCursor ?? null,
      };
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }

  async revoke(id: string): Promise<void> {
    try {
      await this.client
        .getClient()
        .withOptions({ maxRetries: 0, timeout: 10_000 })
        .connectedAccounts.delete(id, { revoke_on_delete: true });
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 404) return;
      throw normalizeIntegrationError(error);
    }
  }
}
