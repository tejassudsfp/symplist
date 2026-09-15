import { randomBytes, timingSafeEqual } from "node:crypto";
import { InvalidCryptoInputError } from "./errors.ts";

const base64UrlAlphabet = /^[A-Za-z0-9_-]*$/;
const loneSurrogate = /\p{Cs}/u;

/** Encodes bytes as unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/**
 * Strictly decodes unpadded, canonical base64url. Returns undefined for any other alphabet, padding,
 * impossible length or non-zero trailing bits (Node's own decoder silently ignores all of these), and
 * when `expectedBytes` is given and the decoded length differs.
 */
export function decodeBase64Url(text: string, expectedBytes?: number): Buffer | undefined {
  if (text.length % 4 === 1 || !base64UrlAlphabet.test(text)) return undefined;
  if (expectedBytes !== undefined && text.length !== Math.ceil((expectedBytes * 4) / 3)) {
    return undefined;
  }
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) {
    bytes.fill(0);
    return undefined;
  }
  return bytes;
}

/** The number of base64url characters for `byteLength` bytes. */
export function base64UrlLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

/** True when the string has no unpaired UTF-16 surrogates, so UTF-8 encoding is lossless. */
export function isWellFormedString(value: string): boolean {
  return !loneSurrogate.test(value);
}

/** UTF-8 bytes of a well-formed string; lone surrogates are rejected rather than replaced. */
export function utf8Bytes(value: string, what: string): Buffer {
  if (!isWellFormedString(value)) {
    throw new InvalidCryptoInputError(`${what} must be a well-formed Unicode string`);
  }
  return Buffer.from(value, "utf8");
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes UTF-8 strictly; returns undefined for invalid byte sequences. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return fatalUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Overwrites buffers with zeros. Used for derived keys and intermediate plaintext. */
export function zeroize(...buffers: ReadonlyArray<Uint8Array | undefined>): void {
  for (const buffer of buffers) buffer?.fill(0);
}

function comparable(value: Uint8Array | string): { bytes: Uint8Array; wellFormed: boolean } {
  if (typeof value === "string") {
    // Buffer.from replaces lone surrogates with U+FFFD, so two different malformed strings would
    // encode to the same bytes; such strings never compare equal.
    return { bytes: Buffer.from(value, "utf8"), wellFormed: isWellFormedString(value) };
  }
  if (value instanceof Uint8Array) return { bytes: value, wellFormed: true };
  throw new InvalidCryptoInputError("Constant-time comparison needs strings or bytes");
}

/**
 * Constant-time equality for digests, tokens and verifiers. Strings compare by UTF-8 bytes; a string
 * with unpaired surrogates never compares equal. Inputs of different lengths return false after a
 * comparison of the same cost, so only the length is revealed.
 */
export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const left = comparable(a);
  const right = comparable(b);
  if (left.bytes.byteLength !== right.bytes.byteLength) {
    timingSafeEqual(left.bytes, left.bytes);
    return false;
  }
  const equal = timingSafeEqual(left.bytes, right.bytes);
  return equal && left.wellFormed && right.wellFormed;
}

/** Throws a typed error unless `value` is a non-null object (a binding context, wrap or input record). */
export function requireRecord(value: unknown, what: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidCryptoInputError(`${what} must be an object`);
  }
}

/**
 * A source of random bytes. Production uses `crypto.randomBytes`; tests inject fixed bytes. Each call
 * must return a new buffer: the operation takes ownership and zeroises it once it is no longer needed
 * (for example a per-object key), so no copy of key material is left behind.
 */
export type RandomSource = (byteLength: number) => Uint8Array;

/** `crypto.randomBytes`. */
export const systemRandom: RandomSource = (byteLength) => randomBytes(byteLength);

/** Options accepted by every operation that consumes randomness. */
export interface RandomOptions {
  /** Defaults to `crypto.randomBytes`. Inject only in tests and test-vector generation. */
  readonly random?: RandomSource;
}

/** Draws exactly `byteLength` random bytes, taking ownership of the source's buffer. */
export function drawRandom(options: RandomOptions | undefined, byteLength: number): Buffer {
  const source = options?.random ?? systemRandom;
  const bytes = source(byteLength);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== byteLength) {
    throw new InvalidCryptoInputError(`The random source must return exactly ${byteLength} bytes`);
  }
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
