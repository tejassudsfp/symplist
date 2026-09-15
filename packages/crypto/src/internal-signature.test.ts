import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvalidCryptoInputError } from "./errors.ts";
import * as cryptoIndex from "./index.ts";
import {
  computeInternalSignature,
  INTERNAL_SIGNATURE_HEADERS,
  type InternalSignatureInput,
  type InternalSignedRequest,
  internalBodyDigest,
  internalSignatureMessage,
  signInternalRequest,
  verifyInternalRequest,
} from "./internal-signature.ts";
import { createKeyProvider } from "./key-provider.ts";

/**
 * Frozen vectors for the §6.2 signature format. Keys are SHA-256 of fixed labels (throwaway test
 * values). Changing the format, the framing or the body digest encoding must fail these.
 */
const vectorKeys = {
  1: "_V3IoNQtMtkoSZ5ipOk7WIXVAUX8_TTkcJ4eOv_RHVg",
  2: "9GhJiCPIPnl8kLxAGsL_OB_eo6pMn9mQEFrsCo-mP0A",
} as const;

const vectors = [
  {
    name: "internal event",
    keyVersion: 1,
    input: {
      timestamp: 1_789_462_800,
      eventId: "01996d2a-4c00-7000-8000-000000000001",
      method: "POST",
      path: "/internal/v1/events",
      body: '{"id":"01996d2a-4c00-7000-8000-000000000001","type":"tasks.changed"}',
    },
    bodyDigest: "ab0a41bf1f6f6fe2266d1ad6a162efbd94a53406e2b717d459705232957968c7",
    signature: "v1=188e2e9e4435bcf5c4c1c65909ff746a1d7b5d748a46816ab6223846a6b2e31d",
  },
  {
    name: "run output under key version 2",
    keyVersion: 2,
    input: {
      timestamp: 1_789_462_801,
      eventId: "01996d2a-4c00-7000-8000-000000000002",
      method: "POST",
      path: "/internal/v1/runs/01996d2a-4c00-7000-8000-0000000000aa/output",
      body: '{"runId":"01996d2a-4c00-7000-8000-0000000000aa","attempt":1,"seq":0,"envelope":"sym1.1.x.y"}',
    },
    bodyDigest: "18df7d64805d2e1d8ceb5243a77073f83b4416b65e0808cc5bf6ece84887279d",
    signature: "v1=4669c9c80548ecad40a77db497fddd36fe64efbd5534ac9fc31183a9472db72a",
  },
  {
    name: "empty body at the epoch",
    keyVersion: 1,
    input: { timestamp: 0, eventId: "e", method: "POST", path: "/", body: "" },
    bodyDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    signature: "v1=52dcb31c855b4dfbe3f443b026982e35349a9c6f0ef10f582d6e865af5a4a7ad",
  },
] as const;

function keyProvider(current: 1 | 2 = 2, versions: readonly (1 | 2)[] = [1, 2]) {
  return createKeyProvider({
    INTERNAL_EVENT_SECRET: {
      current,
      versions: new Map(versions.map((version) => [version, vectorKeys[version]])),
    },
  });
}

function toInput(vector: (typeof vectors)[number]): InternalSignatureInput {
  return { ...vector.input, body: Buffer.from(vector.input.body, "utf8") };
}

function received(
  input: InternalSignatureInput,
  headers: Record<string, string>,
): InternalSignedRequest {
  return {
    timestamp: headers[INTERNAL_SIGNATURE_HEADERS.timestamp],
    eventId: headers[INTERNAL_SIGNATURE_HEADERS.eventId],
    keyVersion: headers[INTERNAL_SIGNATURE_HEADERS.keyVersion],
    signature: headers[INTERNAL_SIGNATURE_HEADERS.signature],
    method: input.method,
    path: input.path,
    body: input.body,
  };
}

