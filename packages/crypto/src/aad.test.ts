import { describe, expect, it } from "vitest";
import { type AadVector, expectCryptoError, utf8, vectors } from "../test/support.ts";
import {
  accountKeyWrapAad,
  encodeAad,
  fieldAad,
  MAX_AAD_VALUE_LENGTH,
  objectAad,
  vaultGrantAad,
  vaultItemAad,
  vaultPassphraseWrapAad,
  vaultRecoveryWrapAad,
  vaultSessionWrapAad,
} from "./aad.ts";
import type { FieldEnvelopeContext, ObjectEnvelopeContext } from "./envelopes.ts";
import { InvalidCryptoInputError } from "./errors.ts";

interface VectorInput {
  readonly context: FieldEnvelopeContext & ObjectEnvelopeContext;
  readonly keyVersion: number;
  readonly ownerId: string;
  readonly kekVersion: number;
  readonly vaultVersion: number;
  readonly recoveryKeyVersion: number;
  readonly vaultSessionId: string;
  readonly itemId: string;
  readonly grantId: string;
  readonly taskId: string;
}

function encodeVector(vector: AadVector): Uint8Array {
  const input = vector.input as unknown as VectorInput;
  switch (vector.shape) {
    case "field":
      return fieldAad(input.context, input.keyVersion);
    case "object":
      return objectAad(input.context, input.keyVersion);
    case "account-key":
      return accountKeyWrapAad(input.ownerId, input.kekVersion);
    case "vault-pass":
      return vaultPassphraseWrapAad(input.ownerId, input.vaultVersion);
    case "vault-recovery":
      return vaultRecoveryWrapAad(input.ownerId, input.recoveryKeyVersion);
    case "vault-session":
      return vaultSessionWrapAad(input.ownerId, input.vaultSessionId);
    case "vault-item":
      return vaultItemAad(input.ownerId, input.itemId);
    case "vault-grant":
      return vaultGrantAad(input.ownerId, input.grantId, input.taskId);
  }
}

const field: FieldEnvelopeContext = {
  purpose: "title",
  ownerId: "owner-1",
  table: "tasks",
  rowId: "task-1",
  column: "title_enc",
};
const object: ObjectEnvelopeContext = {
  kind: "bundle",
  ownerId: "owner-1",
  objectId: "u/owner-1/bundles/task-1/1-w.bundle.sym",
  formatVersion: 1,
};

