import {
  type ComposioContractSubject,
  describeComposioWrapperContract,
  FakeComposioClient,
  liveComposioSettings,
} from "@symplist/testing";
import { describe, expect, it } from "vitest";
import { ToolkitCatalogue } from "./catalogue.ts";
import { createComposioClient, sessionConfiguration } from "./client.ts";
import {
  ConnectionTools,
  type ExternalConnection,
  type ExternalToolSchema,
  type ResolvedExternalAction,
} from "./execution.ts";

const ownerId = "0192f0a0-0000-7000-8000-000000000001";
const schema: ExternalToolSchema = {
  slug: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
  description: "Synthetic contract action",
  schema: {
    type: "object",
    properties: {
      recipient: { type: "string" },
      nested: {
        type: "object",
        properties: { keep: { type: "boolean" } },
        required: ["keep"],
        additionalProperties: false,
      },
    },
    required: ["recipient"],
    additionalProperties: false,
  },
  tags: { readOnlyHint: false, destructiveHint: true },
};

async function fakeSubject(): Promise<ComposioContractSubject> {
  const client = new FakeComposioClient();
  const config = await client.authConfigs.create("gmail", { type: "use_composio_managed_auth" });
  const link = await client.connectedAccounts.link(ownerId, config.id, {
    callbackUrl: "https://api.example.test/callback",
    allowMultiple: true,
  });
  client.completeConnection(link.id);
  const session = await client.sessions.create(ownerId, sessionConfiguration({ gmail: [link.id] }));
  const connections: ExternalConnection[] = [
    {
      id: "connection-1",
      ownerId,
      toolkit: "gmail",
      connectedAccountId: link.id,
      generation: 1,
      approvalMode: "all",
    },
  ];
  const tools = new ConnectionTools(client, session, {
    ownerId,
    check: async () => true,
    connections: async () => connections,
    schema: async () => schema,
  });
  client.setToolHandler("COMPOSIO_SEARCH_TOOLS", () => ({
    data: { results: [{ primary_tool_slugs: [schema.slug] }] },
  }));
  client.setToolHandler("COMPOSIO_GET_TOOL_SCHEMAS", () => ({ data: { tool_schemas: {} } }));
  client.setToolHandler(schema.slug, () => ({ data: { accepted: true } }));
  await tools.searchTools("synthetic contract query");

  return {
    searchTools: (query) => tools.searchTools(query),
    getToolSchemas: (slugs) => tools.getToolSchemas(slugs),
    resolveAction: (input) => tools.resolveAction(input),
    executeResolved: (action, options) =>
      tools.executeResolved(action as unknown as ResolvedExternalAction, options),
    manageConnections: (toolkit) => tools.manageConnections(toolkit),
    executions: () =>
      client.executions.map((execution) => ({
        client: execution.client,
        maxRetries: execution.maxRetries,
        attempts: execution.attempts,
        slug: execution.slug,
        account: execution.account,
        arguments: { ...execution.arguments },
      })),
    failureProbe: async () => {
      client.setToolHandler(schema.slug, () => ({ httpError: 429, retryAfterSeconds: 13 }));
      const action = await tools.resolveAction({
        slug: schema.slug,
        arguments: { recipient: "synthetic" },
      });
      return tools.executeResolved(action, { sideEffect: false });
    },
    expectedFailureCode: "integration.rate_limited",
    marker: "symplist-contract-marker-7f9d",
  };
}

describeComposioWrapperContract({ name: "fake Composio client", create: fakeSubject });

const live = liveComposioSettings();
describeComposioWrapperContract({
  name: "live Composio metadata",
  skipReason: "skipReason" in live ? live.skipReason : undefined,
  testTimeoutMs: 30_000,
  liveProbe: async () => {
    if (!("settings" in live)) throw new Error("live Composio target was skipped");
    const client = createComposioClient(live.settings.apiKey);
    // Catalogue metadata is bounded and content-free; this never creates a session or invokes a
    // connector action. The wrapper itself remains covered by the fake subject above.
    const catalogue = new ToolkitCatalogue(client.getClient());
    const toolkits = await catalogue.list();
    expect(toolkits.length).toBeLessThanOrEqual(20_000);
  },
});

describe("Composio live-contract gating", () => {
  it("reports a visible reason without echoing a supplied credential", () => {
    const result = liveComposioSettings({ COMPOSIO_API_KEY: "composio-secret-test" });
    expect(result).toEqual({
      skipReason: "set LIVE_COMPOSIO=1 to run the bounded live Composio contract",
    });
    expect(JSON.stringify(result)).not.toContain("composio-secret-test");
  });

  it("reports missing credentials without exposing provider state", () => {
    expect(liveComposioSettings({ LIVE_COMPOSIO: "1" })).toEqual({
      skipReason: "LIVE_COMPOSIO=1 but COMPOSIO_API_KEY missing",
    });
  });
});
