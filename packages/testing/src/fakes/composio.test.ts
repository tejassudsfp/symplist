import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.ts";
import {
  composioConnectedAccountExpiredEvent,
  composioConnectedAccountExpiredType,
  defaultFakeToolkits,
  FakeComposioApiError,
  FakeComposioClient,
  FakeComposioError,
  FakeComposioTimeoutError,
  type FakeToolkit,
  signComposioWebhook,
} from "./composio.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const userId = "0192f0a0-0000-7000-8000-000000000001";
const callbackUrl = "https://api.symplist.example/v1/connections/callback?attempt=a1&n=nonce";

/** The session shape §14.1 requires. */
const symplistSession = {
  sandbox: { enable: false },
  manageConnections: false,
  multiAccount: { enable: true, requireExplicitSelection: true },
} as const;

async function connectedGmail(composio: FakeComposioClient, alias?: string) {
  const authConfig =
    (await composio.authConfigs.list({ toolkit: "gmail" })).items[0] ??
    (await composio.authConfigs.create("gmail", { type: "use_composio_managed_auth" }));
  const link = await composio.connectedAccounts.link(userId, authConfig.id, {
    callbackUrl,
    ...(alias === undefined ? {} : { alias }),
    allowMultiple: true,
  });
  composio.completeConnection(link.id);
  return link.id;
}

