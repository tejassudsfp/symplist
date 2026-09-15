import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, CapturedLogs, type TestApp } from "../../../test/harness.ts";
import { LoggingProbeModule } from "../../../test/probes/logging.probe.ts";
import { AppLogger, NestLoggerAdapter } from "./logger.ts";
import { REDACTED, redactUrl, sanitizeLogFields } from "./redact.ts";

const secrets = {
  otp: "482913",
  password: "correct horse battery staple",
  token: "Zk3mP9xQ2vW8rT6yU4iO1pA7sD5fG3hJ9kL2zX4cV6b",
  shareKey: "shr_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-",
  prompt: "Summarize my medical notes about the cardiology appointment",
  document: "# Private diary\n\nToday I felt",
};

let app: TestApp;

beforeAll(async () => {
  app = await bootTestApp({ imports: [LoggingProbeModule] });
});

afterAll(async () => {
  await app.close();
});

function expectNoSecrets(text: string) {
  for (const [name, value] of Object.entries(secrets)) {
    expect(text, name).not.toContain(value);
  }
  expect(text).not.toContain("medical");
  expect(text).not.toContain("Private diary");
}

describe("structured request logs (§6.3)", () => {
  it("records request id, route template, status and duration, never bodies", async () => {
    app.logs.clear();
    const response = await app.post("/v1/auth/probe-login", {
      csrf: "1",
      body: {
        email: "maya@example.test",
        code: secrets.otp,
        password: secrets.password,
        prompt: secrets.prompt,
      },
    });
    expect(response.status).toBe(201);
    const [request] = app.logs.events("http.request");
    expect(request).toMatchObject({
      level: "info",
      route: "/v1/auth/probe-login",
      method: "POST",
      status: 201,
      routeClass: "pre_session",
      requestId: response.headers.get("x-request-id"),
    });
    expect(typeof request?.durationMs).toBe("number");
    const [attempt] = app.logs.events("probe.login_attempt");
    expect(attempt).toMatchObject({
      email: REDACTED,
      code: REDACTED,
      password: REDACTED,
      prompt: REDACTED,
      attempt: 1,
    });
    expectNoSecrets(app.logs.text());
    expect(app.logs.text()).not.toContain("maya@example.test");
  });

  it("never logs the share-route key, in fields or URLs", async () => {
    app.logs.clear();
    const response = await app.get(
      `/artifact/0190aaaa?key=${encodeURIComponent(secrets.shareKey)}`,
      {
        shareHost: true,
      },
    );
    expect(response.status).toBe(200);
    const [read] = app.logs.events("probe.share_read");
    expect(read).toMatchObject({ key: REDACTED, length: secrets.shareKey.length });
    const [request] = app.logs.events("http.request");
    expect(request?.route).toBe("/artifact/:id");
    expectNoSecrets(app.logs.text());
    expect(redactUrl(`/artifact/1?key=${secrets.shareKey}&view=raw#frag`)).toBe(
      `/artifact/1?key=${REDACTED}&view=${REDACTED}`,
    );
  });

  it("logs failures by error name and stable code only", async () => {
    const { session } = await app.createSignedInUser();
    app.logs.clear();
    const response = await app.post("/v1/probe/fail", {
      session,
      body: { prompt: secrets.prompt },
    });
    expect(response.status).toBe(500);
    expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "internal",
      message: "Something went wrong",
    });
    const [failure] = app.logs.events("http.unhandled_error");
    expect(failure).toMatchObject({
      level: "error",
      errorName: "Error",
      errorCode: "integration.rejected",
    });
    expectNoSecrets(app.logs.text());
    expectNoSecrets(response.text);
    expect(app.logs.text()).not.toContain("upstream rejected");
  });
});

describe("log field sanitization (§6.3)", () => {
  it("keeps ids, codes, numbers and short identifiers and redacts everything else", () => {
    expect(
      sanitizeLogFields({
        userId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        code: "task.archived",
        status: 409,
        ok: true,
        missing: null,
        toolkit: "gmail",
        connectedAccount: "ca_8Hs2kD9",
        run: "run_abc123",
        note: "free text with spaces",
        otpCode: "123456",
        digits: "123456",
        bearer: `Bearer ${secrets.token}`,
        opaque: secrets.token,
        prefixedKey: "sym_0190_abcdefghijklmnopqrstuvwxyz",
        when: new Date(5),
        buffer: Buffer.from("secret"),
        nested: { title: "private", count: 2, deeper: { deepest: { tooDeep: 1 } } },
        list: ["gmail", secrets.password, 3],
        "bad key": "x",
        undefinedValue: undefined,
      }),
    ).toEqual({
      userId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      code: "task.archived",
      status: 409,
      ok: true,
      missing: null,
      toolkit: "gmail",
      connectedAccount: "ca_8Hs2kD9",
      run: "run_abc123",
      note: REDACTED,
      otpCode: REDACTED,
      digits: REDACTED,
      bearer: REDACTED,
      opaque: REDACTED,
      prefixedKey: REDACTED,
      when: 5,
      buffer: REDACTED,
      nested: { title: REDACTED, count: 2, deeper: { deepest: REDACTED } },
      list: ["gmail", REDACTED, 3],
    });
  });

  it("redacts sensitive field names whatever the value, and restricts code, route and reason shapes", () => {
    expect(
      sanitizeLogFields({
        password: "short",
        pin: 1234,
        apiKey: "abc",
        authorization: "x",
        cookie: "sym_session",
        code: "123456",
        route: "/v1/tasks?key=secret",
        reason: "relocked",
        error: Object.assign(new Error(`failed with ${secrets.token}`), {
          code: "db.unknown_outcome",
        }),
      }),
    ).toEqual({
      password: REDACTED,
      pin: REDACTED,
      apiKey: REDACTED,
      authorization: REDACTED,
      cookie: REDACTED,
      code: REDACTED,
      route: REDACTED,
      reason: "relocked",
      error: { errorName: "Error", code: "db.unknown_outcome" },
    });
  });

  it("replaces invalid event names and keeps framework messages only from trusted contexts", () => {
    const sink = new CapturedLogs();
    const logger = new AppLogger(sink);
    logger.info("Not a stable code", { ok: true });
    const adapter = new NestLoggerAdapter(logger);
    adapter.log("Mapped {/v1/tasks, GET} route", "RouterExplorer");
    adapter.log(`user said ${secrets.prompt}`, "SomeService");
    adapter.error(`boom ${secrets.token}`, `stack with ${secrets.password}`, "ExceptionsHandler");
    adapter.warn({ password: secrets.password });
    const entries = sink.entries();
    expect(entries[0]).toMatchObject({ event: "log.invalid_event", ok: true });
    expect(entries[1]).toMatchObject({
      event: "nest.log",
      context: "RouterExplorer",
      message: "Mapped {/v1/tasks, GET} route",
    });
    expect(entries[2]).toMatchObject({
      event: "nest.log",
      context: "SomeService",
      message: REDACTED,
    });
    expect(entries[3]).toEqual({
      ts: expect.any(String),
      level: "error",
      event: "nest.error",
      context: "ExceptionsHandler",
    });
    expect(entries[4]).toMatchObject({ event: "nest.log", level: "warn", message: REDACTED });
    expectNoSecrets(sink.text());
  });
});
