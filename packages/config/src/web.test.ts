import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, type ConfigIssue } from "./errors.ts";
import { loadLiveTestFlags } from "./live.ts";
import { credential, generatedSecret } from "./testing/fixtures.ts";
import { loadWebConfig, parseWebConfig, webPublicConfigSchema, webVariableNames } from "./web.ts";

const local = {
  NEXT_PUBLIC_API_URL: "http://localhost:4000",
  NEXT_PUBLIC_WS_URL: "ws://localhost:4000",
};

const hosted = {
  NEXT_PUBLIC_API_URL: "https://api.symplist.example.com",
  NEXT_PUBLIC_WS_URL: "wss://api.symplist.example.com",
  NEXT_PUBLIC_POSTHOG_KEY: `phc_${randomBytes(16).toString("hex")}`,
  NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
  ENABLE_EXPERIMENTAL_COREPACK: "1",
};

function issuesOf(env: Record<string, string | undefined>): readonly ConfigIssue[] {
  const result = parseWebConfig(env);
  if (result.ok) throw new Error("expected the configuration to be invalid");
  return result.issues;
}

const issue = (variable: string, message: string) =>
  expect.objectContaining({ variable, message: expect.stringContaining(message) });

describe("web public configuration (§16.2)", () => {
  it("loads local and hosted configurations with only public values", () => {
    expect(loadWebConfig(local)).toEqual(local);
    const { ENABLE_EXPERIMENTAL_COREPACK: _corepack, ...publicValues } = hosted;
    expect(loadWebConfig(hosted)).toEqual(publicValues);
    expect(loadWebConfig({ ...local, NEXT_PUBLIC_POSTHOG_KEY: "" })).toEqual(local);
    expect(Object.isFrozen(loadWebConfig(local))).toBe(true);
    expect(webVariableNames).toEqual([
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_WS_URL",
      "NEXT_PUBLIC_POSTHOG_KEY",
      "NEXT_PUBLIC_POSTHOG_HOST",
      "ENABLE_EXPERIMENTAL_COREPACK",
    ]);
  });

  it("ignores unrelated build variables", () => {
    expect(loadWebConfig({ ...hosted, VERCEL_ENV: "production", NODE_ENV: "production" })).toEqual(
      loadWebConfig(hosted),
    );
  });

  it("allows plain http and ws only for loopback hosts", () => {
    expect(
      loadWebConfig({
        NEXT_PUBLIC_API_URL: "http://127.0.0.1:4000",
        NEXT_PUBLIC_WS_URL: "ws://127.0.0.1:4000",
      }),
    ).toBeTruthy();
    expect(
      issuesOf({
        NEXT_PUBLIC_API_URL: "http://api.example.com",
        NEXT_PUBLIC_WS_URL: "ws://api.example.com",
      }),
    ).toEqual([
      issue("NEXT_PUBLIC_API_URL", "must use https"),
      issue("NEXT_PUBLIC_WS_URL", "must use wss"),
    ]);
  });

  it.each([
    ["NEXT_PUBLIC_API_URL", undefined, "is required"],
    ["NEXT_PUBLIC_API_URL", "http://localhost:4000/v1", "must be an origin"],
    ["NEXT_PUBLIC_WS_URL", "ws://localhost:4000/v1/ws", "must be an origin"],
    ["NEXT_PUBLIC_WS_URL", "ws://localhost:4001", "same host and port"],
    ["NEXT_PUBLIC_POSTHOG_HOST", "http://posthog.example.com", "must use https"],
    ["ENABLE_EXPERIMENTAL_COREPACK", "true", "must be 1"],
  ])("reports %s=%j", (name, value, message) => {
    expect(issuesOf({ ...local, [name]: value })).toContainEqual(issue(name, message));
  });

  it("requires the PostHog host with a key and refuses personal API keys", () => {
    expect(issuesOf({ ...local, NEXT_PUBLIC_POSTHOG_KEY: hosted.NEXT_PUBLIC_POSTHOG_KEY })).toEqual(
      [issue("NEXT_PUBLIC_POSTHOG_HOST", "is required when NEXT_PUBLIC_POSTHOG_KEY is set")],
    );
    const personal = `phx_${randomBytes(16).toString("hex")}`;
    const issues = issuesOf({ ...hosted, NEXT_PUBLIC_POSTHOG_KEY: personal });
    expect(issues).toEqual([issue("NEXT_PUBLIC_POSTHOG_KEY", "personal API keys are server-only")]);
    expect(JSON.stringify(issues)).not.toContain(personal);
  });

  it("refuses unknown NEXT_PUBLIC_* variables, so nothing else is inlined into the bundle", () => {
    const leaked = credential();
    const issues = issuesOf({ ...local, NEXT_PUBLIC_RESEND_API_KEY: leaked });
    expect(issues).toEqual([issue("NEXT_PUBLIC_RESEND_API_KEY", "not an allowed public variable")]);
    expect(JSON.stringify(issues)).not.toContain(leaked);
  });

  it.each([
    ["CONTENT_KEK_1", generatedSecret()],
    ["SESSION_DIGEST_SECRET_CURRENT", "1"],
    ["TRIGGER_SECRET_KEY", credential("tr_prod_")],
    ["POSTHOG_PERSONAL_API_KEY", credential("phx_")],
    ["RESEND_API_KEY", credential("re_")],
  ])("refuses the server secret %s in the web environment", (name, value) => {
    let error: ConfigError | undefined;
    try {
      loadWebConfig({ ...hosted, [name]: value });
    } catch (caught) {
      error = caught as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.runtime).toBe("web");
    expect(error?.issues).toEqual([issue(name, "server secret")]);
    if (value.length > 1) expect(error?.message).not.toContain(value);
  });

  it("works as a Standard Schema", async () => {
    expect((await webPublicConfigSchema["~standard"].validate(local)).issues).toBeUndefined();
    const invalid = await webPublicConfigSchema["~standard"].validate({
      NEXT_PUBLIC_WS_URL: "ws://localhost:4000",
    });
    expect(invalid.issues).toEqual([expect.objectContaining({ path: ["NEXT_PUBLIC_API_URL"] })]);
    const notRecord = await webPublicConfigSchema["~standard"].validate(["NEXT_PUBLIC_API_URL"]);
    expect(notRecord.issues).toHaveLength(1);
  });
});

describe("live suite flags (§17)", () => {
  it("enables suites only with 1", () => {
    expect(loadLiveTestFlags({ LIVE_D1: "1", LIVE_R2: "0", LIVE_TRIGGER: "" })).toEqual({
      LIVE_D1: true,
      LIVE_R2: false,
      LIVE_TRIGGER: false,
      LIVE_COMPOSIO: false,
      LIVE_OPENAI: false,
      LIVE_POSTHOG: false,
    });
  });

  it.each(["true", "yes", "2", " 1"])("rejects LIVE_OPENAI=%j", (value) => {
    expect(() => loadLiveTestFlags({ LIVE_OPENAI: value })).toThrow(
      /LIVE_OPENAI: must be "1" to enable the live suite or "0" to skip it/,
    );
  });
});
