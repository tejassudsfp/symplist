import { describe, expect, it } from "vitest";
import { OneTimeSecretResponseError, redactOneTimeSecretResponse } from "./one-time-secret.ts";

const secret = "sym_0190_Zk3mP9xQ2vW8rT6yU4iO1pA7sD5fG3hJ";

describe("one-time secret redaction (§6.1, decision R11)", () => {
  it("keeps the non-secret fields and marks the secret unavailable", () => {
    expect(
      redactOneTimeSecretResponse(
        { grantId: "g1", hint: "sym_…hJ", createdAt: 5, apiKey: secret, secretUnavailable: false },
        ["apiKey"],
      ),
    ).toEqual({
      grantId: "g1",
      hint: "sym_…hJ",
      createdAt: 5,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
  });

  it("refuses responses that break the minting contract", () => {
    const cases: [unknown, readonly string[]][] = [
      [{ apiKey: secret, secretUnavailable: false }, []],
      [null, ["apiKey"]],
      [[secret], ["apiKey"]],
      [{ apiKey: secret }, ["apiKey"]],
      [{ apiKey: secret, secretUnavailable: true }, ["apiKey"]],
      [{ secretUnavailable: false }, ["apiKey"]],
    ];
    for (const [body, keys] of cases) {
      expect(() => redactOneTimeSecretResponse(body, keys)).toThrow(OneTimeSecretResponseError);
    }
  });

  it("refuses a response that repeats the secret in a non-secret field", () => {
    expect(() =>
      redactOneTimeSecretResponse(
        {
          url: `https://share.example/artifact/1?key=${secret}`,
          key: secret,
          secretUnavailable: false,
        },
        ["key"],
      ),
    ).toThrow(/repeats a secret/);
    expect(() =>
      redactOneTimeSecretResponse(
        { nested: { copy: [secret] }, token: { value: secret }, secretUnavailable: false },
        ["token"],
      ),
    ).toThrow(/repeats a secret/);
  });
});
