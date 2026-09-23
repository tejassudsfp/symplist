import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeGeneratedSecret,
  duplicateSecretIssues,
  generatedSecretFamilies,
  isSecretVariable,
  parseSecretFamilies,
  providerCredentialInventory,
  rejectedSecretIssues,
  secretFamiliesFor,
  secretFamilyInventory,
} from "./secrets.ts";
import { generatedSecret } from "./testing/fixtures.ts";

describe("secret inventory (§4.5)", () => {
  it("lists each generated family once and no family name prefixes another", () => {
    expect(new Set(generatedSecretFamilies).size).toBe(generatedSecretFamilies.length);
    for (const family of generatedSecretFamilies) {
      for (const other of generatedSecretFamilies) {
        if (family !== other) expect(other.startsWith(`${family}_`)).toBe(false);
      }
    }
    expect(Object.keys(secretFamilyInventory).sort()).toEqual([...generatedSecretFamilies].sort());
  });

  it("assigns families to runtimes exactly as the inventory table does", () => {
    expect(secretFamiliesFor("worker")).toEqual([
      "CONTENT_KEK",
      "INTERNAL_EVENT_SECRET",
      "REMINDER_UNSUBSCRIBE_SECRET",
    ]);
    expect(secretFamiliesFor("api")).toEqual([...generatedSecretFamilies]);
    for (const entry of Object.values(secretFamilyInventory)) expect(entry.ci).toBe(false);
  });

  it("assigns provider credentials to runtimes exactly as the inventory table does", () => {
    expect(providerCredentialInventory).toEqual({
      CLOUDFLARE_D1_API_TOKEN: { api: "yes", worker: "rejected", ci: false },
      CLOUDFLARE_D1_WORKER_API_TOKEN: { api: "rejected", worker: "yes", ci: false },
      CLOUDFLARE_D1_MIGRATE_API_TOKEN: { api: "rejected", worker: "rejected", ci: true },
      R2_ACCESS_KEY_ID: { api: "yes", worker: "yes", ci: false },
      R2_SECRET_ACCESS_KEY: { api: "yes", worker: "yes", ci: false },
      COMPOSIO_API_KEY: { api: "yes", worker: "yes", ci: false },
      RESEND_API_KEY: { api: "yes", worker: "yes", ci: false },
      POSTHOG_PROJECT_KEY: { api: "yes", worker: "yes", ci: false },
      OPENAI_API_KEY: { api: "rejected", worker: "rejected", ci: false },
      ANTHROPIC_API_KEY: { api: "rejected", worker: "rejected", ci: false },
      AWS_ACCESS_KEY_ID: { api: "rejected", worker: "rejected", ci: false },
      AWS_SECRET_ACCESS_KEY: { api: "rejected", worker: "rejected", ci: false },
      GOOGLE_VERTEX_CREDENTIALS_JSON: { api: "rejected", worker: "rejected", ci: false },
      TOGETHER_API_KEY: { api: "rejected", worker: "rejected", ci: false },
      RESEND_WEBHOOK_SECRET: { api: "yes", worker: "rejected", ci: false },
      COMPOSIO_WEBHOOK_SECRET: { api: "yes", worker: "rejected", ci: false },
      POSTHOG_PERSONAL_API_KEY: { api: "yes", worker: "rejected", ci: false },
      TRIGGER_SECRET_KEY: { api: "yes", worker: "platform_injected", ci: false },
      TRIGGER_ACCESS_TOKEN: { api: "no", worker: "no", ci: true },
    });
  });

  it("classifies secret variable names", () => {
    expect(isSecretVariable("CONTENT_KEK_1")).toBe(true);
    expect(isSecretVariable("SHARE_SESSION_DIGEST_SECRET_CURRENT")).toBe(true);
    expect(isSecretVariable("TRIGGER_SECRET_KEY")).toBe(true);
    expect(isSecretVariable("CONTENT_KEKS")).toBe(false);
    expect(isSecretVariable("POSTHOG_HOST")).toBe(false);
  });
});

describe("generated secret decoding", () => {
  it("decodes fresh 32-byte base64url values exactly as Node does", () => {
    for (let run = 0; run < 64; run += 1) {
      const bytes = randomBytes(32);
      const decoded = decodeGeneratedSecret(bytes.toString("base64url"));
      expect(decoded && Buffer.from(decoded).equals(bytes)).toBe(true);
    }
  });

  it.each([
    ["padding", `${generatedSecret()}=`],
    [
      "standard base64 characters",
      randomBytes(32).toString("base64").replace(/=+$/, "").replace(/^./, "+"),
    ],
    ["a 31-byte value", randomBytes(31).toString("base64url")],
    ["a 33-byte value", randomBytes(33).toString("base64url")],
    ["a non-canonical final character", `${generatedSecret().slice(0, 42)}B`],
    ["whitespace", ` ${generatedSecret().slice(1)}`],
    ["a passphrase-like value", "not a key!!"],
    ["an empty value", ""],
    ["non-ASCII characters", `${generatedSecret().slice(0, 42)}é`],
  ])("rejects %s", (_label, value) => {
    expect(decodeGeneratedSecret(value)).toBeNull();
  });
});

