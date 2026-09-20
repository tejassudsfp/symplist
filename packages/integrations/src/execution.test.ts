import { FakeComposioClient } from "@symplist/testing";
import { describe, expect, it, vi } from "vitest";
import { sessionConfiguration } from "./client.ts";
import {
  ConnectionTools,
  cleanToolArguments,
  type ExternalConnection,
  type ExternalToolSchema,
} from "./execution.ts";

const ownerId = "0192f0a0-0000-7000-8000-000000000001";
const schema: ExternalToolSchema = {
  slug: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
  description: "Send email",
  schema: {
    type: "object",
    properties: { recipient: { type: "string" } },
    required: ["recipient"],
    additionalProperties: false,
  },
  tags: { readOnlyHint: false, destructiveHint: true },
};

async function fixture() {
  const client = new FakeComposioClient();
  const config = await client.authConfigs.create("gmail", { type: "use_composio_managed_auth" });
  const link = await client.connectedAccounts.link(ownerId, config.id, {
    callbackUrl: "https://api.example.test/callback",
    allowMultiple: true,
  });
  client.completeConnection(link.id);
  const session = await client.sessions.create(ownerId, sessionConfiguration({ gmail: [link.id] }));
  let connections: ExternalConnection[] = [
    { id: "connection-1", ownerId, toolkit: "gmail", connectedAccountId: link.id, generation: 1 },
  ];
  const check = vi.fn(async () => true);
  const authority = {
    ownerId,
    check,
    connections: async () => connections,
    schema: vi.fn(async () => schema),
  };
  const tools = new ConnectionTools(client, session, authority);
  client.setToolHandler("COMPOSIO_SEARCH_TOOLS", () => ({
    data: {
      results: [{ primary_tool_slugs: [schema.slug, "COMPOSIO_REMOTE_BASH_TOOL"] }],
      next_steps_guidance: ["Review a concrete draft"],
    },
  }));
  client.setToolHandler("COMPOSIO_GET_TOOL_SCHEMAS", () => ({ data: { tool_schemas: {} } }));
  client.setToolHandler(schema.slug, () => ({ data: { sent: true } }));
  await tools.searchTools("send email");
  return {
    client,
    session,
    tools,
    check,
    authority,
    setConnections: (value: ExternalConnection[]) => {
      connections = value;
    },
    connections,
  };
}

