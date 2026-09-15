import { isWellFormedString, requireRecord } from "./encoding.ts";
import type { FieldEnvelopeContext, ObjectEnvelopeContext } from "./envelopes.ts";
import { InvalidCryptoInputError } from "./errors.ts";

/** The `f` label of field envelopes, Vault items and Vault grant values (§4.2). */
export const FIELD_FORMAT = "sym1";
/** The `f` label of R2 object envelopes (§4.2). */
export const OBJECT_FORMAT = "symo1";
/** The `f` label of key wraps: account key and the Vault passphrase, recovery and session wraps. */
export const KEY_WRAP_FORMAT = "symk1";

/** Longest accepted AAD string value, in UTF-16 code units. */
export const MAX_AAD_VALUE_LENGTH = 1024;

const formats: ReadonlySet<string> = new Set([FIELD_FORMAT, OBJECT_FORMAT, KEY_WRAP_FORMAT]);
const fieldName = /^[a-z]{1,16}$/;

function assertPlainRecord(value: unknown): asserts value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidCryptoInputError("AAD fields must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidCryptoInputError("AAD fields must be a plain object");
  }
}

function encodeValue(name: string, value: unknown): string {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > MAX_AAD_VALUE_LENGTH) {
      throw new InvalidCryptoInputError(
        `AAD field ${name} must be 1 to ${MAX_AAD_VALUE_LENGTH} characters`,
      );
    }
    if (!isWellFormedString(value)) {
      throw new InvalidCryptoInputError(`AAD field ${name} must be well-formed Unicode`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new InvalidCryptoInputError(`AAD field ${name} must be a non-negative safe integer`);
    }
    return String(value);
  }
  throw new InvalidCryptoInputError(`AAD field ${name} must be a string or an integer`);
}

/**
 * Canonical AAD bytes: UTF-8 JSON with keys sorted by code unit and no whitespace (§4.2). Strings are
 * escaped exactly as `JSON.stringify` escapes them; numbers are non-negative safe integers. Every AAD
 * carries a known format label `f` and a purpose `p`. Frozen: changing this breaks every stored
 * envelope, and the committed test vectors fail.
 */
export function encodeAad(fields: Readonly<Record<string, string | number>>): Uint8Array {
  assertPlainRecord(fields);
  const names = Object.keys(fields).sort();
  if (typeof fields.f !== "string" || !formats.has(fields.f)) {
    throw new InvalidCryptoInputError("AAD field f must be a known envelope format");
  }
  if (typeof fields.p !== "string") {
    throw new InvalidCryptoInputError("AAD field p must be a purpose string");
  }
  const parts: string[] = [];
  for (const name of names) {
    if (!fieldName.test(name)) throw new InvalidCryptoInputError("AAD field names must be a-z");
    parts.push(`${JSON.stringify(name)}:${encodeValue(name, fields[name])}`);
  }
  return Buffer.from(`{${parts.join(",")}}`, "utf8");
}

function positiveVersion(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidCryptoInputError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Identifiers, purposes, tables and columns are always JSON strings in the frozen AAD. Without this
 * check a numeric id would encode as `"o":5` instead of `"o":"5"`, a silently different format.
 */
function text(name: string, value: string): string {
  if (typeof value !== "string") throw new InvalidCryptoInputError(`${name} must be a string`);
  return value;
}

/** `{"c","f":"sym1","i","k","o","p","t"}` for a field envelope. */
export function fieldAad(fieldContext: FieldEnvelopeContext, keyVersion: number): Uint8Array {
  requireRecord(fieldContext, "The field envelope context");
  return encodeAad({
    f: FIELD_FORMAT,
    p: text("purpose", fieldContext.purpose),
    o: text("ownerId", fieldContext.ownerId),
    t: text("table", fieldContext.table),
    i: text("rowId", fieldContext.rowId),
    c: text("column", fieldContext.column),
    k: positiveVersion("keyVersion", keyVersion),
  });
}

/** `{"f":"symo1","i","k","o","p","v"}` for an object envelope. */
export function objectAad(objectContext: ObjectEnvelopeContext, keyVersion: number): Uint8Array {
  requireRecord(objectContext, "The object envelope context");
  return encodeAad({
    f: OBJECT_FORMAT,
    p: text("kind", objectContext.kind),
    o: text("ownerId", objectContext.ownerId),
    i: text("objectId", objectContext.objectId),
    v: positiveVersion("formatVersion", objectContext.formatVersion),
    k: positiveVersion("keyVersion", keyVersion),
  });
}

/** `{"f":"symk1","kv","o","p":"account-key"}` for the account data key wrap. */
export function accountKeyWrapAad(ownerId: string, kekVersion: number): Uint8Array {
  return encodeAad({
    f: KEY_WRAP_FORMAT,
    p: "account-key",
    o: text("ownerId", ownerId),
    kv: positiveVersion("kekVersion", kekVersion),
  });
}

/** `{"f":"symk1","o","p":"vault-pass","vv"}` for the Vault passphrase wrap. */
export function vaultPassphraseWrapAad(ownerId: string, vaultVersion: number): Uint8Array {
  return encodeAad({
    f: KEY_WRAP_FORMAT,
    p: "vault-pass",
    o: text("ownerId", ownerId),
    vv: positiveVersion("vaultVersion", vaultVersion),
  });
}

/** `{"f":"symk1","o","p":"vault-recovery","rk"}` for the Vault recovery wrap. */
export function vaultRecoveryWrapAad(ownerId: string, recoveryKeyVersion: number): Uint8Array {
  return encodeAad({
    f: KEY_WRAP_FORMAT,
    p: "vault-recovery",
    o: text("ownerId", ownerId),
    rk: positiveVersion("recoveryKeyVersion", recoveryKeyVersion),
  });
}

/** `{"f":"symk1","o","p":"vault-session","s"}` for the Vault session wrap. */
export function vaultSessionWrapAad(ownerId: string, vaultSessionId: string): Uint8Array {
  return encodeAad({
    f: KEY_WRAP_FORMAT,
    p: "vault-session",
    o: text("ownerId", ownerId),
    s: text("vaultSessionId", vaultSessionId),
  });
}

/** `{"f":"sym1","i","o","p":"vault-item"}` for a Vault item. */
export function vaultItemAad(ownerId: string, itemId: string): Uint8Array {
  return encodeAad({
    f: FIELD_FORMAT,
    p: "vault-item",
    o: text("ownerId", ownerId),
    i: text("itemId", itemId),
  });
}

/** `{"f":"sym1","g","o","p":"vault-grant","t"}` for a Vault grant value. */
export function vaultGrantAad(ownerId: string, grantId: string, taskId: string): Uint8Array {
  return encodeAad({
    f: FIELD_FORMAT,
    p: "vault-grant",
    o: text("ownerId", ownerId),
    g: text("grantId", grantId),
    t: text("taskId", taskId),
  });
}