describe("secret family parsing", () => {
  it("parses rotated families with the current version", () => {
    const [v1, v2] = [generatedSecret(), generatedSecret()];
    const { families, issues } = parseSecretFamilies(
      { CONTENT_KEK_1: v1, CONTENT_KEK_2: v2, CONTENT_KEK_CURRENT: "2" },
      ["CONTENT_KEK"],
    );
    expect(issues).toEqual([]);
    expect(families.CONTENT_KEK?.current).toBe(2);
    expect([...(families.CONTENT_KEK?.versions ?? [])]).toEqual([
      [1, v1],
      [2, v2],
    ]);
  });

  it.each([
    [
      "a missing family",
      {},
      [{ variable: "CONTENT_KEK_CURRENT", message: expect.stringContaining("is required") }],
    ],
    [
      "a version without CURRENT",
      { CONTENT_KEK_1: generatedSecret() },
      [{ variable: "CONTENT_KEK_CURRENT", message: expect.stringContaining("is required") }],
    ],
    [
      "CURRENT naming a missing version",
      { CONTENT_KEK_1: generatedSecret(), CONTENT_KEK_CURRENT: "2" },
      [{ variable: "CONTENT_KEK_CURRENT", message: "names a version that is not configured" }],
    ],
    [
      "a non-numeric CURRENT",
      { CONTENT_KEK_1: generatedSecret(), CONTENT_KEK_CURRENT: "latest" },
      [
        {
          variable: "CONTENT_KEK_CURRENT",
          message: expect.stringContaining("positive whole number"),
        },
      ],
    ],
    [
      "an unversioned value",
      {
        CONTENT_KEK: generatedSecret(),
        CONTENT_KEK_1: generatedSecret(),
        CONTENT_KEK_CURRENT: "1",
      },
      [{ variable: "CONTENT_KEK", message: expect.stringContaining("CONTENT_KEK_<n>") }],
    ],
    [
      "a zero-padded version",
      { CONTENT_KEK_01: generatedSecret(), CONTENT_KEK_CURRENT: "1" },
      expect.arrayContaining([
        {
          variable: "CONTENT_KEK_01",
          message: expect.stringContaining("not a valid version name"),
        },
      ]),
    ],
    [
      "a short key",
      { CONTENT_KEK_1: randomBytes(16).toString("base64url"), CONTENT_KEK_CURRENT: "1" },
      [{ variable: "CONTENT_KEK_1", message: expect.stringContaining("32 random bytes") }],
    ],
  ])("reports %s", (_label, variables, expected) => {
    const result = parseSecretFamilies(variables as Record<string, string>, ["CONTENT_KEK"]);
    expect(result.issues).toEqual(expected);
    expect(result.families.CONTENT_KEK).toBeUndefined();
  });

  it("reports equal secret values by name only", () => {
    const shared = generatedSecret();
    const issues = duplicateSecretIssues([
      ["SESSION_DIGEST_SECRET_1", shared],
      ["CONTENT_KEK_1", shared],
      ["RESEND_API_KEY", shared],
      ["INVITE_DIGEST_SECRET_1", generatedSecret()],
    ]);
    expect(issues).toEqual([
      { variable: "RESEND_API_KEY", message: "must not reuse the value of CONTENT_KEK_1" },
      { variable: "SESSION_DIGEST_SECRET_1", message: "must not reuse the value of CONTENT_KEK_1" },
    ]);
    expect(JSON.stringify(issues)).not.toContain(shared);
  });

  it("rejects every api-only name pattern for the worker, versioned or not", () => {
    const names = [
      "VAULT_RECOVERY_KEY",
      "VAULT_RECOVERY_KEY_7",
      "SESSION_DIGEST_SECRET_1",
      "FUTURE_DIGEST_SECRET_CURRENT",
      "MCP_OAUTH_SIGNING_KEY_2",
      "IDEMPOTENCY_SECRET_1",
      "RESEND_WEBHOOK_SECRET",
      "COMPOSIO_WEBHOOK_SECRET",
      "POSTHOG_PERSONAL_API_KEY",
      "CLOUDFLARE_D1_API_TOKEN",
      "CLOUDFLARE_D1_MIGRATE_API_TOKEN",
      "TRIGGER_ACCESS_TOKEN",
      // The worker used to hold this one; a model key is now the account's, so it is refused here
      // too and belongs in this list rather than beside the controls below.
      "OPENAI_API_KEY",
    ];
    const variables = Object.fromEntries(names.map((name) => [name, "x"]));
    const issues = rejectedSecretIssues(
      // Controls: a generated family, the platform-injected key and a credential the worker really
      // does hold, none of which may appear in the issues.
      { ...variables, CONTENT_KEK_1: "x", TRIGGER_SECRET_KEY: "x", RESEND_API_KEY: "x" },
      "worker",
    );
    expect(issues.map((issue) => issue.variable).sort()).toEqual([...names].sort());
  });
});
