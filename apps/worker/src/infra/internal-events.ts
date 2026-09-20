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

/**
 * `delivered`: the api handled the event (now or on an earlier try). `rejected`: the api refused it.
 * `unconfirmed`: the api was still handling an earlier try when the retries ran out, so the event may
 * or may not take effect. `dropped`: the api could not be reached.
 */
export type AnnounceOutcome = "delivered" | "rejected" | "unconfirmed" | "dropped";

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
 * the api's event-id replay memory makes delivery at most once, and its answer to a retry says what
 * became of the earlier try: 200 when it took effect (delivered), 409 while its handler is still
 * running (retry later: the handler may still fail, which makes the api forget the id and handle the
 * next try afresh). Any other 4xx is a rejection, on every try.
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
    let inProgress = false;
    for (let tryNumber = 1; tryNumber <= maxAttempts; tryNumber += 1) {
      const remaining = deadline - this.timers.now();
      if (remaining <= 0) break;
      const result = await deliver(
        this.fetchImpl,
        request,
        this.timers,
        Math.min(remaining, 2_000),
      );
      if (result.outcome === "delivered") return "delivered";
      if (result.outcome === "duplicate") {
        // An earlier try reached the api and took effect, but its response was lost.
        this.options.logger.info("internal_event.delivered_on_retry", {
          eventId: event.id,
          kind: event.type,
          tryCount: tryNumber,
        });
        return "delivered";
      }
      if (result.outcome === "in_progress") inProgress = true;
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
    if (inProgress) {
      this.options.logger.warn("internal_event.unconfirmed", {
        eventId: event.id,
        kind: event.type,
      });
      return "unconfirmed";
    }
    this.options.logger.warn("internal_event.dropped", { eventId: event.id, kind: event.type });
    return "dropped";
  }
}
