import { createHash } from "node:crypto";
import { hmacSha256, MAX_DIGEST_INPUT_BYTES } from "./digests.ts";
import { constantTimeEqual } from "./encoding.ts";
import { InputTooLargeError, InvalidCryptoInputError } from "./errors.ts";
import type { KeyProvider } from "./keys.ts";

/**
 * Internal request signatures between the worker and the api (§6.2). Frozen format:
 *
 * `X-Sym-Signature: v1=<hex HMAC-SHA256(INTERNAL_EVENT_SECRET_<n>, 'v1' ‖ 0x00 ‖ timestamp ‖ 0x00 ‖
 * eventId ‖ 0x00 ‖ method ‖ 0x00 ‖ path ‖ 0x00 ‖ sha256(rawBody))>`
 *
 * - `timestamp` is `X-Sym-Timestamp`: Unix epoch **seconds** as a canonical decimal string.
 * - `eventId` is `X-Sym-Event-Id`, `method` the upper-case HTTP method and `path` the request target
 *   exactly as sent (for example `/internal/v1/runs/<runId>/output`).
 * - `sha256(rawBody)` is the SHA-256 of the exact body bytes as 64 **lower-case hex** ASCII characters.
 * - The HMAC key is `INTERNAL_EVENT_SECRET_<n>` where `<n>` travels in `X-Sym-Key`; the signature is
 *   64 lower-case hex characters after `v1=`.
 *
 * Every text field is restricted to printable ASCII without NUL, so the 0x00 framing is unambiguous.
 * Changing any of this breaks the committed vectors in `internal-signature.test.ts`.
 */

/** The only signature scheme; also the first framed field of the signed message. */
export const INTERNAL_SIGNATURE_SCHEME = "v1";

/** Header names, lower-case as Node exposes incoming headers (HTTP names are case-insensitive). */
export const INTERNAL_SIGNATURE_HEADERS = Object.freeze({
  timestamp: "x-sym-timestamp",
  eventId: "x-sym-event-id",
  keyVersion: "x-sym-key",
  signature: "x-sym-signature",
} as const);

/** Requests whose timestamp is further than this from the verifier's clock are rejected (§6.2). */
export const INTERNAL_SIGNATURE_WINDOW_SECONDS = 300;

const timestampPattern = /^(0|[1-9][0-9]{0,15})$/;
const eventIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const methodPattern = /^[A-Z]{1,16}$/;
const pathPattern = /^\/[\x21-\x7e]{0,2047}$/;
const keyVersionPattern = /^[1-9][0-9]{0,8}$/;
const signaturePattern = /^v1=([0-9a-f]{64})$/;

/** The request fields a signature binds. */
export interface InternalSignatureInput {
  /** Unix epoch seconds. */
  readonly timestamp: number;
  readonly eventId: string;
  /** Upper-case HTTP method, for example `POST`. */
  readonly method: string;
  /** The request target as sent, starting with `/`. */
  readonly path: string;
  /** The exact raw body bytes. */
  readonly body: Uint8Array;
}

/** The four headers a signed internal request carries. */
export interface InternalSignatureHeaders {
  readonly "x-sym-timestamp": string;
  readonly "x-sym-event-id": string;
  readonly "x-sym-key": string;
  readonly "x-sym-signature": string;
}

/** A received request: header values as they arrived (possibly absent) plus method, path and body. */
export interface InternalSignedRequest {
  readonly timestamp: string | undefined;
  readonly eventId: string | undefined;
  readonly keyVersion: string | undefined;
  readonly signature: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array;
}

/** Why verification failed; for logs and counters only, never returned to the caller. */
export type InternalSignatureFailure = "malformed" | "stale" | "unknown_key" | "invalid_signature";

export type InternalSignatureVerification =
  | {
      readonly ok: true;
      readonly eventId: string;
      /** Unix epoch seconds. */
      readonly timestamp: number;
      readonly keyVersion: number;
    }
  | { readonly ok: false; readonly reason: InternalSignatureFailure };

export interface InternalSignatureVerifyOptions {
  /** The verifier's clock in UTC epoch milliseconds. */
  readonly nowMs: number;
  /** Defaults to 300 seconds. */
  readonly windowSeconds?: number;
}

function assertInput(input: InternalSignatureInput): void {
  if (typeof input !== "object" || input === null) {
    throw new InvalidCryptoInputError("The internal signature input must be an object");
  }
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new InvalidCryptoInputError("Internal signature timestamps must be whole Unix seconds");
  }
  if (typeof input.eventId !== "string" || !eventIdPattern.test(input.eventId)) {
    throw new InvalidCryptoInputError(
      "Internal signature event ids must be 1-128 token characters",
    );
  }
  if (typeof input.method !== "string" || !methodPattern.test(input.method)) {
    throw new InvalidCryptoInputError("Internal signature methods must be upper-case letters");
  }
  if (typeof input.path !== "string" || !pathPattern.test(input.path)) {
    throw new InvalidCryptoInputError("Internal signature paths must be printable ASCII from /");
  }
  if (!(input.body instanceof Uint8Array)) {
    throw new InvalidCryptoInputError("Internal signature bodies must be bytes");
  }
  if (input.body.byteLength > MAX_DIGEST_INPUT_BYTES) {
    throw new InputTooLargeError("internal request body", MAX_DIGEST_INPUT_BYTES);
  }
}

