import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expectCryptoError, flipBase64UrlBit, randomAccountKey, utf8 } from "../test/support.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  accountKeyNeedsRewrap,
  createAccountKey,
  decryptField,
  decryptFieldText,
  decryptObject,
  encryptField,
  encryptFieldText,
  encryptObject,
  type FieldEnvelopeContext,
  IDEMPOTENCY_RESPONSE_PURPOSE,
  idempotencyResponseContext,
  inspectObjectEnvelope,
  MAX_OBJECT_ENVELOPE_BYTES,
  MAX_OBJECT_PLAINTEXT_BYTES,
  type ObjectEnvelopeContext,
  RUN_CHUNK_PURPOSE,
  rewrapAccountKey,
  runChunkContext,
  unwrapAccountKey,
} from "./envelopes.ts";
import {
  CryptoError,
  DecryptionFailedError,
  InputTooLargeError,
  InvalidCryptoInputError,
  KeyUnavailableError,
  MalformedEnvelopeError,
  UnsupportedKeyVersionError,
} from "./errors.ts";
import { createKeyProvider } from "./key-provider.ts";
import type { AccountDataKey } from "./keys.ts";
import { MAX_FIELD_ENVELOPE_LENGTH, MAX_FIELD_PLAINTEXT_BYTES } from "./sym1.ts";

const owner = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const otherOwner = "0199a1b2-c3d4-7e5f-8a6b-000000000002";
const marker = "PLAINTEXT-MARKER-7f3a";

const fieldContext: FieldEnvelopeContext = {
  purpose: "title",
  ownerId: owner,
  table: "tasks",
  rowId: "0199a1b2-0000-7000-8000-000000000001",
  column: "title_enc",
};

const objectContext: ObjectEnvelopeContext = {
  kind: "doc_snapshot",
  ownerId: owner,
  objectId: `u/${owner}/docs/task-1/commit-1.md.sym`,
  formatVersion: 1,
};

/** The same key bytes labelled with another owner, so the owner check passes and only the AAD differs. */
function relabel(key: AccountDataKey, ownerId: string): AccountDataKey {
  return { ownerId, kekVersion: key.kekVersion, key: key.key };
}

function segments(envelope: string): [string, string, string, string] {
  const parts = envelope.split(".");
  expect(parts).toHaveLength(4);
  return parts as [string, string, string, string];
}