describe("internal request signature vectors (§6.2)", () => {
  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    "reproduces %s byte for byte",
    (_name, vector) => {
      const input = toInput(vector);
      const key = Buffer.from(vectorKeys[vector.keyVersion], "base64url");
      expect(internalBodyDigest(input.body)).toBe(vector.bodyDigest);
      expect(computeInternalSignature(key, input)).toBe(vector.signature);

      // An independent computation of the documented framing agrees with the helper.
      const framed = [
        "v1",
        String(vector.input.timestamp),
        vector.input.eventId,
        vector.input.method,
        vector.input.path,
        createHash("sha256").update(input.body).digest("hex"),
      ].join("\u0000");
      expect(internalSignatureMessage(input).toString("ascii")).toBe(framed);
      expect(`v1=${createHmac("sha256", key).update(framed, "ascii").digest("hex")}`).toBe(
        vector.signature,
      );
    },
  );

  it("uses a lower-case hex body digest, not base64", () => {
    const digest = internalBodyDigest(Buffer.from("x"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs with the current key version and names it in X-Sym-Key", () => {
    const vector = vectors[1];
    const headers = signInternalRequest(keyProvider(2), toInput(vector));
    expect(headers).toEqual({
      "x-sym-timestamp": "1789462801",
      "x-sym-event-id": vector.input.eventId,
      "x-sym-key": "2",
      "x-sym-signature": vector.signature,
    });
  });

  it("is exported from the package index", () => {
    expect(typeof cryptoIndex.signInternalRequest).toBe("function");
    expect(typeof cryptoIndex.verifyInternalRequest).toBe("function");
  });
});

describe("verifyInternalRequest", () => {
  const vector = vectors[0];
  const input = toInput(vector);
  const nowMs = vector.input.timestamp * 1000;
  const keys = keyProvider(1);
  const headers = { ...signInternalRequest(keys, input) };

  it("accepts a valid request and reports the event id, timestamp and key version", () => {
    expect(verifyInternalRequest(keys, received(input, headers), { nowMs })).toEqual({
      ok: true,
      eventId: vector.input.eventId,
      timestamp: vector.input.timestamp,
      keyVersion: 1,
    });
  });

  it("accepts an older configured key version during rotation", () => {
    expect(verifyInternalRequest(keyProvider(2), received(input, headers), { nowMs }).ok).toBe(
      true,
    );
  });

  it.each([
    ["the body", { body: Buffer.from(`${vector.input.body} `) }],
    ["the path", { path: "/internal/v1/events/" }],
    ["the method", { method: "PUT" }],
  ] as const)("rejects a forged request with a changed %s", (_what, change) => {
    const request = { ...received(input, headers), ...change };
    expect(verifyInternalRequest(keys, request, { nowMs })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects a changed event id or timestamp even inside the window", () => {
    expect(
      verifyInternalRequest(
        keys,
        received(input, { ...headers, "x-sym-event-id": "01996d2a-4c00-7000-8000-000000000009" }),
        { nowMs },
      ),
    ).toEqual({ ok: false, reason: "invalid_signature" });
    expect(
      verifyInternalRequest(
        keys,
        received(input, { ...headers, "x-sym-timestamp": String(vector.input.timestamp + 1) }),
        { nowMs },
      ),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a signature made with another secret", () => {
    const other = Buffer.from(vectorKeys[2], "base64url");
    const forged = { ...headers, "x-sym-signature": computeInternalSignature(other, input) };
    expect(verifyInternalRequest(keys, received(input, forged), { nowMs })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects a key version that is not configured", () => {
    const wrongVersion = { ...headers, "x-sym-key": "2" };
    expect(
      verifyInternalRequest(keyProvider(1, [1]), received(input, wrongVersion), { nowMs }),
    ).toEqual({ ok: false, reason: "unknown_key" });
    // The right bytes under the wrong version number still fail when that version exists.
    expect(verifyInternalRequest(keyProvider(2), received(input, wrongVersion), { nowMs })).toEqual(
      {
        ok: false,
        reason: "invalid_signature",
      },
    );
  });

  it("enforces the ±300-second window at both edges", () => {
    const request = received(input, headers);
    expect(verifyInternalRequest(keys, request, { nowMs: nowMs + 300_999 }).ok).toBe(true);
    expect(verifyInternalRequest(keys, request, { nowMs: nowMs - 300_000 }).ok).toBe(true);
    expect(verifyInternalRequest(keys, request, { nowMs: nowMs + 301_000 })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(verifyInternalRequest(keys, request, { nowMs: nowMs - 301_000 })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it.each([
    ["a missing signature", { "x-sym-signature": undefined }],
    ["an upper-case signature", { "x-sym-signature": vector.signature.toUpperCase() }],
    ["a signature without the scheme", { "x-sym-signature": vector.signature.slice(3) }],
    ["a v2 scheme", { "x-sym-signature": `v2=${vector.signature.slice(3)}` }],
    ["a truncated signature", { "x-sym-signature": vector.signature.slice(0, -2) }],
    ["a millisecond timestamp with a sign", { "x-sym-timestamp": "+1789462800" }],
    ["a non-canonical timestamp", { "x-sym-timestamp": "01789462800" }],
    ["a missing key version", { "x-sym-key": undefined }],
    ["a zero key version", { "x-sym-key": "0" }],
    ["an event id with a NUL byte", { "x-sym-event-id": "a\u0000b" }],
    ["an empty event id", { "x-sym-event-id": "" }],
  ] as const)("reports %s as malformed", (_what, change) => {
    const request = received(input, { ...headers, ...change } as Record<string, string>);
    expect(verifyInternalRequest(keys, request, { nowMs })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses to sign fields that would break the framing", () => {
    expect(() =>
      computeInternalSignature(Buffer.alloc(32), { ...input, path: "no-slash" }),
    ).toThrow(InvalidCryptoInputError);
    expect(() =>
      computeInternalSignature(Buffer.alloc(32), { ...input, eventId: "a\u0000b" }),
    ).toThrow(InvalidCryptoInputError);
    expect(() => computeInternalSignature(Buffer.alloc(32), { ...input, method: "post" })).toThrow(
      InvalidCryptoInputError,
    );
    expect(() => computeInternalSignature(Buffer.alloc(31), input)).toThrow(
      InvalidCryptoInputError,
    );
  });
});
