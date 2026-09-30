import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mcpKeyResultSchema, oauthDecisionResultSchema } from "@symplist/contracts";
import { sql, uuidv7 } from "@symplist/db";
import { FakeClock } from "@symplist/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { assertSecretAbsent } from "../../../test/secret-scan.ts";
import { SearchIndexCoordinator } from "../search/search-index.coordinator.ts";
import { MCP_TOOLS, type McpTools } from "./mcp-tools.ts";

let app: TestApp;
const clients: Client[] = [];
beforeEach(async () => {
  app = await bootTestApp({ clock: new FakeClock(Date.now()) });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app.close();
});
async function grant(scopes = ["tasks:write"], taskIds: string[] | null = null) {
  const { session } = await app.createSignedInUser();
  const response = await app.post("/v1/mcp/grants", {
    session,
    idempotencyKey: uuidv7(),
    body: { name: "MCP test", scopes, taskIds },
  });
  expect(response.status, response.text).toBe(201);
  return { session, ...mcpKeyResultSchema.parse(response.json()) };
}
async function connect(key: string, mode: "auto" | "legacy" = "auto") {
  const client = new Client(
    { name: "Symplist contract client", version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      authProvider: { token: async () => key },
    }),
  );
  return client;
}
function textOutput(result: Awaited<ReturnType<Client["callTool"]>>) {
  const text = result.content?.find((item) => item.type === "text");
  if (text?.type !== "text") throw new Error("Expected text result");
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("incoming stateless MCP over both SDK protocol eras", () => {
  it.each(["auto", "legacy"] as const)(
    "accepts an actual PKCE-issued OAuth JWT in %s mode and stops after refresh revocation",
    async (mode) => {
      const { session } = await app.createSignedInUser();
      const redirect = "http://127.0.0.1:45678/callback";
      const registration = await app.post("/oauth/register", {
        body: {
          client_name: "MCP OAuth client",
          application_type: "native",
          redirect_uris: [redirect],
        },
      });
      expect(registration.status).toBe(201);
      const clientId = (registration.json() as { client_id: string }).client_id;
      const verifier = "v".repeat(43);
      const authorization = await app.get(
        `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${app.config.API_ORIGIN}/mcp`, scope: "tasks:read offline_access", state: "mcp-oauth-contract-state" })}`,
        { session },
      );
      expect(authorization.status).toBe(303);
      const requestId = new URL(authorization.headers.get("location") ?? "").searchParams.get(
        "request",
      );
      const decision = await app.post(`/v1/oauth/requests/${requestId}/decision`, {
        session,
        idempotencyKey: uuidv7(),
        body: { decision: "allow", taskIds: null },
      });
      const callback = new URL(oauthDecisionResultSchema.parse(decision.json()).redirectUrl ?? "");
      expect(callback.searchParams.get("iss")).toBe(app.config.API_ORIGIN);
      const exchanged = await app.post("/oauth/token", {
        body: {
          grant_type: "authorization_code",
          code: callback.searchParams.get("code"),
          code_verifier: verifier,
          redirect_uri: redirect,
          client_id: clientId,
          resource: `${app.config.API_ORIGIN}/mcp`,
        },
      });
      expect(exchanged.status, exchanged.text).toBe(200);
      const tokens = exchanged.json() as { access_token: string; refresh_token: string };
      const client = await connect(tokens.access_token, mode);
      expect(textOutput(await client.callTool({ name: "task_list", arguments: {} }))).toEqual({
        tasks: [],
        nextCursor: null,
      });
      const revoked = await app.post("/oauth/revoke", {
        body: { token: tokens.refresh_token, client_id: clientId },
      });
      expect(revoked.status).toBe(200);
      await expect(client.callTool({ name: "task_list", arguments: {} })).rejects.toThrow();
      await assertSecretAbsent(
        app,
        [tokens.access_token, tokens.refresh_token, callback.searchParams.get("code") ?? ""],
        [revoked],
      );
    },
  );
  it.each(["auto", "legacy"] as const)(
    "starts %s discovery from the 401 challenge and calls guarded tools",
    async (mode) => {
      const issued = await grant();
      let token: string | undefined;
      let discoveries = 0;
      const client = new Client(
        { name: "Discovery contract client", version: "1.0.0" },
        { versionNegotiation: { mode } },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
          authProvider: {
            token: async () => token,
            onUnauthorized: async ({ response }) => {
              discoveries++;
              expect(response.status).toBe(401);
              const challenge = response.headers.get("www-authenticate") ?? "";
              const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
              expect(metadataUrl).toBe(
                `${app.config.API_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
              );
              const metadata = await app.get(new URL(metadataUrl).pathname);
              expect(metadata.status, metadata.text).toBe(200);
              expect(metadata.json()).toMatchObject({
                resource: `${app.config.API_ORIGIN}/mcp`,
                authorization_servers: [app.config.API_ORIGIN],
                scopes_supported: ["tasks:read", "tasks:write"],
              });
              const server = await app.get("/.well-known/oauth-authorization-server");
              expect(server.status, server.text).toBe(200);
              expect(server.json()).toMatchObject({
                issuer: app.config.API_ORIGIN,
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
                client_id_metadata_document_supported: true,
                authorization_response_iss_parameter_supported: true,
              });
              token = issued.key;
            },
          },
        }),
      );
      expect(discoveries).toBe(1);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "task_context",
          "task_list",
          "task_create",
          "task_move",
          "task_document_update_section",
          "task_document_read_section",
        ]),
      );
      for (const forbidden of [
        "vault_grant",
        "manage_connections",
        "artifact_share_create",
        "approve",
        "stop",
        "retry",
        "user_ask",
      ])
        expect(names).not.toContain(forbidden);
      const requestId = uuidv7();
      const created = await client.callTool({
        name: "task_create",
        arguments: { title: "MCP task", requestId },
      });
      expect(created.isError).not.toBe(true);
      const task = textOutput(created);
      expect(task).toMatchObject({ collection: "unclassified", created: true });
      const duplicate = await client.callTool({
        name: "task_create",
        arguments: { title: "MCP task", requestId },
      });
      expect(textOutput(duplicate)).toMatchObject({ taskId: task.taskId, created: false });
      const context = await client.callTool({
        name: "task_context",
        arguments: { taskId: task.taskId },
      });
      expect(context.isError).not.toBe(true);
      expect(textOutput(context)).toMatchObject({
        task: { id: task.taskId, title: "MCP task" },
        document: { revision: null, sections: [] },
      });
    },
  );
  it("refuses missing/invalid credentials and validates Origin before touching a bearer", async () => {
    const issued = await grant();
    expect((await app.post("/mcp", { body: {}, origin: null })).status).toBe(401);
    expect(
      (
        await app.post("/mcp", {
          body: {},
          origin: "https://evil.test",
          headers: { authorization: `Bearer ${issued.key}` },
        })
      ).status,
    ).toBe(403);
    const wrongPort = new URL(app.config.WEB_ORIGIN);
    wrongPort.port = "33333";
    expect(
      (
        await app.post("/mcp", {
          body: {},
          origin: wrongPort.origin,
          headers: { authorization: `Bearer ${issued.key}` },
        })
      ).status,
    ).toBe(403);
    const bad = await app.post("/mcp", {
      body: {},
      origin: null,
      headers: { authorization: "Bearer invalid" },
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(app.logs.text()).not.toContain(issued.key);
  });
  it("applies read-only scope and rejects cross-owner, archived and revoked authority", async () => {
    const writable = await grant();
    const writer = await connect(writable.key ?? "");
    const created = textOutput(
      await writer.callTool({
        name: "task_create",
        arguments: { title: "private", requestId: uuidv7() },
      }),
    );
    const readerGrant = await grant(["tasks:read"]);
    const reader = await connect(readerGrant.key ?? "");
    expect(
      (await reader.callTool({ name: "task_context", arguments: { taskId: created.taskId } }))
        .isError,
    ).toBe(true);
    expect(
      (
        await reader.callTool({
          name: "task_create",
          arguments: { title: "forbidden", requestId: uuidv7() },
        })
      ).isError,
    ).toBe(true);
    await app.request("DELETE", `/v1/mcp/grants/${writable.id}`, {
      session: writable.session,
      idempotencyKey: uuidv7(),
    });
    await expect(writer.listTools()).rejects.toThrow();
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM tasks"))).toEqual({ n: 1 });
  });
  it("uses actual encrypted Git document tools and records receipts under the grant ID", async () => {
    const issued = await grant();
    const client = await connect(issued.key ?? "");
    const task = textOutput(
      await client.callTool({
        name: "task_create",
        arguments: { title: "document task", requestId: uuidv7() },
      }),
    );
    const requestId = uuidv7();
    const input = {
      taskId: task.taskId,
      expectedRevision: null,
      placement: "end",
      markdown: "# MCP private page marker\n\nPrivate body marker.\n",
      requestId,
    };
    const updated = await client.callTool({
      name: "task_document_update_section",
      arguments: input,
    });
    expect(updated.isError, JSON.stringify(updated)).not.toBe(true);
    const revision = textOutput(updated).revision;
    const replay = await client.callTool({
      name: "task_document_update_section",
      arguments: input,
    });
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
    expect(textOutput(replay).revision).toBe(revision);
    const outline = textOutput(
      await client.callTool({ name: "task_document_outline", arguments: { taskId: task.taskId } }),
    );
    const entries = outline.entries as { sectionId: string }[];
    const sectionId = entries[0]?.sectionId;
    expect(sectionId).toBeTruthy();
    const read = await client.callTool({
      name: "task_document_read_section",
      arguments: { taskId: task.taskId, sectionId, revision },
    });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    expect(JSON.stringify(textOutput(read))).toContain("MCP private page marker");
    const receipts = await app.db.all(sql("SELECT reader_kind,reader_id FROM read_receipts"));
    expect(receipts).toContainEqual({ reader_kind: "mcp_grant", reader_id: issued.id });
    expect(await app.scanDatabaseFor("MCP private page marker")).toEqual([]);
    expect(app.scanObjectsFor("MCP private page marker")).toEqual([]);
    expect(app.logs.text()).not.toContain("MCP private page marker");
  });
  it("schedules through the actual service with exact retry and scope enforcement", async () => {
    const issued = await grant();
    const client = await connect(issued.key ?? "");
    const taskId = textOutput(
      await client.callTool({
        name: "task_create",
        arguments: { title: "Scheduled MCP task", requestId: uuidv7() },
      }),
    ).taskId;
    const input = {
      taskId,
      operation: "set_deadline",
      expectedVersion: 0,
      deadline: { kind: "date", date: "2030-09-17", zone: "Asia/Kathmandu" },
      requestId: uuidv7(),
    };
    const saved = await client.callTool({ name: "task_schedule", arguments: input });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    expect(textOutput(saved)).toMatchObject({ version: 1, deadline: input.deadline });
    const retried = await client.callTool({ name: "task_schedule", arguments: input });
    expect(textOutput(retried)).toEqual(textOutput(saved));
    expect(
      (
        await client.callTool({
          name: "task_schedule",
          arguments: { ...input, deadline: { ...input.deadline, date: "2030-09-18" } },
        })
      ).isError,
    ).toBe(true);
    const minted = await app.post("/v1/mcp/grants", {
      session: issued.session,
      idempotencyKey: uuidv7(),
      body: { name: "schedule reader", scopes: ["tasks:read"], taskIds: [taskId] },
    });
    const reader = await connect(mcpKeyResultSchema.parse(minted.json()).key ?? "");
    expect(
      textOutput(
        await reader.callTool({ name: "task_schedule", arguments: { taskId, operation: "read" } }),
      ),
    ).toMatchObject({ version: 1 });
    expect(
      (
        await reader.callTool({
          name: "task_schedule",
          arguments: { ...input, requestId: uuidv7() },
        })
      ).isError,
    ).toBe(true);
    expect(await app.db.all(sql("SELECT actor FROM schedule_audit"))).toEqual([{ actor: "mcp" }]);
  });
  it("never returns document content when its grant is revoked during retrieval", async () => {
    const issued = await grant();
    const client = await connect(issued.key ?? "");
    const taskId = textOutput(
      await client.callTool({
        name: "task_create",
        arguments: { title: "Revocation race", requestId: uuidv7() },
      }),
    ).taskId;
    const tools = app.inject<McpTools>(MCP_TOOLS);
    const outline = tools.documents.outline.bind(tools.documents);
    const spy = vi.spyOn(tools.documents, "outline").mockImplementation(async (...args) => {
      const result = await outline(...args);
      await app.db.run(
        sql("UPDATE mcp_grants SET revoked_at = 1, generation = generation + 1 WHERE id = :id", {
          id: issued.id,
        }),
      );
      return { ...result, privateMarker: "revoked-read-output" };
    });
    try {
      const response = await client.callTool({
        name: "task_document_outline",
        arguments: { taskId },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain("revoked-read-output");
    } finally {
      spy.mockRestore();
    }
  });
  it("snapshots encrypted artifacts, lists grants without secrets and revokes through one folded effect", async () => {
    const issued = await grant();
    const client = await connect(issued.key ?? "");
    const taskId = textOutput(
      await client.callTool({
        name: "task_create",
        arguments: { title: "Artifact MCP task", requestId: uuidv7() },
      }),
    ).taskId;
    const write = await client.callTool({
      name: "task_document_update_section",
      arguments: {
        taskId,
        expectedRevision: null,
        placement: "end",
        markdown: "# Private MCP artifact marker\n\nA snapshot.\n",
        requestId: uuidv7(),
      },
    });
    const revision = textOutput(write).revision;
    const input = { taskId, title: "Private MCP artifact title", revision, requestId: uuidv7() };
    const saved = await client.callTool({ name: "artifact_snapshot", arguments: input });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    const artifact = textOutput(saved);
    expect(
      textOutput(await client.callTool({ name: "artifact_snapshot", arguments: input })).id,
    ).toBe(artifact.id);
    const release = await app.post(`/v1/artifacts/${artifact.id}/grants`, {
      session: issued.session,
      idempotencyKey: uuidv7(),
      body: { mode: "link", expectedHead: revision, expiresAt: app.clock.now() + 86400_000 },
    });
    expect(release.status, release.text).toBe(201);
    const body = release.json() as { grant: { id: string }; url: string };
    const list = await client.callTool({ name: "artifact_share_list", arguments: { taskId } });
    expect(list.isError, JSON.stringify(list)).not.toBe(true);
    expect(textOutput(list).grants).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: body.grant.id, status: "active" })]),
    );
    expect(JSON.stringify(list)).not.toContain(body.url);
    const revoke = { artifactId: artifact.id, grantId: body.grant.id, requestId: uuidv7() };
    const revoked = await client.callTool({ name: "artifact_share_revoke", arguments: revoke });
    expect(revoked.isError, JSON.stringify(revoked)).not.toBe(true);
    expect(textOutput(revoked)).toMatchObject({
      id: body.grant.id,
      status: "revoked",
      generation: 2,
    });
    expect(
      textOutput(await client.callTool({ name: "artifact_share_revoke", arguments: revoke })),
    ).toEqual(textOutput(revoked));
    expect(
      await app.db.all(sql("SELECT action FROM share_audit WHERE action = 'revoke'")),
    ).toHaveLength(1);
    expect(await app.scanDatabaseFor("Private MCP artifact marker")).toEqual([]);
    expect(app.scanObjectsFor("Private MCP artifact marker")).toEqual([]);
    expect(await app.scanDatabaseFor("Private MCP artifact title")).toEqual([]);
    expect(app.logs.text()).not.toContain("Private MCP artifact");
  });
  it("task-scoped search hides ungranted tasks and parent metadata, then refuses a revoked key", async () => {
    const issued = await grant();
    const writer = await connect(issued.key ?? "");
    const parent = textOutput(
      await writer.callTool({
        name: "task_create",
        arguments: { title: "private parent needle", requestId: uuidv7() },
      }),
    );
    const child = textOutput(
      await writer.callTool({
        name: "task_create",
        arguments: {
          title: "selected child needle",
          parentTaskId: parent.taskId,
          requestId: uuidv7(),
        },
      }),
    );
    await writer.callTool({
      name: "task_create",
      arguments: { title: "private unrelated needle", requestId: uuidv7() },
    });
    const minted = await app.post("/v1/mcp/grants", {
      session: issued.session,
      idempotencyKey: uuidv7(),
      body: { name: "selected agent", scopes: ["tasks:read"], taskIds: [child.taskId] },
    });
    const limited = mcpKeyResultSchema.parse(minted.json());
    const reader = await connect(limited.key ?? "");
    expect(
      (
        await app
          .inject<SearchIndexCoordinator>(SearchIndexCoordinator)
          .runNow(issued.session.userId)
      ).status,
    ).toBe("published");
    const result = await reader.callTool({ name: "task_search", arguments: { query: "needle" } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = textOutput(result);
    expect(JSON.stringify(output)).toContain("selected child needle");
    expect(JSON.stringify(output)).not.toContain("private parent");
    expect(JSON.stringify(output)).not.toContain("private unrelated");
    expect(JSON.stringify(output)).not.toContain(parent.taskId);
    expect(
      (
        await reader.callTool({
          name: "task_search",
          arguments: { query: "needle", taskId: parent.taskId },
        })
      ).isError,
    ).toBe(true);
    await app.request("DELETE", `/v1/mcp/grants/${limited.id}`, {
      session: issued.session,
      idempotencyKey: uuidv7(),
    });
    await expect(
      reader.callTool({ name: "task_search", arguments: { query: "needle" } }),
    ).rejects.toThrow();
  });

  it("lists, adds and applies labels, and shows a scoped grant only the labels on its tasks", async () => {
    const owner = await grant(["tasks:write"]);
    const client = await connect(owner.key ?? "");
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["label_list", "label_create", "task_set_labels"]),
    );
    // A person's own words are not an agent's to withdraw.
    expect(names).not.toContain("label_rename");
    expect(names).not.toContain("label_delete");

    const work = textOutput(
      await client.callTool({ name: "label_create", arguments: { name: "Work", colour: "blue" } }),
    );
    expect(work).toMatchObject({ name: "Work", colour: "blue", created: true });
    // A retry whose first response was lost is told the id its first attempt made, which is why the
    // tool needs no requestId.
    const retried = textOutput(
      await client.callTool({
        name: "label_create",
        arguments: { name: " work ", colour: "rose" },
      }),
    );
    expect(retried).toMatchObject({ labelId: work.labelId, name: "Work", created: false });

    const task = textOutput(
      await client.callTool({
        name: "task_create",
        arguments: { title: "Labelled over MCP", requestId: uuidv7() },
      }),
    );
    const set = await client.callTool({
      name: "task_set_labels",
      arguments: { taskId: task.taskId, labelIds: [work.labelId] },
    });
    expect(set.isError).not.toBe(true);
    expect(textOutput(set)).toEqual({ taskId: task.taskId, labelIds: [work.labelId] });
    expect(textOutput(await client.callTool({ name: "label_list", arguments: {} }))).toMatchObject({
      labels: [expect.objectContaining({ id: work.labelId, taskCount: 1 })],
    });

    // A second label, on no task of the scoped grant below.
    const other = textOutput(
      await client.callTool({ name: "label_create", arguments: { name: "Home", colour: "green" } }),
    );
    const scoped = await app.post("/v1/mcp/grants", {
      session: owner.session,
      idempotencyKey: uuidv7(),
      body: { name: "scoped agent", scopes: ["tasks:write"], taskIds: [task.taskId] },
    });
    expect(scoped.status, scoped.text).toBe(201);
    const limited = await connect(mcpKeyResultSchema.parse(scoped.json()).key ?? "");
    const visible = textOutput(await limited.callTool({ name: "label_list", arguments: {} }));
    // Only the label already on its one task: a grant over one task is not a reason to learn the
    // whole of someone's vocabulary.
    expect(visible).toEqual({
      labels: [expect.objectContaining({ id: work.labelId, name: "Work", taskCount: 1 })],
    });
    expect(JSON.stringify(visible)).not.toContain("Home");
    expect(
      (
        await limited.callTool({
          name: "task_set_labels",
          arguments: { taskId: task.taskId, labelIds: [other.labelId] },
        })
      ).isError,
    ).toBe(true);
    // A label belongs to the whole list, so adding one needs all-task scope.
    expect(
      (
        await limited.callTool({
          name: "label_create",
          arguments: { name: "Sneaked in", colour: "amber" },
        })
      ).isError,
    ).toBe(true);
  });
});
