import { isWellFormedString } from "./encoding.ts";
import { InvalidCryptoInputError } from "./errors.ts";

/** Deepest accepted nesting, so hostile input cannot exhaust the stack. */
export const MAX_CANONICAL_JSON_DEPTH = 64;

function fail(message: string): never {
  throw new InvalidCryptoInputError(`Canonical JSON: ${message}`);
}

function encodeString(value: string): string {
  if (!isWellFormedString(value)) fail("strings must be well-formed Unicode");
  return JSON.stringify(value);
}

function encode(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) fail("value is nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) fail("numbers must be finite");
      return JSON.stringify(value);
    case "string":
      return encodeString(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index) || value[index] === undefined) {
            fail("arrays must not contain holes or undefined");
          }
          items.push(encode(value[index], depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("objects must be plain objects");
      }
      const record = value as Readonly<Record<string, unknown>>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const member = record[key];
        if (member === undefined) continue;
        members.push(`${encodeString(key)}:${encode(member, depth + 1)}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      return fail(`unsupported ${typeof value} value`);
  }
}

/**
 * Canonical JSON text for digests shared across runtimes (idempotency fingerprints §6.1, approval
 * argument digests §8.4): object keys sorted by UTF-16 code unit, no whitespace, strings and finite
 * numbers serialized as `JSON.stringify` does (which matches RFC 8785 for these types, `-0` as `0`).
 * Object members whose value is `undefined` are omitted, as `JSON.stringify` does; `undefined` inside
 * arrays, non-finite numbers, lone surrogates, bigints, functions, symbols and non-plain objects
 * (Date, Map, class instances) are rejected.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}
