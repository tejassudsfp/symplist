import type { IncomingMessage } from "node:http";
import {
  INTERNAL_SIGNATURE_HEADERS,
  INTERNAL_SIGNATURE_WINDOW_SECONDS,
  type KeyProvider,
  verifyInternalRequest,
} from "@symplist/crypto";
import type { OperationalLog, RuntimeTimers } from "../../infra/scheduler/runtime.ts";
import type { EventIdMemory } from "./replay-memory.ts";

export interface VerifiedInternalRequest {
  readonly eventId: string;
  readonly keyVersion: number;
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

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Verifies `X-Sym-*` signatures (§6.2): `INTERNAL_EVENT_SECRET_<n>` HMAC over timestamp, event id,
 * method, the request target and the SHA-256 of the raw body, inside ±300 seconds, then reserves the
 * event id in the 10-minute replay memory. Failures are logged by reason only.
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

  verify(request: IncomingMessage, body: Buffer, route: string): InternalVerification {
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
    if (!result.ok) return this.fail(route, result.reason);
    // The signature stays fresh while floor(now / 1000) is within the window of its timestamp.
    const freshUntilMs = (result.timestamp + INTERNAL_SIGNATURE_WINDOW_SECONDS + 1) * 1000;
    const reserved = this.options.memory.reserve(result.eventId, freshUntilMs);
    if (reserved === "replayed") return this.fail(route, "replayed");
    if (reserved === "full") return this.fail(route, "memory_full");
    const { memory } = this.options;
    const eventId = result.eventId;
    return {
      ok: true,
      request: { eventId, keyVersion: result.keyVersion, release: () => memory.release(eventId) },
    };
  }

  private fail(route: string, reason: InternalVerificationFailure): InternalVerification {
    this.options.log.warn("internal.request_rejected", { route, reason });
    return { ok: false, reason };
  }
}