/** Lower-case hex SHA-256 of the raw body, the last framed field. */
export function internalBodyDigest(body: Uint8Array): string {
  if (!(body instanceof Uint8Array)) {
    throw new InvalidCryptoInputError("Internal signature bodies must be bytes");
  }
  return createHash("sha256").update(body).digest("hex");
}

/** The exact bytes that are signed: `'v1' ‖ 0 ‖ timestamp ‖ 0 ‖ eventId ‖ 0 ‖ method ‖ 0 ‖ path ‖ 0 ‖ hex sha256(body)`. */
export function internalSignatureMessage(input: InternalSignatureInput): Buffer {
  assertInput(input);
  return Buffer.from(
    [
      INTERNAL_SIGNATURE_SCHEME,
      String(input.timestamp),
      input.eventId,
      input.method,
      input.path,
      internalBodyDigest(input.body),
    ].join("\u0000"),
    "ascii",
  );
}

/** `v1=<hex HMAC>` under one 32-byte `INTERNAL_EVENT_SECRET` version. */
export function computeInternalSignature(key: Uint8Array, input: InternalSignatureInput): string {
  return `${INTERNAL_SIGNATURE_SCHEME}=${hmacSha256(key, internalSignatureMessage(input)).toString("hex")}`;
}

/** Signs a request under the current `INTERNAL_EVENT_SECRET` version and returns its headers. */
export function signInternalRequest(
  keys: KeyProvider,
  input: InternalSignatureInput,
): InternalSignatureHeaders {
  const current = keys.current("INTERNAL_EVENT_SECRET");
  return Object.freeze({
    [INTERNAL_SIGNATURE_HEADERS.timestamp]: String(input.timestamp),
    [INTERNAL_SIGNATURE_HEADERS.eventId]: input.eventId,
    [INTERNAL_SIGNATURE_HEADERS.keyVersion]: String(current.version),
    [INTERNAL_SIGNATURE_HEADERS.signature]: computeInternalSignature(current.key, input),
  }) as InternalSignatureHeaders;
}

/**
 * Verifies a received internal request (§6.2): strict header syntax, the ±300-second window, a
 * configured `INTERNAL_EVENT_SECRET` version named by `X-Sym-Key`, and the HMAC compared with
 * `timingSafeEqual`. Replay memory for event ids is the caller's responsibility. Never throws for
 * attacker-controlled input; every failure is a typed result.
 */
export function verifyInternalRequest(
  keys: KeyProvider,
  request: InternalSignedRequest,
  options: InternalSignatureVerifyOptions,
): InternalSignatureVerification {
  const windowSeconds = options.windowSeconds ?? INTERNAL_SIGNATURE_WINDOW_SECONDS;
  if (
    !Number.isFinite(options.nowMs) ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 0
  ) {
    throw new InvalidCryptoInputError("Internal signature verification needs a clock and window");
  }
  const { timestamp, eventId, keyVersion, signature, method, path, body } = request;
  if (
    typeof timestamp !== "string" ||
    !timestampPattern.test(timestamp) ||
    typeof eventId !== "string" ||
    !eventIdPattern.test(eventId) ||
    typeof keyVersion !== "string" ||
    !keyVersionPattern.test(keyVersion) ||
    typeof signature !== "string" ||
    typeof method !== "string" ||
    !methodPattern.test(method) ||
    typeof path !== "string" ||
    !pathPattern.test(path) ||
    !(body instanceof Uint8Array) ||
    body.byteLength > MAX_DIGEST_INPUT_BYTES
  ) {
    return { ok: false, reason: "malformed" };
  }
  const provided = signaturePattern.exec(signature)?.[1];
  const seconds = Number(timestamp);
  if (provided === undefined || !Number.isSafeInteger(seconds)) {
    return { ok: false, reason: "malformed" };
  }
  const nowSeconds = Math.floor(options.nowMs / 1000);
  if (Math.abs(nowSeconds - seconds) > windowSeconds) return { ok: false, reason: "stale" };

  const version = Number(keyVersion);
  const entry = keys.get("INTERNAL_EVENT_SECRET", version);
  if (!entry) return { ok: false, reason: "unknown_key" };

  const expected = hmacSha256(
    entry.key,
    internalSignatureMessage({ timestamp: seconds, eventId, method, path, body }),
  );
  const actual = Buffer.from(provided, "hex");
  if (!constantTimeEqual(expected, actual)) return { ok: false, reason: "invalid_signature" };
  return { ok: true, eventId, timestamp: seconds, keyVersion: version };
}
