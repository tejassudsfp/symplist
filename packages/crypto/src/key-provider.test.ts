import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expectCryptoError } from "../test/support.ts";
import { KeyConfigurationError, KeyUnavailableError } from "./errors.ts";
import {
  createEnvKeyProvider,
  createKeyProvider,
  keyFamilies,
  SECRET_KEY_BYTES,
} from "./key-provider.ts";

const secret = (): string => randomBytes(SECRET_KEY_BYTES).toString("base64url");

describe("createEnvKeyProvider", () => {
  it("reads every version and the current version of a family", () => {
    const v1 = secret();
    const v2 = secret();
    const v3 = secret();
    const keys = createEnvKeyProvider({
      CONTENT_KEK_1: v1,
      CONTENT_KEK_3: v3,
      CONTENT_KEK_2: v2,
      CONTENT_KEK_CURRENT: "2",
    });
    expect(keys.current("CONTENT_KEK").version).toBe(2);
    expect(Buffer.from(keys.current("CONTENT_KEK").key).toString("base64url")).toBe(v2);
    expect(keys.all("CONTENT_KEK").map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(Buffer.from(keys.get("CONTENT_KEK", 1)?.key ?? []).toString("base64url")).toBe(v1);
    expect(keys.get("CONTENT_KEK", 4)).toBeUndefined();
    expect(keys.families()).toEqual(["CONTENT_KEK"]);
  });

  it("treats a family with no variables as absent", () => {
    const keys = createEnvKeyProvider({ CONTENT_KEK_1: secret(), CONTENT_KEK_CURRENT: "1" });
    expect(keys.get("VAULT_RECOVERY_KEY", 1)).toBeUndefined();
    const error = expectCryptoError(() => keys.current("VAULT_RECOVERY_KEY"), KeyUnavailableError);
    expect(error.code).toBe("crypto.key_unavailable");
    expectCryptoError(() => keys.all("VAULT_RECOVERY_KEY"), KeyUnavailableError);
  });

  it("does not confuse families that share a suffix", () => {
    const session = secret();
    const shareSession = secret();
    const keys = createEnvKeyProvider({
      SESSION_DIGEST_SECRET_1: session,
      SESSION_DIGEST_SECRET_CURRENT: "1",
      SHARE_SESSION_DIGEST_SECRET_7: shareSession,
      SHARE_SESSION_DIGEST_SECRET_CURRENT: "7",
    });
    expect(keys.all("SESSION_DIGEST_SECRET").map((entry) => entry.version)).toEqual([1]);
    expect(keys.all("SHARE_SESSION_DIGEST_SECRET").map((entry) => entry.version)).toEqual([7]);
  });

  it("reads only the requested families and ignores unrelated variables", () => {
    const keys = createEnvKeyProvider(
      {
        CONTENT_KEK_1: secret(),
        CONTENT_KEK_CURRENT: "1",
        VAULT_RECOVERY_KEY_1: "not even base64",
        CONTENT_KEK_BACKUP: "ignored",
        PATH: "/usr/bin",
      },
      { families: ["CONTENT_KEK"] },
    );
    expect(keys.families()).toEqual(["CONTENT_KEK"]);
  });

  it("enforces required families", () => {
    expectCryptoError(
      () =>
        createEnvKeyProvider(
          { CONTENT_KEK_1: secret(), CONTENT_KEK_CURRENT: "1" },
          { required: ["CONTENT_KEK", "INTERNAL_EVENT_SECRET"] },
        ),
      KeyConfigurationError,
    );
  });

  it.each([
    ["versions without a current version", { CONTENT_KEK_1: "A" }],
    ["a current version without versions", { CONTENT_KEK_CURRENT: "1" }],
    ["a current version that is not configured", { CONTENT_KEK_1: "A", CONTENT_KEK_CURRENT: "2" }],
    ["a zero version", { CONTENT_KEK_0: "A", CONTENT_KEK_CURRENT: "0" }],
    ["a zero-padded version", { CONTENT_KEK_01: "A", CONTENT_KEK_CURRENT: "1" }],
    ["a zero-padded current version", { CONTENT_KEK_1: "A", CONTENT_KEK_CURRENT: "01" }],
    ["a non-numeric current version", { CONTENT_KEK_1: "A", CONTENT_KEK_CURRENT: "latest" }],
    ["a ten-digit version", { CONTENT_KEK_1000000000: "A", CONTENT_KEK_CURRENT: "1000000000" }],
  ])("rejects %s", (_label, env) => {
    const valid = secret();
    const withValues = Object.fromEntries(
      Object.entries(env).map(([name, value]) => [name, value === "A" ? valid : value]),
    );
    expectCryptoError(() => createEnvKeyProvider(withValues), KeyConfigurationError);
  });

  it.each([
    ["an empty value", ""],
    ["31 bytes", randomBytes(31).toString("base64url")],
    ["33 bytes", randomBytes(33).toString("base64url")],
    ["padded base64", `${randomBytes(32).toString("base64url")}=`],
    ["standard base64 characters", `+/${secret().slice(2)}`],
    ["whitespace", ` ${secret()}`],
    ["non-canonical trailing bits", `${secret().slice(0, 42)}B`],
  ])("rejects a secret value with %s without echoing it", (_label, value) => {
    const error = expectCryptoError(
      () => createEnvKeyProvider({ CONTENT_KEK_1: value, CONTENT_KEK_CURRENT: "1" }),
      KeyConfigurationError,
    );
    if (value.length > 0) expect(error.message).not.toContain(value.trim());
  });

  it("zeroises keys on destroy and refuses later use", () => {
    const keys = createEnvKeyProvider({ CONTENT_KEK_1: secret(), CONTENT_KEK_CURRENT: "1" });
    const held = keys.current("CONTENT_KEK").key;
    keys.destroy();
    expect(held.every((byte) => byte === 0)).toBe(true);
    expectCryptoError(() => keys.current("CONTENT_KEK"), KeyConfigurationError);
    expectCryptoError(() => keys.get("CONTENT_KEK", 1), KeyConfigurationError);
    expectCryptoError(() => keys.all("CONTENT_KEK"), KeyConfigurationError);
    expectCryptoError(() => keys.families(), KeyConfigurationError);
  });
});

describe("createKeyProvider", () => {
  it("accepts the config SecretFamilyConfig shape and raw bytes", () => {
    const raw = randomBytes(32);
    const keys = createKeyProvider({
      CONTENT_KEK: { current: 1, versions: new Map([[1, secret()]]) },
      IDEMPOTENCY_SECRET: { current: 5, versions: new Map([[5, raw]]) },
    });
    expect(Buffer.from(keys.current("IDEMPOTENCY_SECRET").key).equals(raw)).toBe(true);
  });

  it("copies raw key bytes so the caller can zeroise its own copy", () => {
    const raw = randomBytes(32);
    const expected = Buffer.from(raw);
    const keys = createKeyProvider({ CONTENT_KEK: { current: 1, versions: new Map([[1, raw]]) } });
    raw.fill(0);
    expect(Buffer.from(keys.current("CONTENT_KEK").key).equals(expected)).toBe(true);
  });

  it("rejects invalid versions and key lengths", () => {
    expectCryptoError(
      () => createKeyProvider({ CONTENT_KEK: { current: 0, versions: new Map([[0, secret()]]) } }),
      KeyConfigurationError,
    );
    expectCryptoError(
      () =>
        createKeyProvider({
          CONTENT_KEK: { current: 1, versions: new Map([[1, randomBytes(16)]]) },
        }),
      KeyConfigurationError,
    );
    expectCryptoError(
      () =>
        createKeyProvider({
          CONTENT_KEK: {
            current: 1,
            versions: new Map([
              [1, secret()],
              [1.5, secret()],
            ]),
          },
        }),
      KeyConfigurationError,
    );
  });

  it("lists every generated secret family from the inventory", () => {
    expect(keyFamilies).toEqual([
      "CONTENT_KEK",
      "INTERNAL_EVENT_SECRET",
      "REMINDER_UNSUBSCRIBE_SECRET",
      "VAULT_RECOVERY_KEY",
      "SESSION_DIGEST_SECRET",
      "OTP_DIGEST_SECRET",
      "INVITE_DIGEST_SECRET",
      "SHARE_DIGEST_SECRET",
      "SHARE_SESSION_DIGEST_SECRET",
      "MCP_TOKEN_DIGEST_SECRET",
      "MCP_OAUTH_SIGNING_KEY",
      "IDEMPOTENCY_SECRET",
    ]);
  });
});