describe("owner-bound Composio wrapper", () => {
  it("uses the no-sandbox configuration, preserves guidance and only exposes discovered actions", async () => {
    const f = await fixture();
    expect(f.client.sessionsCreated[0]?.config).toMatchObject({
      sandbox: { enable: false },
      manageConnections: false,
      multiAccount: { enable: true, requireExplicitSelection: true },
    });
    expect(await f.tools.searchTools("send email")).toMatchObject({
      next_steps_guidance: ["Review a concrete draft"],
    });
    await expect(f.tools.getToolSchemas(["COMPOSIO_REMOTE_BASH_TOOL"])).rejects.toMatchObject({
      code: "integration.tool_unavailable",
    });
    await expect(f.tools.getToolSchemas(["GMAIL_DELETE_EMAIL"])).rejects.toMatchObject({
      code: "integration.tool_unavailable",
    });
    expect(await f.tools.getToolSchemas([schema.slug])).toEqual([schema]);
  });

  it("strips substituted identity without changing the input and injects the trusted account", async () => {
    const f = await fixture();
    const args = {
      recipient: "maya@example.test",
      user_id: "victim",
      account: "ca_foreign",
      session: { id: "foreign" },
    };
    const action = await f.tools.resolveAction({ slug: schema.slug, arguments: args });
    expect(action.arguments).toEqual({ recipient: "maya@example.test" });
    expect(args.account).toBe("ca_foreign");
    action.arguments.recipient = "changed@example.test";
    expect(await f.tools.executeResolved(action, { sideEffect: true })).toEqual({ sent: true });
    expect(f.client.executions.at(-1)).toMatchObject({
      account: f.connections[0]?.connectedAccountId,
      arguments: { recipient: "maya@example.test" },
      client: "raw",
      maxRetries: 0,
      attempts: 1,
    });
  });

  it("requires schema-valid arguments and rejects forged resolved actions", async () => {
    const f = await fixture();
    await expect(
      f.tools.resolveAction({ slug: schema.slug, arguments: { recipient: 23 } }),
    ).rejects.toMatchObject({ code: "integration.invalid_arguments" });
    const real = await f.tools.resolveAction({
      slug: schema.slug,
      arguments: { recipient: "maya@example.test" },
    });
    await expect(f.tools.executeResolved({ ...real }, { sideEffect: true })).rejects.toMatchObject({
      code: "integration.tool_unavailable",
    });
  });

  it("reviews exact Vault handles but validates plaintext only at the final execution seam", async () => {
    const f = await fixture();
    const reviewed = await f.tools.resolveAction({
      slug: schema.slug,
      arguments: { recipient: { $vault: "grant-id" } },
    });
    expect(reviewed.arguments).toEqual({ recipient: { $vault: "grant-id" } });
    await expect(f.tools.prepareResolvedAction(reviewed, { recipient: 42 })).rejects.toMatchObject({
      code: "integration.invalid_arguments",
    });
    f.check.mockClear();
    const ready = await f.tools.prepareResolvedAction(reviewed, {
      recipient: "maya@example.test",
    });
    // Decrypted plaintext crosses no provider or D1 operation before executeResolved's final fence.
    expect(f.check).not.toHaveBeenCalled();
    await expect(f.tools.executeResolved(ready, { sideEffect: true })).resolves.toEqual({
      sent: true,
    });
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.client.executions.at(-1)).toMatchObject({
      arguments: { recipient: "maya@example.test" },
      client: "raw",
      maxRetries: 0,
    });
    expect(JSON.stringify(f.client.executions)).not.toContain("grant-id");
  });

  it("rejects malformed Vault lookalikes before metadata or execution", async () => {
    const f = await fixture();
    for (const recipient of [
      { $vault: "grant", sibling: "smuggled" },
      { $vault: 7 },
      { $vault: "" },
    ])
      await expect(
        f.tools.resolveAction({ slug: schema.slug, arguments: { recipient } }),
      ).rejects.toMatchObject({ code: "integration.invalid_arguments" });
    expect(f.client.executions.filter((call) => call.slug === schema.slug)).toHaveLength(0);
  });

  it("requires explicit selection for multiple accounts and rejects foreign or wrong-toolkit records", async () => {
    const f = await fixture();
    const one = f.connections[0];
    if (!one) throw new Error("fixture");
    f.setConnections([one, { ...one, id: "connection-2" }]);
    await expect(
      f.tools.resolveAction({ slug: schema.slug, arguments: { recipient: "a" } }),
    ).rejects.toMatchObject({
      code: "integration.account_selection_required",
      details: {
        choices: expect.arrayContaining([
          expect.objectContaining({ id: one.id, toolkit: "gmail" }),
        ]),
      },
    });
    expect(
      (
        await f.tools.resolveAction({
          slug: schema.slug,
          connection: one.id,
          arguments: { recipient: "a" },
        })
      ).connection.id,
    ).toBe(one.id);
    f.setConnections([
      { ...one, ownerId: "foreign" },
      { ...one, toolkit: "github" },
    ]);
    await expect(
      f.tools.resolveAction({ slug: schema.slug, arguments: { recipient: "a" } }),
    ).rejects.toMatchObject({ code: "integration.connection_required" });
  });

  it("rechecks generation and admission immediately before execution", async () => {
    const f = await fixture();
    const action = await f.tools.resolveAction({
      slug: schema.slug,
      arguments: { recipient: "a" },
    });
    f.setConnections([{ ...action.connection, generation: 2 }]);
    await expect(f.tools.executeResolved(action, { sideEffect: true })).rejects.toMatchObject({
      code: "integration.connection_required",
    });
    f.check.mockResolvedValue(false);
    await expect(f.tools.searchTools("email")).rejects.toMatchObject({
      code: "integration.unauthorized",
    });
    expect(f.client.executions).toHaveLength(1);
  });

  it.each([{ timeout: true } as const, { httpError: 500 } as const])(
    "never retries an ambiguous write (%j)",
    async (outcome) => {
      const f = await fixture();
      const call = vi.fn(() => outcome);
      f.client.setToolHandler(schema.slug, call);
      const action = await f.tools.resolveAction({
        slug: schema.slug,
        arguments: { recipient: "a" },
      });
      await expect(f.tools.executeResolved(action, { sideEffect: true })).rejects.toMatchObject({
        code: "integration.uncertain",
      });
      expect(call).toHaveBeenCalledTimes(1);
    },
  );

  it("manage_connections is native and never calls provider connection-management tools", async () => {
    const f = await fixture();
    expect(await f.tools.manageConnections("github")).toEqual({
      status: "connect_required",
      connections: [],
      settingsPath: "/settings/connections",
    });
    expect(await f.tools.manageConnections("gmail")).toMatchObject({
      status: "connected",
      connections: [{ id: "connection-1", toolkit: "gmail" }],
    });
    expect(f.client.executions).toHaveLength(1);
  });

  it("bounds discovery results and arguments without copying content into errors", async () => {
    const f = await fixture();
    const marker = "private-marker";
    f.client.setToolHandler("COMPOSIO_SEARCH_TOOLS", () => ({
      data: { text: marker.repeat(12000) },
    }));
    await expect(f.tools.searchTools("email")).rejects.toThrow("integration.invalid_response");
    expect(() => cleanToolArguments({ value: marker.repeat(12000) })).toThrow(
      "integration.invalid_arguments",
    );
    expect(cleanToolArguments({ nested: { account: marker, keep: true } })).toEqual({
      nested: { keep: true },
    });
  });
});
