import { mcpGrantListSchema, mcpKeyResultSchema } from "@symplist/contracts";
import { McpGrants } from "@symplist/core/mcp";
import { sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";

let app: TestApp;
const body = { name: "private_key_label_marker", scopes: ["tasks:read"], taskIds: null };
beforeEach(async () => {
  app = await bootTestApp();
});
afterEach(async () => app.close());

describe("MCP grant trusted UI routes", () => {
  it("mints a key once and scans every D1/R2/log sink for raw credentials and labels", async () => {
    const { session } = await app.createSignedInUser();
    const request = uuidv7();
    const response = await app.post("/v1/mcp/grants", { session, body, idempotencyKey: request });
    expect(response.status, response.text).toBe(201);
    const issued = mcpKeyResultSchema.parse(response.json());
    expect(issued.key).toMatch(/^sym_/);
    const replay = await app.post("/v1/mcp/grants", { session, body, idempotencyKey: request });
    expect(replay.status, replay.text).toBe(200);
    expect(replay.json()).toMatchObject({
      id: issued.id,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    expect(replay.json()).not.toHaveProperty("key");
    for (const marker of [issued.key ?? "missing", body.name]) {
      expect(await app.scanDatabaseFor(marker)).toEqual([]);
      expect(app.scanObjectsFor(marker)).toEqual([]);
      expect(app.logs.text()).not.toContain(marker);
    }
    const listed = mcpGrantListSchema.parse((await app.get("/v1/mcp/grants", { session })).json());
    expect(listed.server).toBe(`${app.config.API_ORIGIN}/mcp`);
    expect(listed.grants).toHaveLength(1);
    expect(listed.grants[0]).toMatchObject({ id: issued.id, name: body.name, taskIds: null });
    expect(JSON.stringify(listed)).not.toContain(issued.key);
  });

  it("rejects missing CSRF, missing idempotency, unsupported permissions and locked accounts", async () => {
    const { session } = await app.createSignedInUser();
    expect(
      (await app.post("/v1/mcp/grants", { session, body, idempotencyKey: uuidv7(), csrf: null }))
        .status,
    ).toBe(403);
    expect((await app.post("/v1/mcp/grants", { session, body })).status).toBe(400);
    expect(
      (
        await app.post("/v1/mcp/grants", {
          session,
          body: { ...body, scopes: ["vault:read"] },
          idempotencyKey: uuidv7(),
        })
      ).status,
    ).toBe(400);
    const locked = await app.createSignedInUser("locked");
    expect(
      (
        await app.post("/v1/mcp/grants", {
          session: locked.session,
          body,
          idempotencyKey: uuidv7(),
        })
      ).status,
    ).toBe(403);
    expect(await app.db.first(sql("SELECT COUNT(*) AS count FROM mcp_grants"))).toEqual({
      count: 0,
    });
  });

  it("lists and revokes only the owner's grants, with idempotent generation fencing", async () => {
    const { session } = await app.createSignedInUser();
    const other = await app.createSignedInUser();
    const issued = mcpKeyResultSchema.parse(
      (await app.post("/v1/mcp/grants", { session, body, idempotencyKey: uuidv7() })).json(),
    );
    expect(
      mcpGrantListSchema.parse((await app.get("/v1/mcp/grants", { session: other.session })).json())
        .grants,
    ).toEqual([]);
    expect(
      (
        await app.request("DELETE", `/v1/mcp/grants/${issued.id}`, {
          session: other.session,
          idempotencyKey: uuidv7(),
        })
      ).status,
    ).toBe(404);
    const idempotencyKey = uuidv7();
    const revoke = await app.request("DELETE", `/v1/mcp/grants/${issued.id}`, {
      session,
      idempotencyKey,
    });
    expect(revoke.status, revoke.text).toBe(200);
    expect(
      (
        await app.request("DELETE", `/v1/mcp/grants/${issued.id}`, { session, idempotencyKey })
      ).json(),
    ).toEqual(revoke.json());
    expect(
      await app.db.first(
        sql("SELECT generation FROM mcp_grants WHERE id = :id", { id: issued.id }),
      ),
    ).toEqual({ generation: 2 });
    const grants = new McpGrants({
      db: app.db,
      keys: app.keys,
      now: () => app.clock.now(),
      policy: { betaAccessRequired: true },
    });
    await expect(grants.authenticateKey(issued.key ?? "")).rejects.toThrow("mcp.invalid_token");
  });
});
