import {
  errorEnvelopeSchema,
  preferenceDefaults,
  preferencesConflictDetailsSchema,
  preferencesPutResponseSchema,
  preferencesResponseSchema,
} from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";
import { WsTestClient } from "../../../test/ws-client.ts";

const apps: TestApp[] = [];
const sockets: WsTestClient[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

async function boot(): Promise<TestApp> {
  const app = await bootTestApp();
  apps.push(app);
  return app;
}

function put(app: TestApp, session: TestSession, group: string, body: object) {
  return app.request("PUT", `/v1/preferences/${group}`, { session, body });
}

const pebbleViolet = { themeId: "pebble", mode: "dark", accent: "violet" };

describe("preference routes (§10.3)", () => {
  it("returns every group with defaults, then saves with version and clientSeq", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const initial = await app.get("/v1/preferences", { session });
    expect(initial.status).toBe(200);
    const groups = preferencesResponseSchema.parse(initial.json()).groups;
    expect(groups.appearance).toEqual({
      group: "appearance",
      version: 0,
      data: preferenceDefaults.appearance,
      updatedAt: null,
    });
    expect(groups.panels.data).toEqual(preferenceDefaults.panels);

    const saved = await put(app, session, "appearance", {
      baseVersion: 0,
      clientSeq: 1,
      data: pebbleViolet,
    });
    expect(saved.status).toBe(200);
    expect(preferencesPutResponseSchema.parse(saved.json())).toEqual({
      group: "appearance",
      version: 1,
      data: pebbleViolet,
      updatedAt: app.clock.now(),
      clientSeq: 1,
    });
    const one = await app.get("/v1/preferences/appearance", { session });
    expect(one.json()).toMatchObject({ version: 1, data: pebbleViolet });
    expect(await app.scanDatabaseFor("pebble")).toEqual([]);
  });

  it("answers a stale save with preferences.conflict carrying the current data", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    await put(app, session, "keyboard", {
      baseVersion: 0,
      clientSeq: 1,
      data: { overrides: { "workspace.task_complete": "shift+x" }, singleKeyShortcuts: true },
    });
    const stale = await put(app, session, "keyboard", {
      baseVersion: 0,
      clientSeq: 2,
      data: { overrides: {}, singleKeyShortcuts: false },
    });
    expect(stale.status).toBe(409);
    const envelope = errorEnvelopeSchema.parse(stale.json());
    expect(envelope.error.code).toBe("preferences.conflict");
    expect(preferencesConflictDetailsSchema.parse(envelope.error.details)).toEqual({
      group: "keyboard",
      version: 1,
      data: { overrides: { "workspace.task_complete": "shift+x" }, singleKeyShortcuts: true },
      updatedAt: app.clock.now(),
      clientSeq: 2,
    });
    // Resending the save that already applied is not a conflict.
    const retry = await put(app, session, "keyboard", {
      baseVersion: 0,
      clientSeq: 1,
      data: { overrides: { "workspace.task_complete": "shift+x" }, singleKeyShortcuts: true },
    });
    expect(retry.status).toBe(200);
    expect(retry.json()).toMatchObject({ version: 1, clientSeq: 1 });
  });

  it("validates the group and its data without echoing values", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const unknownGroup = await put(app, session, "billing", {
      baseVersion: 0,
      clientSeq: 1,
      data: {},
    });
    expect(unknownGroup.status).toBe(400);
    const badData = await put(app, session, "appearance", {
      baseVersion: 0,
      clientSeq: 1,
      data: { themeId: "studio", mode: "system", accent: "MARKER-css url(x)" },
    });
    expect(badData.status).toBe(400);
    const envelope = errorEnvelopeSchema.parse(badData.json());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.details).toMatchObject({ issues: [{ path: ["data", "accent"] }] });
    expect(badData.text).not.toContain("MARKER");
    const badBody = await put(app, session, "chat", { baseVersion: -1, clientSeq: 1, data: {} });
    expect(badBody.status).toBe(400);
    expect(await app.db.all(sql(`SELECT * FROM user_preferences`))).toEqual([]);
  });

  it("keeps accounts apart and requires admitted access and CSRF", async () => {
    const app = await boot();
    const maya = await app.createSignedInUser();
    const other = await app.createSignedInUser();
    await put(app, maya.session, "privacy", {
      baseVersion: 0,
      clientSeq: 1,
      data: { includeChatInSearch: true },
    });
    const theirs = await app.get("/v1/preferences/privacy", { session: other.session });
    expect(theirs.json()).toMatchObject({ version: 0, data: { includeChatInSearch: false } });
    const locked = await app.createSignedInUser("locked");
    expect((await app.get("/v1/preferences", { session: locked.session })).status).toBe(403);
    expect((await app.get("/v1/preferences")).status).toBe(401);
    const noCsrf = await app.request("PUT", "/v1/preferences/privacy", {
      session: maya.session,
      csrf: null,
      body: { baseVersion: 1, clientSeq: 2, data: { includeChatInSearch: false } },
    });
    expect(noCsrf.status).toBe(403);
  });

  it("uses one D1 request per call once cached and announces preferences.changed", async () => {
    const app = await boot();
    const maya = await app.createSignedInUser();
    const socket = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: maya.session.cookie,
    });
    sockets.push(socket);
    socket.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
    await socket.waitFor((frame) => frame.t === "snapshot");
    await app.get("/v1/preferences", { session: maya.session });
    const spy = vi.spyOn(app.db, "batch");
    const saved = await put(app, maya.session, "panels", {
      baseVersion: 0,
      clientSeq: 4,
      data: { inboxCollapsed: true, chatCollapsed: false, inboxWidth: 300, chatWidth: 360 },
    });
    expect(saved.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    await app.get("/v1/preferences/panels", { session: maya.session });
    expect(spy).toHaveBeenCalledTimes(1);
    const event = await socket.waitFor((frame) => frame.t === "ev");
    expect(event).toMatchObject({
      topic: "user",
      type: "preferences.changed",
      data: { group: "panels", version: 1 },
    });
    expect(JSON.stringify(event)).not.toContain("300");
  });
});