describe("frozen AAD encoding (§4.2)", () => {
  it.each(vectors.aad.map((vector) => [vector.name, vector] as const))(
    "encodes the %s vector byte for byte",
    (_name, vector) => {
      expect(utf8(encodeVector(vector))).toBe(vector.encoded);
    },
  );

  it("covers every AAD shape in the architecture table", () => {
    expect(new Set(vectors.aad.map((vector) => vector.shape))).toEqual(
      new Set([
        "field",
        "object",
        "account-key",
        "vault-pass",
        "vault-recovery",
        "vault-session",
        "vault-item",
        "vault-grant",
      ]),
    );
  });

  it("writes the exact documented JSON for each shape", () => {
    expect(utf8(fieldAad(field, 1))).toBe(
      '{"c":"title_enc","f":"sym1","i":"task-1","k":1,"o":"owner-1","p":"title","t":"tasks"}',
    );
    expect(utf8(objectAad(object, 1))).toBe(
      '{"f":"symo1","i":"u/owner-1/bundles/task-1/1-w.bundle.sym","k":1,"o":"owner-1","p":"bundle","v":1}',
    );
    expect(utf8(accountKeyWrapAad("owner-1", 3))).toBe(
      '{"f":"symk1","kv":3,"o":"owner-1","p":"account-key"}',
    );
    expect(utf8(vaultPassphraseWrapAad("owner-1", 2))).toBe(
      '{"f":"symk1","o":"owner-1","p":"vault-pass","vv":2}',
    );
    expect(utf8(vaultRecoveryWrapAad("owner-1", 4))).toBe(
      '{"f":"symk1","o":"owner-1","p":"vault-recovery","rk":4}',
    );
    expect(utf8(vaultSessionWrapAad("owner-1", "vs-1"))).toBe(
      '{"f":"symk1","o":"owner-1","p":"vault-session","s":"vs-1"}',
    );
    expect(utf8(vaultItemAad("owner-1", "item-1"))).toBe(
      '{"f":"sym1","i":"item-1","o":"owner-1","p":"vault-item"}',
    );
    expect(utf8(vaultGrantAad("owner-1", "grant-1", "task-1"))).toBe(
      '{"f":"sym1","g":"grant-1","o":"owner-1","p":"vault-grant","t":"task-1"}',
    );
  });

  it("sorts keys regardless of insertion order", () => {
    expect(utf8(encodeAad({ p: "x", o: "a", f: "sym1", c: "z" }))).toBe(
      '{"c":"z","f":"sym1","o":"a","p":"x"}',
    );
  });

  it("changes the bytes when any bound field changes", () => {
    const base = utf8(fieldAad(field, 1));
    const variants = [
      fieldAad({ ...field, ownerId: "owner-2" }, 1),
      fieldAad({ ...field, table: "messages" }, 1),
      fieldAad({ ...field, rowId: "task-2" }, 1),
      fieldAad({ ...field, column: "preview_enc" }, 1),
      fieldAad({ ...field, purpose: "preview" }, 1),
      fieldAad(field, 2),
    ].map(utf8);
    expect(new Set([base, ...variants]).size).toBe(7);
    const objectBase = utf8(objectAad(object, 1));
    const objectVariants = [
      objectAad({ ...object, ownerId: "owner-2" }, 1),
      objectAad({ ...object, kind: "artifact" }, 1),
      objectAad({ ...object, objectId: "other" }, 1),
      objectAad({ ...object, formatVersion: 2 }, 1),
      objectAad(object, 2),
    ].map(utf8);
    expect(new Set([objectBase, ...objectVariants]).size).toBe(6);
  });

  it("keeps ambiguous values apart through JSON escaping", () => {
    expect(utf8(vaultGrantAad("o", 'g","t":"x', "t"))).not.toBe(utf8(vaultGrantAad("o", "g", "x")));
    expect(utf8(encodeAad({ f: "sym1", p: 'a"b\\c\u0000' }))).toBe(
      '{"f":"sym1","p":"a\\"b\\\\c\\u0000"}',
    );
  });

  it.each([
    ["an unknown format label", { f: "sym2", p: "x" }],
    ["a missing format label", { p: "x" }],
    ["a missing purpose", { f: "sym1" }],
    ["a numeric purpose", { f: "sym1", p: 1 }],
    ["an uppercase field name", { f: "sym1", p: "x", Owner: "a" }],
    ["a field name with digits", { f: "sym1", p: "x", o1: "a" }],
    ["an empty string value", { f: "sym1", p: "x", o: "" }],
    ["an overlong string value", { f: "sym1", p: "x", o: "a".repeat(MAX_AAD_VALUE_LENGTH + 1) }],
    ["a lone surrogate", { f: "sym1", p: "x", o: "\ud800" }],
    ["a negative number", { f: "sym1", p: "x", k: -1 }],
    ["negative zero", { f: "sym1", p: "x", k: -0 }],
    ["a fractional number", { f: "sym1", p: "x", k: 1.5 }],
    ["an unsafe integer", { f: "sym1", p: "x", k: 2 ** 53 }],
    ["NaN", { f: "sym1", p: "x", k: Number.NaN }],
    ["a boolean", { f: "sym1", p: "x", k: true }],
    ["null", { f: "sym1", p: "x", k: null }],
    ["a nested object", { f: "sym1", p: "x", k: {} }],
  ])("rejects %s", (_label, fields) => {
    expectCryptoError(
      () => encodeAad(fields as unknown as Record<string, string>),
      InvalidCryptoInputError,
    );
  });

  it("rejects values that are not plain objects", () => {
    for (const value of [null, [], new Map([["f", "sym1"]]), new (class {})(), "sym1"]) {
      expectCryptoError(
        () => encodeAad(value as unknown as Record<string, string>),
        InvalidCryptoInputError,
      );
    }
  });

  it("accepts the maximum string length and a null-prototype object", () => {
    const record = Object.assign(Object.create(null) as Record<string, string>, {
      f: "sym1",
      p: "a".repeat(MAX_AAD_VALUE_LENGTH),
    });
    expect(utf8(encodeAad(record))).toBe(`{"f":"sym1","p":"${"a".repeat(MAX_AAD_VALUE_LENGTH)}"}`);
  });

  it("rejects non-positive versions in the typed builders", () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expectCryptoError(() => fieldAad(field, version), InvalidCryptoInputError);
      expectCryptoError(() => objectAad(object, version), InvalidCryptoInputError);
      expectCryptoError(
        () => objectAad({ ...object, formatVersion: version }, 1),
        InvalidCryptoInputError,
      );
      expectCryptoError(() => accountKeyWrapAad("o", version), InvalidCryptoInputError);
      expectCryptoError(() => vaultPassphraseWrapAad("o", version), InvalidCryptoInputError);
      expectCryptoError(() => vaultRecoveryWrapAad("o", version), InvalidCryptoInputError);
    }
  });

  it("rejects empty identifiers in the typed builders", () => {
    expectCryptoError(() => fieldAad({ ...field, ownerId: "" }, 1), InvalidCryptoInputError);
    expectCryptoError(() => objectAad({ ...object, objectId: "" }, 1), InvalidCryptoInputError);
    expectCryptoError(() => vaultSessionWrapAad("o", ""), InvalidCryptoInputError);
    expectCryptoError(() => vaultItemAad("", "i"), InvalidCryptoInputError);
    expectCryptoError(() => vaultGrantAad("o", "g", ""), InvalidCryptoInputError);
  });

  it("rejects numeric identifiers instead of encoding them as JSON numbers", () => {
    const numeric = 5 as unknown as string;
    for (const change of [
      { purpose: numeric },
      { ownerId: numeric },
      { table: numeric },
      { rowId: numeric },
      { column: numeric },
    ]) {
      expectCryptoError(() => fieldAad({ ...field, ...change }, 1), InvalidCryptoInputError);
    }
    for (const change of [{ kind: numeric }, { ownerId: numeric }, { objectId: numeric }]) {
      expectCryptoError(() => objectAad({ ...object, ...change }, 1), InvalidCryptoInputError);
    }
    expectCryptoError(() => accountKeyWrapAad(numeric, 1), InvalidCryptoInputError);
    expectCryptoError(() => vaultPassphraseWrapAad(numeric, 1), InvalidCryptoInputError);
    expectCryptoError(() => vaultRecoveryWrapAad(numeric, 1), InvalidCryptoInputError);
    expectCryptoError(() => vaultSessionWrapAad("o", numeric), InvalidCryptoInputError);
    expectCryptoError(() => vaultItemAad("o", numeric), InvalidCryptoInputError);
    expectCryptoError(() => vaultGrantAad("o", numeric, "t"), InvalidCryptoInputError);
    expectCryptoError(() => vaultGrantAad("o", "g", numeric), InvalidCryptoInputError);
  });

  it("rejects missing contexts with a typed error", () => {
    for (const value of [undefined, null, "context", []]) {
      expectCryptoError(() => fieldAad(value as never, 1), InvalidCryptoInputError);
      expectCryptoError(() => objectAad(value as never, 1), InvalidCryptoInputError);
    }
  });
});
