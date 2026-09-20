import { Composio, logger } from "@composio/core";

const discardProviderLog = () => undefined;
const privateProviderLogger = {
  error: discardProviderLog,
  warn: discardProviderLog,
  info: discardProviderLog,
  debug: discardProviderLog,
};

/** Explicit credentials only: never fall through to SDK environment discovery. */
export function createComposioClient(apiKey: string): Composio {
  if (!apiKey.trim()) throw new Error("integration.unavailable");
  // SDK logs can include arguments/results; our runtimes report only normalized stable codes.
  Object.assign(logger, privateProviderLogger);
  const client = new Composio({
    apiKey,
    allowTracking: false,
    disableVersionCheck: true,
    dangerouslyAllowAutoUploadDownloadFiles: false,
  });
  client.getClient().logger = privateProviderLogger;
  client.getClient().logLevel = "off";
  return client;
}

export interface ComposioSession {
  readonly sessionId: string;
  update(config: { connectedAccounts: Record<string, string[]> }): Promise<void>;
  execute(
    slug: string,
    args: Record<string, unknown>,
    options?: { account: string },
  ): Promise<{
    data: Record<string, unknown>;
    error: string | null;
    logId: string;
  }>;
  delete(): Promise<unknown>;
}

export interface SessionConfiguration {
  sandbox: { enable: false };
  manageConnections: false;
  multiAccount: { enable: true; requireExplicitSelection: true };
  connectedAccounts: Record<string, string[]>;
}

/** Structural subset shared with the fidelity-tested fake; no provider-owned agent/tools. */
export interface ComposioExecutionClient {
  sessions: {
    create(userId: string, config: SessionConfiguration): Promise<ComposioSession>;
    use(id: string): Promise<ComposioSession>;
  };
  getClient(): {
    withOptions(options: { maxRetries: 0 }): {
      toolRouter: {
        session: {
          execute(
            sessionId: string,
            args: {
              tool_slug: string;
              arguments: Record<string, unknown>;
              account: string;
            },
          ): Promise<{ data: Record<string, unknown>; error: string | null; log_id: string }>;
        };
      };
    };
  };
}

export function sessionConfiguration(
  connectedAccounts: Record<string, string[]>,
): SessionConfiguration {
  return {
    sandbox: { enable: false },
    manageConnections: false,
    multiAccount: { enable: true, requireExplicitSelection: true },
    connectedAccounts,
  };
}

/** Compile-time contract: the installed SDK must implement the structural execution boundary. */
export function executionClient(client: Composio): ComposioExecutionClient {
  return client;
}