describe("field envelopes (sym1)", () => {
  const key = randomAccountKey(owner);
  const envelope = encryptFieldText(key, fieldContext, marker);

  it("round-trips text and bytes", () => {
    expect(decryptFieldText(key, fieldContext, envelope)).toBe(marker);
    const bytes = randomBytes(300);
    const binary = encryptField(key, fieldContext, bytes);
    expect(Buffer.from(decryptField(key, fieldContext, binary)).equals(bytes)).toBe(true);
    expect(decryptFieldText(key, fieldContext, encryptFieldText(key, fieldContext, ""))).toBe("");
  });

  it("uses the sym1.<keyVersion>.<iv>.<ciphertext+tag> layout with a 12-byte IV and 16-byte tag", () => {
    const [format, version, iv, body] = segments(envelope);
    expect(format).toBe("sym1");
    expect(version).toBe("1");
    expect(Buffer.from(iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(body, "base64url")).toHaveLength(Buffer.byteLength(marker) + 16);
    expect(envelope).not.toContain(marker);
  });

  it("uses a fresh IV for every encryption", () => {
    const ivs = new Set(
      Array.from({ length: 50 }, () => segments(encryptFieldText(key, fieldContext, marker))[2]),
    );
    expect(ivs.size).toBe(50);
  });

  it("accepts plaintext up to the limit and rejects one byte more", () => {
    const max = new Uint8Array(MAX_FIELD_PLAINTEXT_BYTES);
    const sealed = encryptField(key, fieldContext, max);
    expect(sealed.length).toBeLessThanOrEqual(MAX_FIELD_ENVELOPE_LENGTH);
    expect(sealed.length).toBeLessThan(2_000_000);
    expect(decryptField(key, fieldContext, sealed).byteLength).toBe(MAX_FIELD_PLAINTEXT_BYTES);
    expectCryptoError(
      () => encryptField(key, fieldContext, new Uint8Array(MAX_FIELD_PLAINTEXT_BYTES + 1)),
      InputTooLargeError,
    );
    expectCryptoError(
      () => encryptFieldText(key, fieldContext, "a".repeat(MAX_FIELD_PLAINTEXT_BYTES + 1)),
      InputTooLargeError,
    );
    expectCryptoError(
      () => decryptField(key, fieldContext, `${"a".repeat(MAX_FIELD_ENVELOPE_LENGTH + 1)}`),
      InputTooLargeError,
    );
  });

  it("fails with a wrong key", () => {
    expectCryptoError(
      () => decryptField(randomAccountKey(owner), fieldContext, envelope),
      DecryptionFailedError,
    );
  });

  it("refuses a key that belongs to another owner", () => {
    const foreign = randomAccountKey(otherOwner);
    expectCryptoError(() => decryptField(foreign, fieldContext, envelope), InvalidCryptoInputError);
    expectCryptoError(
      () => encryptField(foreign, fieldContext, Buffer.from("x")),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () => encryptField({ ...key, key: randomBytes(16) }, fieldContext, Buffer.from("x")),
      InvalidCryptoInputError,
    );
  });

  it.each([
    ["owner", { ownerId: otherOwner }],
    ["table", { table: "messages" }],
    ["row", { rowId: "0199a1b2-0000-7000-8000-000000000002" }],
    ["column", { column: "preview_enc" }],
    ["purpose", { purpose: "preview" }],
  ] as const)("fails when the %s is swapped", (_field, change) => {
    const swapped = { ...fieldContext, ...change };
    expectCryptoError(
      () => decryptField(relabel(key, swapped.ownerId), swapped, envelope),
      DecryptionFailedError,
    );
  });

  it("fails when the key version is changed", () => {
    const [format, , iv, body] = segments(envelope);
    for (const version of ["2", "9", "123456789"]) {
      expectCryptoError(
        () => decryptField(key, fieldContext, [format, version, iv, body].join(".")),
        UnsupportedKeyVersionError,
      );
    }
    for (const version of ["0", "01", "-1", "1a", "", "1234567890"]) {
      expectCryptoError(
        () => decryptField(key, fieldContext, [format, version, iv, body].join(".")),
        MalformedEnvelopeError,
      );
    }
  });

  it("fails when any bit of the IV, ciphertext or tag changes", () => {
    const [format, version, iv, body] = segments(envelope);
    for (let byte = 0; byte < 12; byte += 1) {
      const tampered = [format, version, flipBase64UrlBit(iv, byte), body].join(".");
      expectCryptoError(() => decryptField(key, fieldContext, tampered), DecryptionFailedError);
    }
    const bodyLength = Buffer.from(body, "base64url").byteLength;
    for (let byte = 0; byte < bodyLength; byte += 1) {
      for (const bit of [0, 7]) {
        const tampered = [format, version, iv, flipBase64UrlBit(body, byte, bit)].join(".");
        expectCryptoError(() => decryptField(key, fieldContext, tampered), DecryptionFailedError);
      }
    }
  });

  it("fails when the ciphertext is truncated or extended", () => {
    const [format, version, iv, body] = segments(envelope);
    const bytes = Buffer.from(body, "base64url");
    for (let length = 0; length < bytes.byteLength; length += 1) {
      const truncated = [format, version, iv, bytes.subarray(0, length).toString("base64url")];
      const error = expectCryptoError(
        () => decryptField(key, fieldContext, truncated.join(".")),
        CryptoError,
      );
      expect(error).toSatisfy(
        (value) =>
          value instanceof MalformedEnvelopeError || value instanceof DecryptionFailedError,
      );
    }
    const extended = Buffer.concat([bytes, Buffer.from([0])]).toString("base64url");
    expectCryptoError(
      () => decryptField(key, fieldContext, [format, version, iv, extended].join(".")),
      DecryptionFailedError,
    );
  });

  it.each([
    ["an empty string", () => ""],
    ["another format", (e: string) => e.replace(/^sym1/, "sym2")],
    ["an uppercase format", (e: string) => e.replace(/^sym1/, "SYM1")],
    ["a missing segment", (e: string) => e.split(".").slice(0, 3).join(".")],
    ["an extra segment", (e: string) => `${e}.AAAA`],
    ["a short IV", (e: string) => e.replace(/^(sym1\.1\.)[^.]{2}/, "$1")],
    ["a long IV", (e: string) => e.replace(/^(sym1\.1\.)/, "$1AAAA")],
    ["padding", (e: string) => `${e}==`],
    ["standard base64 characters", (e: string) => e.replace(/\.([^.]*)$/, ".+/$1")],
    ["whitespace", (e: string) => ` ${e}`],
    ["a trailing newline", (e: string) => `${e}\n`],
    ["non-canonical trailing bits", (e: string) => nonCanonical(e)],
    ["a body shorter than a tag", (e: string) => e.replace(/\.[^.]*$/, ".AAAA")],
  ])("rejects %s as malformed", (_label, mutate) => {
    expectCryptoError(
      () => decryptField(key, fieldContext, mutate(envelope)),
      MalformedEnvelopeError,
    );
  });

  it("rejects non-string envelopes as malformed", () => {
    for (const value of [undefined, null, 42, Buffer.from(envelope)]) {
      expectCryptoError(
        () => decryptField(key, fieldContext, value as unknown as string),
        MalformedEnvelopeError,
      );
    }
  });

  it("rejects text that is not UTF-8 and strings with lone surrogates", () => {
    const binary = encryptField(key, fieldContext, Buffer.from([0xff, 0xfe, 0x80]));
    expectCryptoError(() => decryptFieldText(key, fieldContext, binary), MalformedEnvelopeError);
    expectCryptoError(
      () => encryptFieldText(key, fieldContext, "bad \ud800 text"),
      InvalidCryptoInputError,
    );
  });

  it("rejects invalid contexts before decrypting", () => {
    expectCryptoError(
      () => decryptField(key, { ...fieldContext, column: "" }, envelope),
      InvalidCryptoInputError,
    );
  });

  it("builds run chunk and idempotency response bindings", () => {
    expect(runChunkContext(owner, "run-1", 7)).toEqual({
      purpose: RUN_CHUNK_PURPOSE,
      ownerId: owner,
      table: "runs",
      rowId: "run-1",
      column: "seq:7",
    });
    expect(idempotencyResponseContext(owner, "tasks.create", "key:1")).toEqual({
      purpose: IDEMPOTENCY_RESPONSE_PURPOSE,
      ownerId: owner,
      table: "idempotency_records",
      rowId: '["tasks.create","key:1"]',
      column: "response_enc",
    });
    expect(idempotencyResponseContext(owner, "a:b", "c").rowId).not.toBe(
      idempotencyResponseContext(owner, "a", "b:c").rowId,
    );
    const chunk = encryptFieldText(key, runChunkContext(owner, "run-1", 7), marker);
    expectCryptoError(
      () => decryptFieldText(key, runChunkContext(owner, "run-1", 8), chunk),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => decryptFieldText(key, runChunkContext(owner, "run-2", 7), chunk),
      DecryptionFailedError,
    );
    for (const seq of [-1, 1.5, Number.NaN]) {
      expectCryptoError(() => runChunkContext(owner, "run-1", seq), InvalidCryptoInputError);
    }
    expectCryptoError(() => idempotencyResponseContext(owner, "", "k"), InvalidCryptoInputError);
    expectCryptoError(() => idempotencyResponseContext(owner, "s", ""), InvalidCryptoInputError);
  });
});

function nonCanonical(envelope: string): string {
  const parts = envelope.split(".");
  const iv = parts[2] ?? "";
  // A 12-byte IV is 16 characters with no spare bits, so perturb the body's final character instead.
  const body = parts[3] ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const spareBits = (body.length * 6) % 8;
  if (spareBits === 0) throw new Error("body has no spare bits");
  const last = alphabet.indexOf(body.charAt(body.length - 1));
  const perturbed = alphabet.charAt(last | 1);
  return [parts[0], parts[1], iv, `${body.slice(0, -1)}${perturbed}`].join(".");
}

function objectParts(envelope: Uint8Array) {
  const bytes = Buffer.from(envelope);
  const headerLength = bytes.readUInt32BE(5);
  return {
    prefix: bytes.subarray(0, 9),
    header: JSON.parse(bytes.subarray(9, 9 + headerLength).toString("utf8")) as Record<
      string,
      unknown
    >,
    headerText: bytes.subarray(9, 9 + headerLength).toString("utf8"),
    body: bytes.subarray(9 + headerLength),
  };
}

function assemble(headerText: string, body: Uint8Array, magic = "SYMO", version = 1): Buffer {
  const header = Buffer.from(headerText, "utf8");
  const prefix = Buffer.alloc(9);
  prefix.write(magic, 0, "latin1");
  prefix[4] = version;
  prefix.writeUInt32BE(header.byteLength, 5);
  return Buffer.concat([prefix, header, body]);
}

describe("object envelopes (SYMO)", () => {
  const key = randomAccountKey(owner);
  const plaintext = Buffer.from(`# Budget\n\n${marker}\n`, "utf8");
  const envelope = encryptObject(key, objectContext, plaintext);

  it("round-trips bytes, including an empty object", () => {
    expect(Buffer.from(decryptObject(key, objectContext, envelope)).equals(plaintext)).toBe(true);
    const empty = encryptObject(key, objectContext, new Uint8Array(0));
    expect(decryptObject(key, objectContext, empty).byteLength).toBe(0);
  });

  it("writes magic, version byte, header length, canonical JSON header, ciphertext and tag", () => {
    const { prefix, header, headerText, body } = objectParts(envelope);
    expect(prefix.subarray(0, 4).toString("latin1")).toBe("SYMO");
    expect(prefix[4]).toBe(1);
    expect(Object.keys(header).sort()).toEqual(["alg", "iv", "kv", "v", "wk"]);
    expect(header).toMatchObject({ alg: "A256GCM", kv: 1, v: 1 });
    expect(canonicalJson(header)).toBe(headerText);
    expect(Buffer.from(header.iv as string, "base64url")).toHaveLength(12);
    expect(Buffer.from(header.wk as string, "base64url")).toHaveLength(60);
    expect(body.byteLength).toBe(plaintext.byteLength + 16);
    expect(Buffer.from(envelope).includes(Buffer.from(marker))).toBe(false);
    expect(inspectObjectEnvelope(envelope)).toEqual({ formatVersion: 1, keyVersion: 1 });
  });

  it("uses a fresh object key and IVs for every object", () => {
    const first = objectParts(encryptObject(key, objectContext, plaintext)).header;
    const second = objectParts(encryptObject(key, objectContext, plaintext)).header;
    expect(first.wk).not.toBe(second.wk);
    expect(first.iv).not.toBe(second.iv);
  });

  it("fails with a wrong key or a foreign owner's key", () => {
    expectCryptoError(
      () => decryptObject(randomAccountKey(owner), objectContext, envelope),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => decryptObject(randomAccountKey(otherOwner), objectContext, envelope),
      InvalidCryptoInputError,
    );
  });

  it.each([
    ["owner", { ownerId: otherOwner }],
    ["kind", { kind: "artifact" }],
    ["object id", { objectId: `u/${owner}/docs/task-1/commit-2.md.sym` }],
    ["format version", { formatVersion: 2 }],
  ] as const)("fails when the %s is swapped", (_field, change) => {
    const swapped = { ...objectContext, ...change };
    expectCryptoError(
      () => decryptObject(relabel(key, swapped.ownerId), swapped, envelope),
      DecryptionFailedError,
    );
  });

  it("fails when header fields are modified", () => {
    const { header, body } = objectParts(envelope);
    const withHeader = (changes: Record<string, unknown>) =>
      assemble(canonicalJson({ ...header, ...changes }), body);
    expectCryptoError(
      () => decryptObject(key, objectContext, withHeader({ v: 2 })),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => decryptObject(key, { ...objectContext, formatVersion: 2 }, withHeader({ v: 2 })),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => decryptObject(key, objectContext, withHeader({ kv: 2 })),
      UnsupportedKeyVersionError,
    );
    expectCryptoError(
      () =>
        decryptObject(
          key,
          objectContext,
          withHeader({ iv: flipBase64UrlBit(header.iv as string, 3) }),
        ),
      DecryptionFailedError,
    );
    for (const byte of [0, 11, 12, 43, 44, 59]) {
      expectCryptoError(
        () =>
          decryptObject(
            key,
            objectContext,
            withHeader({ wk: flipBase64UrlBit(header.wk as string, byte) }),
          ),
        DecryptionFailedError,
      );
    }
    for (const changes of [
      { alg: "A128GCM" },
      { v: 0 },
      { v: 1.5 },
      { kv: 0 },
      { kv: "1" },
      { iv: "short" },
      { wk: "short" },
      { extra: 1 },
    ]) {
      expectCryptoError(
        () => decryptObject(key, objectContext, withHeader(changes)),
        MalformedEnvelopeError,
      );
    }
  });

  it("rejects headers that are not canonical JSON", () => {
    const { header, headerText, body } = objectParts(envelope);
    const reordered = `{${Object.entries(header)
      .reverse()
      .map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`)
      .join(",")}}`;
    const variants = [
      reordered,
      headerText.replace(":", ": "),
      ` ${headerText}`,
      headerText.replace('"v":1', '"v":1.0'),
      headerText.replace('"alg":"A256GCM"', '"alg":"A256GCM","alg":"A256GCM"'),
      JSON.stringify([header]),
      "null",
      "{",
      // Escaped lone surrogates are valid UTF-8 and valid JSON but never valid base64url.
      canonicalJson({ ...header, iv: "AAAA" }).replace(
        '"iv":"AAAA"',
        `"iv":"\\ud800${String(header.iv).slice(1)}"`,
      ),
      canonicalJson({ ...header, wk: "AAAA" }).replace(
        '"wk":"AAAA"',
        `"wk":"\\udc00${String(header.wk).slice(1)}"`,
      ),
      canonicalJson({ ...header, wk: `${String(header.wk).slice(0, 79)}=` }),
      canonicalJson({ ...header, iv: `${String(header.iv).slice(0, 15)}+` }),
    ];
    for (const variant of variants) {
      expectCryptoError(
        () => decryptObject(key, objectContext, assemble(variant, body)),
        MalformedEnvelopeError,
      );
    }
    const invalidUtf8 = Buffer.concat([
      Buffer.from(headerText.slice(0, -1)),
      Buffer.from([0xff, 0x7d]),
    ]);
    const prefix = Buffer.alloc(9);
    prefix.write("SYMO", 0, "latin1");
    prefix[4] = 1;
    prefix.writeUInt32BE(invalidUtf8.byteLength, 5);
    expectCryptoError(
      () => decryptObject(key, objectContext, Buffer.concat([prefix, invalidUtf8, body])),
      MalformedEnvelopeError,
    );
  });

  it("fails when any byte of the ciphertext or tag changes, or bytes are appended", () => {
    const { headerText, body } = objectParts(envelope);
    for (let index = 0; index < body.byteLength; index += 1) {
      const tampered = Buffer.from(body);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expectCryptoError(
        () => decryptObject(key, objectContext, assemble(headerText, tampered)),
        DecryptionFailedError,
      );
    }
    expectCryptoError(
      () => decryptObject(key, objectContext, Buffer.concat([envelope, Buffer.from([0])])),
      DecryptionFailedError,
    );
  });

  it("fails when bodies or wrapped keys are swapped between objects", () => {
    const other = encryptObject(key, objectContext, Buffer.from("other object", "utf8"));
    const mine = objectParts(envelope);
    const theirs = objectParts(other);
    expectCryptoError(
      () => decryptObject(key, objectContext, assemble(mine.headerText, theirs.body)),
      DecryptionFailedError,
    );
    expectCryptoError(
      () =>
        decryptObject(
          key,
          objectContext,
          assemble(canonicalJson({ ...mine.header, wk: theirs.header.wk }), mine.body),
        ),
      DecryptionFailedError,
    );
  });

  it("fails without plaintext for every truncation", () => {
    for (let length = 0; length < envelope.byteLength; length += 1) {
      const error = expectCryptoError(
        () => decryptObject(key, objectContext, envelope.subarray(0, length)),
        CryptoError,
      );
      expect(error).toSatisfy(
        (value) =>
          value instanceof MalformedEnvelopeError || value instanceof DecryptionFailedError,
      );
    }
  });

  it("rejects bad magic, container versions and header lengths", () => {
    const { headerText, body } = objectParts(envelope);
    expectCryptoError(
      () => decryptObject(key, objectContext, assemble(headerText, body, "SYMX")),
      MalformedEnvelopeError,
    );
    expectCryptoError(
      () => decryptObject(key, objectContext, assemble(headerText, body, "SYMO", 2)),
      MalformedEnvelopeError,
    );
    for (const headerLength of [
      0,
      1025,
      0xffffffff,
      Buffer.byteLength(headerText) + body.byteLength,
    ]) {
      const bytes = Buffer.from(envelope);
      bytes.writeUInt32BE(headerLength, 5);
      expectCryptoError(() => decryptObject(key, objectContext, bytes), MalformedEnvelopeError);
    }
    for (const value of [undefined, "SYMO", [83, 89, 77, 79]]) {
      expectCryptoError(
        () => decryptObject(key, objectContext, value as unknown as Uint8Array),
        MalformedEnvelopeError,
      );
    }
  });

  it("rejects oversized plaintext and envelopes", () => {
    expectCryptoError(
      () => encryptObject(key, objectContext, new Uint8Array(MAX_OBJECT_PLAINTEXT_BYTES + 1)),
      InputTooLargeError,
    );
    expectCryptoError(
      () => decryptObject(key, objectContext, new Uint8Array(MAX_OBJECT_ENVELOPE_BYTES + 1)),
      InputTooLargeError,
    );
  });

  it("rejects invalid contexts", () => {
    for (const change of [{ formatVersion: 0 }, { kind: "" }, { objectId: "" }]) {
      expectCryptoError(
        () => encryptObject(key, { ...objectContext, ...change }, plaintext),
        InvalidCryptoInputError,
      );
      expectCryptoError(
        () => decryptObject(key, { ...objectContext, ...change }, envelope),
        InvalidCryptoInputError,
      );
    }
  });
});

describe("account data keys", () => {
  const secret = () => randomBytes(32);
  const kek1 = secret();
  const kek2 = secret();
  const underV1 = createKeyProvider({
    CONTENT_KEK: { current: 1, versions: new Map([[1, kek1]]) },
  });
  const rotated = createKeyProvider({
    CONTENT_KEK: {
      current: 2,
      versions: new Map([
        [1, kek1],
        [2, kek2],
      ]),
    },
  });

  it("creates a random key wrapped under the current CONTENT_KEK", () => {
    const { key, wrapped } = createAccountKey(rotated, owner);
    expect(key.ownerId).toBe(owner);
    expect(key.kekVersion).toBe(2);
    expect(key.key).toHaveLength(32);
    expect(wrapped).toMatchObject({ ownerId: owner, kekVersion: 2 });
    expect(wrapped.wrapped).toMatch(/^[A-Za-z0-9_-]{80}$/);
    const unwrapped = unwrapAccountKey(rotated, wrapped);
    expect(Buffer.from(unwrapped.key).equals(Buffer.from(key.key))).toBe(true);
    expect(createAccountKey(rotated, owner).wrapped.wrapped).not.toBe(wrapped.wrapped);
  });

  it("rotates by re-wrapping without re-encrypting envelopes", () => {
    const { key, wrapped } = createAccountKey(underV1, owner);
    const field = encryptFieldText(key, fieldContext, marker);
    const object = encryptObject(key, objectContext, Buffer.from(marker));
    expect(accountKeyNeedsRewrap(rotated, wrapped)).toBe(true);
    expect(Buffer.from(unwrapAccountKey(rotated, wrapped).key).equals(Buffer.from(key.key))).toBe(
      true,
    );

    const rewrapped = rewrapAccountKey(rotated, wrapped);
    expect(rewrapped.kekVersion).toBe(2);
    expect(accountKeyNeedsRewrap(rotated, rewrapped)).toBe(false);

    const afterRotation = unwrapAccountKey(
      createKeyProvider({ CONTENT_KEK: { current: 2, versions: new Map([[2, kek2]]) } }),
      rewrapped,
    );
    expect(afterRotation.kekVersion).toBe(2);
    expect(decryptFieldText(afterRotation, fieldContext, field)).toBe(marker);
    expect(utf8(decryptObject(afterRotation, objectContext, object))).toBe(marker);
  });

  it("fails when the recorded KEK version is not configured", () => {
    const { wrapped } = createAccountKey(rotated, owner);
    const error = expectCryptoError(
      () => unwrapAccountKey(underV1, wrapped),
      KeyUnavailableError,
    ) as KeyUnavailableError;
    expect(error.family).toBe("CONTENT_KEK");
    expect(error.version).toBe(2);
  });

  it("fails when the recorded KEK version is swapped for another configured version", () => {
    const { wrapped } = createAccountKey(rotated, owner);
    expectCryptoError(
      () => unwrapAccountKey(rotated, { ...wrapped, kekVersion: 1 }),
      DecryptionFailedError,
    );
  });

  it("fails with a different key at the recorded version", () => {
    const { wrapped } = createAccountKey(underV1, owner);
    const impostor = createKeyProvider({
      CONTENT_KEK: { current: 1, versions: new Map([[1, secret()]]) },
    });
    expectCryptoError(() => unwrapAccountKey(impostor, wrapped), DecryptionFailedError);
  });

  it("fails when the owner is swapped", () => {
    const { wrapped } = createAccountKey(rotated, owner);
    expectCryptoError(
      () => unwrapAccountKey(rotated, { ...wrapped, ownerId: otherOwner }),
      DecryptionFailedError,
    );
  });

  it("fails when any bit of the wrap changes", () => {
    const { wrapped } = createAccountKey(rotated, owner);
    for (let byte = 0; byte < 60; byte += 1) {
      expectCryptoError(
        () =>
          unwrapAccountKey(rotated, {
            ...wrapped,
            wrapped: flipBase64UrlBit(wrapped.wrapped, byte),
          }),
        DecryptionFailedError,
      );
    }
  });

  it("rejects malformed wraps", () => {
    const { wrapped } = createAccountKey(rotated, owner);
    for (const text of [
      "",
      wrapped.wrapped.slice(1),
      `${wrapped.wrapped}A`,
      `${wrapped.wrapped.slice(0, 79)}+`,
      `${wrapped.wrapped.slice(0, 79)}=`,
    ]) {
      expectCryptoError(
        () => unwrapAccountKey(rotated, { ...wrapped, wrapped: text }),
        MalformedEnvelopeError,
      );
    }
    for (const kekVersion of [0, -1, 1.5]) {
      expectCryptoError(
        () => unwrapAccountKey(rotated, { ...wrapped, kekVersion }),
        InvalidCryptoInputError,
      );
    }
    expectCryptoError(
      () => unwrapAccountKey(rotated, null as unknown as typeof wrapped),
      InvalidCryptoInputError,
    );
  });

  it("fails to create a key when CONTENT_KEK is missing", () => {
    const none = createKeyProvider({});
    expectCryptoError(() => createAccountKey(none, owner), KeyUnavailableError);
    expectCryptoError(() => createAccountKey(rotated, ""), InvalidCryptoInputError);
  });
});