describe("FakeComposioClient sessions (§14.1)", () => {
  it("creates and reuses one session per user, recording config and updates", async () => {
    const composio = new FakeComposioClient();
    const session = await composio.sessions.create(userId, {
      ...symplistSession,
      connectedAccounts: { gmail: [] },
    });
    const reused = await composio.sessions.use(session.sessionId);
    expect(reused.sessionId).toBe(session.sessionId);
    expect(reused.userId).toBe(userId);
    await reused.update({ connectedAccounts: { gmail: ["ca_1"] } });
    expect(composio.sessionsCreated).toEqual([
      {
        userId,
        sessionId: session.sessionId,
        config: { ...symplistSession, connectedAccounts: { gmail: [] } },
      },
    ]);
    expect(composio.sessionUpdates).toEqual([
      { sessionId: session.sessionId, patch: { connectedAccounts: { gmail: ["ca_1"] } } },
    ]);
    expect((await composio.sessions.use(session.sessionId)).config.connectedAccounts).toEqual({
      gmail: ["ca_1"],
    });

    expect(await session.delete()).toEqual({ sessionId: session.sessionId, deleted: true });
    await expect(composio.sessions.use(session.sessionId)).rejects.toMatchObject({ status: 404 });
    await expect(
      composio.sessions.create(userId, {
        multiAccount: { enable: true, maxAccountsPerToolkit: 11 },
      }),
    ).rejects.toBeInstanceOf(FakeComposioApiError);
  });

  it("executes a pinned account's tool once when it succeeds", async () => {
    const composio = new FakeComposioClient();
    const account = await connectedGmail(composio);
    composio.setToolHandler("GMAIL_FETCH_EMAILS", () => ({ data: { messages: [] } }));
    const session = await composio.sessions.create(userId, {
      ...symplistSession,
      connectedAccounts: { gmail: [account] },
    });

    const result = await session.execute("GMAIL_FETCH_EMAILS", { max_results: 5 }, { account });
    expect(result).toMatchObject({ data: { messages: [] }, error: null });
    expect(result.logId).toMatch(/^log_fake_/);
    expect(composio.executions).toEqual([
      {
        sessionId: session.sessionId,
        slug: "GMAIL_FETCH_EMAILS",
        arguments: { max_results: 5 },
        account,
        client: "session",
        maxRetries: 2,
        attempts: 1,
        outcome: "success",
      },
    ]);
  });

  it("retries retryable failures on the default client, duplicating side effects, but not on the no-retry client", async () => {
    const composio = new FakeComposioClient();
    const account = await connectedGmail(composio);
    const sends: number[] = [];
    composio.setToolHandler("GMAIL_SEND_EMAIL", ({ attempt }) => {
      sends.push(attempt);
      return attempt < 3 ? { timeout: true } : { data: { id: "msg_1" } };
    });
    const session = await composio.sessions.create(userId, {
      ...symplistSession,
      connectedAccounts: { gmail: [account] },
    });

    await expect(
      session.execute("GMAIL_SEND_EMAIL", { to: "priya@example.com" }, { account }),
    ).resolves.toMatchObject({ data: { id: "msg_1" } });
    expect(sends).toEqual([1, 2, 3]);
    expect(composio.executions.at(-1)).toMatchObject({
      client: "session",
      maxRetries: 2,
      attempts: 3,
      outcome: "success",
    });

    sends.length = 0;
    const noRetry = composio.getClient().withOptions({ maxRetries: 0 });
    expect(noRetry.maxRetries).toBe(0);
    await expect(
      noRetry.toolRouter.session.execute(session.sessionId, {
        tool_slug: "GMAIL_SEND_EMAIL",
        arguments: { to: "priya@example.com" },
        account,
      }),
    ).rejects.toBeInstanceOf(FakeComposioTimeoutError);
    expect(sends).toEqual([1]);
    expect(composio.executions.at(-1)).toMatchObject({
      client: "raw",
      maxRetries: 0,
      attempts: 1,
      outcome: "timeout",
    });
  });

  it("surfaces 429 with Retry-After and does not retry client errors", async () => {
    const composio = new FakeComposioClient();
    const account = await connectedGmail(composio);
    let attempts = 0;
    composio.setToolHandler("GMAIL_FETCH_EMAILS", () => {
      attempts += 1;
      return { httpError: 429, retryAfterSeconds: 7, slug: "RateLimit_Exceeded" };
    });
    composio.setToolHandler("GMAIL_BAD", () => ({ httpError: 400 }));
    const session = await composio.sessions.create(userId, {
      ...symplistSession,
      connectedAccounts: { gmail: [account] },
    });

    const error = await session
      .execute("GMAIL_FETCH_EMAILS", {}, { account })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FakeComposioApiError);
    expect(error).toMatchObject({
      status: 429,
      headers: { "retry-after": "7" },
      error: { slug: "RateLimit_Exceeded" },
    });
    expect(attempts).toBe(3);
    await expect(session.execute("GMAIL_BAD", {}, { account })).rejects.toMatchObject({
      status: 400,
    });
    expect(composio.executions.at(-1)).toMatchObject({ attempts: 1, outcome: "http_error" });
  });

  it("returns tool errors in the result without throwing", async () => {
    const composio = new FakeComposioClient();
    const account = await connectedGmail(composio);
    composio.setToolHandler("GMAIL_FETCH_EMAILS", () => ({ data: {}, error: "Label not found" }));
    const session = await composio.sessions.create(userId, {
      ...symplistSession,
      connectedAccounts: { gmail: [account] },
    });
    await expect(session.execute("GMAIL_FETCH_EMAILS", {}, { account })).resolves.toMatchObject({
      error: "Label not found",
    });
    expect(composio.executions.at(-1)?.outcome).toBe("tool_error");
  });

  it("enforces the Symplist session shape: no sandbox, no connection management, explicit accounts", async () => {
    const composio = new FakeComposioClient();
    const work = await connectedGmail(composio, "work");
    const personal = await connectedGmail(composio, "personal");
    for (const slug of [
      "COMPOSIO_REMOTE_WORKBENCH",
      "COMPOSIO_REMOTE_BASH_TOOL",
      "COMPOSIO_MANAGE_CONNECTIONS",
      "GMAIL_SEND_EMAIL",
    ]) {
      composio.setToolHandler(slug, () => ({ data: {} }));
    }
    composio.setToolHandler("COMPOSIO_MULTI_EXECUTE_TOOL", () => ({ data: { results: [] } }));
    const session = await composio.sessions.create(userId, {
      ...symplistSession,
      connectedAccounts: { gmail: [work, personal] },
    });

    await expect(
      session.execute("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print(1)" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      session.execute("COMPOSIO_REMOTE_BASH_TOOL", { command: "ls" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      session.execute("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: ["gmail"] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      session.execute("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      session.execute("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [],
        sync_response_to_workbench: false,
      }),
    ).resolves.toMatchObject({ data: { results: [] } });

    await expect(session.execute("GMAIL_SEND_EMAIL", {})).rejects.toBeInstanceOf(FakeComposioError);
    await expect(
      session.execute("GMAIL_SEND_EMAIL", {}, { account: "work" }),
    ).resolves.toMatchObject({ error: null });
    await expect(
      session.execute("GMAIL_SEND_EMAIL", {}, { account: "ca_unpinned" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(session.execute("GITHUB_CREATE_ISSUE", {})).rejects.toMatchObject({ status: 400 });
    await expect(session.execute("NOTION_UNKNOWN", {}, {})).rejects.toMatchObject({ status: 400 });
    expect(
      composio.executions.filter((record) => record.outcome === "rejected").length,
    ).toBeGreaterThanOrEqual(6);

    composio.setAccountStatus(personal, "EXPIRED");
    await expect(session.execute("GMAIL_SEND_EMAIL", {})).resolves.toMatchObject({ error: null });
  });

  it("rejects unknown tools with 404 and runs meta tools through executeMeta only", async () => {
    const composio = new FakeComposioClient();
    composio.setToolHandler("COMPOSIO_SEARCH_TOOLS", () => ({ data: { results: [] } }));
    const session = await composio.sessions.create(userId, symplistSession);
    await expect(session.execute("COMPOSIO_UNKNOWN", {})).rejects.toMatchObject({ status: 404 });
    const raw = composio.getClient();
    await expect(
      raw.toolRouter.session.executeMeta(session.sessionId, {
        slug: "COMPOSIO_SEARCH_TOOLS",
        arguments: {},
      }),
    ).resolves.toMatchObject({ data: { results: [] }, error: null });
    await expect(
      raw.toolRouter.session.executeMeta(session.sessionId, { slug: "GMAIL_SEND_EMAIL" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("FakeComposioClient catalogue and auth configs (§14.3)", () => {
  it("paginates toolkits with cursors up to 1000 per page and filters by management", async () => {
    const toolkits: FakeToolkit[] = Array.from({ length: 2150 }, (_, index) => ({
      ...(defaultFakeToolkits[0] as FakeToolkit),
      slug: `toolkit${index}`,
      name: `Toolkit ${String(index).padStart(4, "0")}`,
      composio_managed_auth_schemes: index % 2 === 0 ? ["OAUTH2"] : [],
    }));
    const composio = new FakeComposioClient({ toolkits });
    const client = composio.getClient();
    const slugs: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.toolkits.list({
        limit: 5000,
        managed_by: "all",
        ...(cursor ? { cursor } : {}),
      });
      pages += 1;
      expect(page.items.length).toBeLessThanOrEqual(1000);
      expect(page.total_items).toBe(2150);
      slugs.push(...page.items.map((item) => item.slug));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(slugs).size).toBe(2150);
    expect(composio.toolkitListCalls.map((call) => call.limit)).toEqual([1000, 1000, 1000]);
    expect((await client.toolkits.list({ limit: 1000, managed_by: "composio" })).total_items).toBe(
      1075,
    );
    await expect(client.toolkits.list({ cursor: "not-a-cursor" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("clamps auth config pages to 50, filters, and creates managed or custom configs", async () => {
    const composio = new FakeComposioClient();
    for (let index = 0; index < 60; index += 1) {
      await composio.authConfigs.create("gmail", {
        type: "use_composio_managed_auth",
        name: `gmail ${index}`,
      });
    }
    await composio.authConfigs.create("perplexityai", {
      type: "use_custom_auth",
      authScheme: "API_KEY",
      credentials: {},
    });

    const first = await composio.authConfigs.list({
      toolkit: "gmail",
      isComposioManaged: true,
      limit: 200,
    });
    expect(first.items).toHaveLength(50);
    expect(first.totalPages).toBe(2);
    const second = await composio.authConfigs.list({
      toolkit: "gmail",
      limit: 200,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    expect(
      (await composio.authConfigs.list({ isComposioManaged: false })).items.map(
        (item) => item.toolkit.slug,
      ),
    ).toEqual(["perplexityai"]);
    expect(composio.authConfigsCreated).toHaveLength(61);

    await expect(
      composio.authConfigs.create("perplexityai", { type: "use_composio_managed_auth" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      composio.authConfigs.create("gmail", { type: "use_custom_auth", authScheme: "BASIC" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      composio.authConfigs.create("nope", { type: "use_composio_managed_auth" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("FakeComposioClient connected accounts (§14.2)", () => {
  it("links, completes through the callback, gets and lists accounts", async () => {
    const composio = new FakeComposioClient();
    const authConfig = await composio.authConfigs.create("gmail", {
      type: "use_composio_managed_auth",
    });
    const request = await composio.connectedAccounts.link(userId, authConfig.id, {
      callbackUrl,
      alias: "work",
    });
    expect(request).toMatchObject({ status: "INITIATED" });
    expect(request.redirectUrl).toMatch(/^https:\/\/connect\.composio\.dev\/link\/ln_/);
    expect((await composio.connectedAccounts.get(request.id)).status).toBe("INITIATED");

    const redirect = new URL(composio.completeConnection(request.id));
    expect(redirect.searchParams.get("attempt")).toBe("a1");
    expect(redirect.searchParams.get("n")).toBe("nonce");
    expect(redirect.searchParams.get("status")).toBe("success");
    expect(redirect.searchParams.get("connected_account_id")).toBe(request.id);
    expect(await composio.connectedAccounts.get(request.id)).toMatchObject({
      status: "ACTIVE",
      alias: "work",
      toolkit: { slug: "gmail" },
      authConfig: { id: authConfig.id, isComposioManaged: true },
    });
    expect(composio.accountOwner(request.id)).toBe(userId);
    expect(composio.links).toEqual([
      {
        userId,
        authConfigId: authConfig.id,
        toolkit: "gmail",
        connectedAccountId: request.id,
        callbackUrl,
        alias: "work",
        allowMultiple: false,
      },
    ]);

    await expect(
      composio.connectedAccounts.link(userId, authConfig.id, { callbackUrl }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      composio.connectedAccounts.link(userId, authConfig.id, {
        callbackUrl,
        alias: "work",
        allowMultiple: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const extra = await composio.connectedAccounts.link(userId, authConfig.id, {
      callbackUrl,
      allowMultiple: true,
    });
    composio.completeConnection(extra.id, "FAILED");

    const active = await composio.connectedAccounts.list({
      userIds: [userId],
      statuses: ["ACTIVE"],
    });
    expect(active.items.map((item) => item.id)).toEqual([request.id]);
    const all = await composio.connectedAccounts.list({
      userIds: [userId],
      toolkitSlugs: ["gmail"],
      limit: 1,
    });
    expect(all.items).toHaveLength(1);
    expect(all.nextCursor).not.toBeNull();
    await expect(
      composio.connectedAccounts.link(userId, "ac_missing", { callbackUrl }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("authorizes through a session, finding or creating the managed auth config", async () => {
    const composio = new FakeComposioClient();
    const session = await composio.sessions.create(userId, symplistSession);
    const first = await session.authorize("github", { callbackUrl });
    const second = await session.authorize("github", { callbackUrl, alias: "second" });
    expect(composio.authConfigsCreated).toHaveLength(1);
    expect(first.id).not.toBe(second.id);
  });

  it("records whether a delete revoked upstream tokens", async () => {
    const composio = new FakeComposioClient();
    const soft = await connectedGmail(composio, "soft");
    const revoked = await connectedGmail(composio, "revoked");

    await composio.connectedAccounts.delete(soft);
    await composio.getClient().connectedAccounts.delete(revoked, { revoke_on_delete: true });

    expect(composio.deletions).toEqual([
      { connectedAccountId: soft, revokeOnDelete: false, via: "sdk" },
      { connectedAccountId: revoked, revokeOnDelete: true, via: "raw" },
    ]);
    expect(composio.deletionOf(revoked)?.revokeOnDelete).toBe(true);
    await expect(composio.connectedAccounts.get(soft)).rejects.toMatchObject({ status: 404 });
    await expect(composio.getClient().connectedAccounts.delete(soft)).rejects.toMatchObject({
      status: 404,
    });
  });
});

/**
 * The installed `@composio/core` (a dependency of `@symplist/integrations`), loaded by file path so
 * the fake's webhook parsing can be compared with the real SDK. It makes no network requests to parse.
 */
async function realComposio(): Promise<{
  readonly triggers: {
    parse(
      request: Request | { body: unknown; headers: unknown },
      options?: { verifySecret?: string; tolerance?: number },
    ): Promise<unknown>;
  };
}> {
  const integrations = createRequire(join(repoRoot, "packages", "integrations", "package.json"));
  const sdk = (await import(pathToFileURL(integrations.resolve("@composio/core")).href)) as {
    Composio: new (config: Record<string, unknown>) => Awaited<ReturnType<typeof realComposio>>;
  };
  return new sdk.Composio({
    apiKey: `ak_fake_${randomBytes(8).toString("hex")}`,
    allowTracking: false,
    disableVersionCheck: true,
  });
}

/** An error's identifying fields, or the resolved value, for comparing the fake with the SDK. */
async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await promise };
  } catch (error) {
    const typed = error as { name?: unknown; code?: unknown; statusCode?: unknown };
    return { error: { name: typed.name, code: typed.code, statusCode: typed.statusCode } };
  }
}

describe("FakeComposioClient webhook parsing (§14.3)", () => {
  // A throwaway secret generated per run; never a real credential.
  const secret = randomBytes(32).toString("base64url");
  const expired = composioConnectedAccountExpiredEvent({
    id: "msg_0192f0a0-0000-7000-8000-00000000c0de",
    connectedAccountId: "ca_fake000001",
    userId,
    toolkit: "gmail",
    authConfigId: "ac_fake000001",
    timestamp: "2026-09-15T09:00:00.000Z",
  });

  function signed(clock: FakeClock, body = JSON.stringify(expired), secretToUse = secret) {
    return {
      body,
      headers: signComposioWebhook({
        secret: secretToUse,
        body,
        id: expired.id,
        timestamp: Math.floor(clock.now() / 1000),
      }),
    };
  }

  it("normalizes connected_account.expired into the SDK's IncomingTriggerPayload", async () => {
    const clock = new FakeClock();
    const composio = new FakeComposioClient({ clock });
    const result = await composio.triggers.parse(signed(clock), { verifySecret: secret });

    expect(result.version).toBe("V3");
    expect(result.payload).toEqual({
      id: expired.id,
      uuid: expired.id,
      triggerSlug: "composio.connected_account.expired",
      toolkitSlug: "COMPOSIO",
      userId: "",
      payload: expired.data,
      originalPayload: expired,
      metadata: {
        id: expired.id,
        uuid: expired.id,
        toolkitSlug: "COMPOSIO",
        triggerSlug: "composio.connected_account.expired",
        triggerConfig: {},
        connectedAccount: {
          id: "",
          uuid: "",
          authConfigId: "",
          authConfigUUID: "",
          userId: "",
          status: "ACTIVE",
        },
      },
    });
    expect(result.rawPayload).toEqual(expired);
    const raw = result.rawPayload;
    if (!("type" in raw) || raw.type !== composioConnectedAccountExpiredType || !("id" in raw)) {
      throw new Error("expected a V3 connected_account.expired payload");
    }
    expect(raw.data).toMatchObject({
      id: "ca_fake000001",
      status: "EXPIRED",
      user_id: userId,
      toolkit: { slug: "gmail" },
    });

    const request = new Request("https://api.symplist.example/webhooks/composio", {
      method: "POST",
      body: signed(clock).body,
      headers: signed(clock).headers,
    });
    expect(await composio.triggers.parse(request, { verifySecret: secret })).toEqual(result);
  });

  it("returns exactly what the installed @composio/core returns for every payload version", async () => {
    const sdk = await realComposio();
    // The SDK checks the timestamp against the real clock, so the fake starts at the same instant.
    const clock = new FakeClock(Date.now());
    const composio = new FakeComposioClient({ clock });
    const bodies = [
      expired,
      { ...expired, unexpected: "dropped by the schema", metadata: {}, data: {} },
      {
        id: "msg_trigger_1",
        timestamp: "2026-09-15T09:00:00.000Z",
        type: "composio.trigger.message",
        metadata: {
          log_id: "log_1",
          trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
          trigger_id: "ti_1",
          connected_account_id: "ca_1",
          auth_config_id: "ac_1",
          user_id: userId,
          extra: true,
        },
        data: { message_id: "m1" },
      },
      {
        id: "msg_trigger_2",
        timestamp: "2026-09-15T09:00:00.000Z",
        type: "composio.trigger.disabled",
        metadata: { log_id: "log_2", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
        data: { trigger_id: "ti_2" },
      },
      {
        type: "gmail_new_gmail_message",
        timestamp: "2026-09-15T09:00:00.000Z",
        log_id: "log_3",
        data: {
          connection_id: "c1",
          connection_nano_id: "cn1",
          trigger_nano_id: "tn1",
          trigger_id: "ti_3",
          user_id: userId,
          subject: "hello",
        },
        dropped: 1,
      },
      {
        trigger_name: "GITHUB_STAR_ADDED_EVENT",
        connection_id: "ca_2",
        trigger_id: "ti_4",
        payload: { repository: "symplist" },
        log_id: "log_4",
      },
    ];

    for (const body of bodies) {
      const request = signed(clock, JSON.stringify(body));
      const fake = await settle(composio.triggers.parse(request, { verifySecret: secret }));
      expect(fake).toEqual(await settle(sdk.triggers.parse(request, { verifySecret: secret })));
      expect(fake).toHaveProperty("ok.payload");
      expect(await settle(composio.triggers.parse({ body: request.body, headers: {} }))).toEqual(
        await settle(sdk.triggers.parse({ body: request.body, headers: {} })),
      );
    }
  });

  it("fails exactly like the installed @composio/core for malformed payloads and bad signatures", async () => {
    const sdk = await realComposio();
    const clock = new FakeClock(Date.now());
    const composio = new FakeComposioClient({ clock });
    const good = signed(clock);
    const nowSeconds = String(Math.floor(clock.now() / 1000));
    const { "webhook-signature": _dropped, ...missing } = good.headers;
    const cases: Array<{
      readonly request: { body: string; headers: Record<string, string> };
      readonly options?: { verifySecret?: string; tolerance?: number };
    }> = [
      { request: { body: "{", headers: {} } },
      { request: { body: "null", headers: {} } },
      { request: { body: "[]", headers: {} } },
      { request: { body: '{"unknown":true}', headers: {} } },
      {
        request: {
          body: JSON.stringify({ ...expired, type: "vendor.connected_account.expired" }),
          headers: {},
        },
      },
      { request: { body: JSON.stringify({ ...expired, data: [] }), headers: {} } },
      {
        request: { body: good.body.replace("EXPIRED", "ACTIVE"), headers: good.headers },
        options: { verifySecret: secret },
      },
      { request: good, options: { verifySecret: randomBytes(32).toString("base64url") } },
      { request: good, options: { verifySecret: "" } },
      { request: { body: good.body, headers: missing }, options: { verifySecret: secret } },
      {
        request: { body: good.body, headers: { ...good.headers, "webhook-timestamp": "1000" } },
        options: { verifySecret: secret },
      },
      {
        request: { body: good.body, headers: { ...good.headers, "webhook-timestamp": "soon" } },
        options: { verifySecret: secret },
      },
      {
        request: {
          body: good.body,
          headers: { ...good.headers, "webhook-signature": `v2,${nowSeconds}` },
        },
        options: { verifySecret: secret },
      },
      { request: { body: "", headers: good.headers }, options: { verifySecret: secret } },
    ];

    for (const { request, options } of cases) {
      const fake = await settle(composio.triggers.parse(request, options));
      expect(fake).toHaveProperty("error.name");
      expect(fake).toEqual(await settle(sdk.triggers.parse(request, options)));
    }
  });

  it("applies the tolerance on the fake clock and skips it when set to 0", async () => {
    const clock = new FakeClock();
    const composio = new FakeComposioClient({ clock });
    const old = signed(clock);
    await clock.advance(301_000);
    await expect(composio.triggers.parse(old, { verifySecret: secret })).rejects.toMatchObject({
      name: "ComposioWebhookSignatureVerificationError",
      code: "TS-SDK::WEBHOOK_SIGNATURE_VERIFICATION_FAILED",
      statusCode: 401,
    });
    await expect(
      composio.triggers.parse(old, { verifySecret: secret, tolerance: 0 }),
    ).resolves.toMatchObject({ version: "V3" });
    await expect(
      composio.triggers.parse(old, { verifySecret: secret, tolerance: 400 }),
    ).resolves.toMatchObject({ version: "V3" });
  });

  it("refuses an already-parsed body, which could never carry a verifiable signature", async () => {
    const clock = new FakeClock();
    const composio = new FakeComposioClient({ clock });
    const good = signed(clock);
    for (const options of [{ verifySecret: secret }, undefined]) {
      await expect(
        composio.triggers.parse({ body: JSON.parse(good.body), headers: good.headers }, options),
      ).rejects.toMatchObject({ name: "ValidationError", code: "TS-SDK::VALIDATION_ERROR" });
    }
    await expect(
      composio.triggers.parse(
        { body: new TextEncoder().encode(good.body), headers: good.headers },
        { verifySecret: secret },
      ),
    ).resolves.toMatchObject({ version: "V3" });
  });
});
