import { errorEnvelopeSchema, validationErrorSchema } from "@symplist/contracts";
import { sql as dbSql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootTestApp,
  generatedSecret,
  type TestApp,
  type TestResponse,
  testApiEnv,
} from "../test/harness.ts";
import { BootstrapProbeModule } from "../test/probes/bootstrap.probe.ts";
import { jsonBodyLimitBytes, startApi } from "./app.ts";
import { isProduction, runsMigrationsOnStartup } from "./infra/config/api-config.ts";
import { HealthController } from "./modules/system/health.controller.ts";
import { HealthService } from "./modules/system/health.service.ts";

let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("api bootstrap (§6, §16.1)", () => {
  it("serves GET /healthz without the v1 prefix, authentication or D1", async () => {
    app = await bootTestApp();
    const response = await app.get("/healthz");
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    const missing = await app.get("/v1/healthz");
    expect(missing.status).toBe(404);
    expect(errorEnvelopeSchema.parse(missing.json()).error.code).toBe("not_found");
  });

  it("prefixes feature routes with /v1 and leaves the excluded surfaces unprefixed", async () => {
    app = await bootTestApp({ imports: [BootstrapProbeModule] });
    const { session } = await app.createSignedInUser();
    expect((await app.get("/v1/probe", { session })).status).toBe(200);
    expect((await app.get("/probe", { session })).status).toBe(404);
    expect((await app.post("/webhooks/probe", { origin: null, body: { a: 1 } })).status).toBe(201);
    expect((await app.post("/v1/webhooks/probe", { origin: null, body: { a: 1 } })).status).toBe(
      404,
    );
    expect((await app.get("/.well-known/probe")).status).toBe(200);
  });

  it("keeps the raw body for signature checks", async () => {
    app = await bootTestApp({ imports: [BootstrapProbeModule] });
    const response = await app.post("/webhooks/probe", { origin: null, body: { event: "x" } });
    expect(response.json()).toEqual({ rawBytes: JSON.stringify({ event: "x" }).length });
  });

  it("sends the api security headers on every response (§10.4)", async () => {
    app = await bootTestApp();
    const response = await app.get("/healthz");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const notFound = await app.get("/nope");
    expect(notFound.headers.get("x-content-type-options")).toBe("nosniff");
    expect(notFound.json<{ error: { requestId: string } }>().error.requestId).toBe(
      notFound.headers.get("x-request-id"),
    );
  });

  it("returns validation and malformed bodies as envelopes without echoing input", async () => {
    app = await bootTestApp({ imports: [BootstrapProbeModule] });
    const { session } = await app.createSignedInUser();
    const invalid = await app.post("/v1/probe/echo", {
      session,
      body: { title: "this title is far too long", extra: "SECRET-EXTRA-VALUE" },
    });
    expect(invalid.status).toBe(400);
    const envelope = validationErrorSchema.parse(invalid.json());
    expect(envelope.error.details.issues.length).toBeGreaterThan(0);
    expect(invalid.text).not.toContain("this title is far too long");
    expect(invalid.text).not.toContain("SECRET-EXTRA-VALUE");

    const malformed = await app.request("POST", "/v1/probe/echo", {
      session,
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);
    const raw = await fetch(`${app.baseUrl}/v1/probe/echo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: app.config.WEB_ORIGIN,
        "x-symplist-csrf": session.csrf,
      },
      body: '{"title": "unterminated',
    });
    expect(raw.status).toBe(400);
    const body = await raw.text();
    expect(errorEnvelopeSchema.parse(JSON.parse(body)).error.code).toBe("validation");
    expect(body).not.toContain("unterminated");
  });

  it("rejects bodies over the JSON limit with request.too_large", async () => {
    app = await bootTestApp({ imports: [BootstrapProbeModule], env: { DOC_MAX_BYTES: "1024" } });
    const { session } = await app.createSignedInUser();
    const response = await app.post("/v1/probe/echo", {
      session,
      body: { title: "x".repeat(jsonBodyLimitBytes(app.config) + 10) },
    });
    expect(response.status).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("request.too_large");
  });

  it("limits bodies of unauthenticated routes far below the document limit (§3.1)", async () => {
    app = await bootTestApp({ imports: [BootstrapProbeModule] });
    const { session } = await app.createSignedInUser();
    const json = (bytes: number) => ({ padding: "x".repeat(bytes) });
    const code = (response: { json<T>(): T }) =>
      response.json<{ error: { code: string } }>().error.code;

    // Pre-session auth routes: 16 KiB, also when the path is written in another case.
    const auth = (path: string, bytes: number) =>
      app?.request("POST", path, { csrf: "1", body: json(bytes) }) as Promise<TestResponse>;
    expect((await auth("/v1/auth/probe-body", 15 * 1024)).status).toBe(201);
    const tooLarge = await auth("/v1/auth/probe-body", 17 * 1024);
    expect(tooLarge.status).toBe(413);
    expect(code(tooLarge)).toBe("request.too_large");
    expect((await auth("/V1/Auth/probe-body", 17 * 1024)).status).toBe(413);

    // Webhooks: 256 KiB, with the raw body kept for the signature.
    const webhook = (bytes: number) =>
      app?.post("/webhooks/probe", { origin: null, body: json(bytes) });
    expect((await webhook(250 * 1024))?.status).toBe(201);
    expect((await webhook(257 * 1024))?.status).toBe(413);

    // OAuth forms: 64 KiB, parsed flat.
    const form = (bytes: number) =>
      fetch(`${app?.baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=authorization_code&code=${"c".repeat(bytes)}`,
      });
    const accepted = await form(60 * 1024);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ keys: 2 });
    expect((await form(65 * 1024)).status).toBe(413);

    // Internal endpoints never take JSON or forms: 1 KiB.
    const internal = await app.post("/internal/v1/probe-body", {
      origin: null,
      body: json(2 * 1024),
    });
    expect(internal.status).toBe(413);

    // A cookie-authenticated route still takes a whole document (2 × DOC_MAX_BYTES).
    const documentBytes = 2 * app.config.DOC_MAX_BYTES;
    const document = await app.post("/v1/probe/document", { session, body: json(documentBytes) });
    expect(document.status).toBe(201);
    expect(document.json<{ rawBytes: number }>().rawBytes).toBeGreaterThan(documentBytes);
  });

  it("maps framework HTTP exceptions to stable codes over HTTP instead of internal", async () => {
    app = await bootTestApp({ imports: [BootstrapProbeModule] });
    const { session } = await app.createSignedInUser();
    const forbidden = await app.get("/v1/probe/forbidden", { session });
    expect(forbidden.status).toBe(403);
    expect(errorEnvelopeSchema.parse(forbidden.json()).error.code).toBe("auth.csrf_invalid");
    const unauthorized = await app.get("/v1/probe/unauthorized", { session });
    expect(unauthorized.status).toBe(401);
    expect(errorEnvelopeSchema.parse(unauthorized.json()).error.code).toBe("auth.session_required");
    expect(unauthorized.text).not.toContain("maya@example.test");
    const unsupported = await app.post("/v1/probe/unsupported", { session });
    expect(unsupported.status).toBe(400);
    expect(errorEnvelopeSchema.parse(unsupported.json()).error.code).toBe("validation");
    expect(unsupported.text).not.toContain("text/xml");
    expect(app.logs.events("http.unhandled_error")).toEqual([]);
  });

  it("applies trust proxy from TRUST_PROXY_HOPS and runs migrations on startup outside production", async () => {
    app = await bootTestApp({ env: { TRUST_PROXY_HOPS: "2" } });
    expect(app.app.getHttpAdapter().getInstance().get("trust proxy")).toBe(2);
    const migrations = await app.db.all(dbSql(`SELECT name FROM "d1_migrations"`));
    expect(migrations.length).toBeGreaterThanOrEqual(17);
    expect(runsMigrationsOnStartup({ NODE_ENV: "development" })).toBe(true);
    expect(runsMigrationsOnStartup({ NODE_ENV: "test" })).toBe(true);
    expect(runsMigrationsOnStartup({ NODE_ENV: "production" })).toBe(false);
    expect(isProduction({ NODE_ENV: "production" })).toBe(true);
  });

  it("fails fast on invalid configuration, naming variables without echoing values", async () => {
    const leaked = "not-a-valid-secret-value-zz9";
    let output = "";
    const started = await startApi(
      testApiEnv({ SESSION_DIGEST_SECRET_1: leaked, WEB_ORIGIN: "not an origin", PORT: "0" }),
      {
        stderr: (text) => {
          output += text;
        },
      },
    );
    expect(started).toBeNull();
    expect(output).toContain("SESSION_DIGEST_SECRET_1");
    expect(output).toContain("WEB_ORIGIN");
    expect(output).not.toContain(leaked);
    expect(output).not.toContain("not an origin");
  });

  it("refuses equal secret values across families without printing them", async () => {
    const shared = generatedSecret();
    let output = "";
    const started = await startApi(
      testApiEnv({ SESSION_DIGEST_SECRET_1: shared, OTP_DIGEST_SECRET_1: shared }),
      {
        stderr: (text) => {
          output += text;
        },
      },
    );
    expect(started).toBeNull();
    expect(output).not.toContain(shared);
  });

  it("emits design:paramtypes metadata for injected providers under the Vitest transform", () => {
    expect(Reflect.getMetadata("design:paramtypes", HealthController)).toEqual([HealthService]);
  });
});
