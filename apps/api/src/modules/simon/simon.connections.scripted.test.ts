import type { DbClient } from "@symplist/db";
import {
  type ConnectionToolAuthority,
  ConnectionTools,
  sessionConfiguration,
} from "@symplist/integrations";
import { describe, expect, it } from "vitest";
import type { ApiConfig } from "../../infra/config/api-config.ts";
import {
  SCRIPTED_CONNECTION_ACTION,
  ScriptedConnectionClient,
  scriptedConnectionSchema,
} from "./simon.connections.scripted.ts";
import { createSimonConnectionsRuntime } from "./simon.connections.ts";

const ownerId = "01234567-89ab-7def-8123-456789abcdef";
const connection = {
  id: "01234567-89ab-7def-8123-456789abcdea",
  ownerId,
  toolkit: "gmail",
  connectedAccountId: "ca_scripted_browser",
  generation: 1,
  approvalMode: "all" as const,
};

async function tools() {
  const client = new ScriptedConnectionClient();
  const session = await client.sessions.create(
    ownerId,
    sessionConfiguration({ gmail: [connection.connectedAccountId] }),
  );
  const authority: ConnectionToolAuthority = {
    ownerId,
    check: async () => true,
    connections: async () => [connection],
    authorize: async (expected) => (expected.id === connection.id ? connection : null),
    schema: scriptedConnectionSchema,
  };
  const result = new ConnectionTools(client, session, authority);
  await result.searchTools("send an email");
  await result.getToolSchemas([SCRIPTED_CONNECTION_ACTION.slug]);
  return { client, result };
}

describe("scripted Simon connection provider", () => {
  it("is available only in the API's explicit test plus scripted mode", async () => {
    const db = {} as DbClient;
    const clock = { now: () => 0 };
    const config = {
      NODE_ENV: "test",
      AI_PROVIDER_MODE: "scripted",
      BETA_ACCESS_REQUIRED: true,
    } as ApiConfig;
    await expect(
      createSimonConnectionsRuntime(db, clock, config).schema(SCRIPTED_CONNECTION_ACTION.slug),
    ).resolves.toEqual(SCRIPTED_CONNECTION_ACTION);
    for (const guarded of [
      { ...config, AI_PROVIDER_MODE: "live" as const },
      { ...config, NODE_ENV: "production" as const },
    ]) {
      expect(() =>
        createSimonConnectionsRuntime(db, clock, guarded).schema(SCRIPTED_CONNECTION_ACTION.slug),
      ).toThrow("integration.unavailable");
    }
  });

  it("executes the exact selected account through a no-retry write transport", async () => {
    const { client, result } = await tools();
    const action = await result.resolveAction({
      slug: SCRIPTED_CONNECTION_ACTION.slug,
      connection: connection.id,
      arguments: {
        recipient: "collaborator@example.test",
        subject: "Reviewed launch outline",
        body: "Please review the exact approved outline.",
      },
    });
    await expect(result.executeResolved(action, { sideEffect: true })).resolves.toEqual({
      accepted: true,
    });
    expect(client.attempts).toEqual([
      {
        slug: SCRIPTED_CONNECTION_ACTION.slug,
        account: connection.connectedAccountId,
        maxRetries: 0,
        outcome: "succeeded",
      },
    ]);
  });

  it("records one uncertain attempt and never retries a lost post-send response", async () => {
    const { client, result } = await tools();
    const action = await result.resolveAction({
      slug: SCRIPTED_CONNECTION_ACTION.slug,
      connection: connection.id,
      arguments: {
        recipient: "uncertain@example.test",
        subject: "Potentially accepted action",
        body: "Do not retry this action blindly.",
      },
    });
    await expect(result.executeResolved(action, { sideEffect: true })).rejects.toMatchObject({
      code: "integration.uncertain",
    });
    expect(client.attempts).toEqual([
      {
        slug: SCRIPTED_CONNECTION_ACTION.slug,
        account: connection.connectedAccountId,
        maxRetries: 0,
        outcome: "uncertain",
      },
    ]);
  });
});
