import {
  INTERNAL_EVENTS_PATH,
  type InternalEventBody,
  type InternalEventPayload,
  internalEventBodySchema,
} from "@symplist/core/events";
import type { KeyProvider } from "@symplist/crypto";
import { uuidv7 } from "@symplist/db";
import { WorkerError } from "./errors.ts";
import type { WorkerLogger } from "./logger.ts";
import { deliver, signedApiRequest, type WorkerFetch } from "./signed-request.ts";
import { sleep, systemWorkerTimers, type WorkerTimers } from "./timers.ts";

export type AnnounceOutcome = "delivered" | "rejected" | "dropped";

export interface InternalEventClientOptions {
  readonly keys: KeyProvider;
  readonly apiOrigin: string;
  readonly logger: WorkerLogger;
  readonly fetch?: WorkerFetch;
  readonly timers?: WorkerTimers;
  readonly maxAttempts?: number;
  readonly retryWindowMs?: number;
}

/**
 * Announces worker-originated changes to the api on `/internal/v1/events` (§6.2, §7): ids, enums,
 * counts and envelopes only, validated before signing. A retry resends the identical signed request, so
 * the api's event-id replay memory makes delivery at most once; a 404 after a lost response means the
 * first delivery already took effect.
 */
export class InternalEventClient {
  private readonly timers: WorkerTimers;
  private readonly fetchImpl: WorkerFetch;

  constructor(private readonly options: InternalEventClientOptions) {
    this.timers = options.timers ?? systemWorkerTimers;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async announce(input: {
    readonly type: string;
    readonly ownerId: string;
    readonly payload: InternalEventPayload;
  }): Promise<AnnounceOutcome> {
    const event: InternalEventBody = {
      id: uuidv7(this.timers.now()),
      type: input.type,
      ownerId: input.ownerId,
      occurredAt: this.timers.now(),
      payload: input.payload,
    };
    if (!internalEventBodySchema.safeParse(event).success) {
      throw new WorkerError("internal_event.invalid");
    }
    const body = new TextEncoder().encode(JSON.stringify(event));
    const request = signedApiRequest({
      apiOrigin: this.options.apiOrigin,
      path: INTERNAL_EVENTS_PATH,
      body,
      keys: this.options.keys,
      timers: this.timers,
      eventId: event.id,
    });
    const maxAttempts = this.options.maxAttempts ?? 3;
    const deadline = this.timers.now() + (this.options.retryWindowMs ?? 5_000);
    for (let tryNumber = 1; tryNumber <= maxAttempts; tryNumber += 1) {
      const remaining = deadline - this.timers.now();
      if (remaining <= 0) break;
      const result = await deliver(
        this.fetchImpl,
        request,
        this.timers,
        Math.min(remaining, 2_000),
      );
      if (result.outcome === "delivered" || result.outcome === "duplicate") return "delivered";
      if (result.outcome === "rejected") {
        this.options.logger.warn("internal_event.rejected", {
          eventId: event.id,
          kind: event.type,
          httpStatus: result.status,
          tryCount: tryNumber,
        });
        return "rejected";
      }
      if (tryNumber < maxAttempts) {
        const wait = Math.min(250 * 3 ** (tryNumber - 1), deadline - this.timers.now());
        if (wait > 0) await sleep(this.timers, wait);
      }
    }
    this.options.logger.warn("internal_event.dropped", { eventId: event.id, kind: event.type });
    return "dropped";
  }
}
