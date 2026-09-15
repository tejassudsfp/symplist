import type { IncomingMessage } from "node:http";
import {
  INTERNAL_SIGNATURE_HEADERS,
  INTERNAL_SIGNATURE_WINDOW_SECONDS,
  type KeyProvider,
  verifyInternalRequest,
} from "@symplist/crypto";
import type { OperationalLog, RuntimeTimers } from "../../infra/scheduler/runtime.ts";
import type { EventIdMemory } from "./replay-memory.ts";

/** A request whose signature and timestamp verified; nothing was remembered about it. */
export interface SignedInternalRequest {
  readonly eventId: string;
  readonly keyVersion: number;
}

export interface VerifiedInternalRequest extends SignedInternalRequest {
  /** Forgets the event id after a failure that had no effect, so a retry is accepted. */
  release(): void;
}

export type InternalVerificationFailure =
  | "malformed"
  | "stale"
  | "unknown_key"
  | "invalid_signature"
  | "replayed"
  | "memory_full";

export type InternalVerification =
  | { readonly ok: true; readonly request: VerifiedInternalRequest }
  | { readonly ok: false; readonly reason: InternalVerificationFailure };

export type InternalSignatureVerification =
  | { readonly ok: true; readonly request: SignedInternalRequest }
  | { readonly ok: false; readonly reason: InternalVerificationFailure };

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Verifies `X-Sym-*` signatures (§6.2): `INTERNAL_EVENT_SECRET_<n>` HMAC over timestamp, event id,
 * method, the request target and the SHA-256 of the raw body, inside ±300 seconds. {@link verify}
 * then reserves the event id in the 10-minute replay memory; run output uses
 * {@link verifySignature} and deduplicates on `(runId, seq)` instead, because each retry of a batch
 * carries a fresh event id and a streaming run would otherwise fill the memory every internal event
 * shares. Failures are logged by reason only.
 */
export class InternalRequestVerifier {
  constructor(
    private readonly options: {
      readonly keys: KeyProvider;
      readonly memory: EventIdMemory;
      readonly timers: RuntimeTimers;
      readonly log: OperationalLog;
    },
  ) {}

  verify(request: IncomingMessage, body: Buffer, endpoint: string): InternalVerification {
    const signature = this.checkSignature(request, body, endpoint);
    if (!signature.ok) return signature;
    const { eventId, keyVersion, freshUntilMs } = signature;
    const reserved = this.options.memory.reserve(eventId, freshUntilMs);
    if (reserved === "replayed") return this.fail(endpoint, "replayed");
    if (reserved === "full") return this.fail(endpoint, "memory_full");
    const { memory } = this.options;
    return {
      ok: true,
      request: { eventId, keyVersion, release: () => memory.release(eventId) },
    };
  }

  /**
   * Verifies the signature and its freshness without remembering the event id. The caller must make
   * a replay harmless by its own means, as run output does with its `(runId, seq)` dedupe.
   */
  verifySignature(
    request: IncomingMessage,
    body: Buffer,
    endpoint: string,
  ): InternalSignatureVerification {
    const signature = this.checkSignature(request, body, endpoint);
    if (!signature.ok) return signature;
    return { ok: true, request: { eventId: signature.eventId, keyVersion: signature.keyVersion } };
  }

  private checkSignature(
    request: IncomingMessage,
    body: Buffer,
    endpoint: string,
  ):
    | {
        readonly ok: true;
        readonly eventId: string;
        readonly keyVersion: number;
        readonly freshUntilMs: number;
      }
    | { readonly ok: false; readonly reason: InternalVerificationFailure } {
    const result = verifyInternalRequest(
      this.options.keys,
      {
        timestamp: header(request, INTERNAL_SIGNATURE_HEADERS.timestamp),
        eventId: header(request, INTERNAL_SIGNATURE_HEADERS.eventId),
        keyVersion: header(request, INTERNAL_SIGNATURE_HEADERS.keyVersion),
        signature: header(request, INTERNAL_SIGNATURE_HEADERS.signature),
        method: request.method ?? "",
        // Express keeps the request target as sent in `originalUrl`; routers may rewrite `url`.
        path: (request as { originalUrl?: string }).originalUrl ?? request.url ?? "",
        body,
      },
      { nowMs: this.options.timers.now(), windowSeconds: INTERNAL_SIGNATURE_WINDOW_SECONDS },
    );
    if (!result.ok) return this.fail(endpoint, result.reason);
    return {
      ok: true,
      eventId: result.eventId,
      keyVersion: result.keyVersion,
      // The signature stays fresh while floor(now / 1000) is within the window of its timestamp.
      freshUntilMs: (result.timestamp + INTERNAL_SIGNATURE_WINDOW_SECONDS + 1) * 1000,
    };
  }

  private fail(
    endpoint: string,
    reason: InternalVerificationFailure,
  ): { readonly ok: false; readonly reason: InternalVerificationFailure } {
    this.options.log.warn("internal.request_rejected", { endpoint, reason });
    return { ok: false, reason };
  }
}
