import type { IncomingMessage } from "node:http";
import { Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  INTERNAL_BODY_LIMITS,
  INTERNAL_CONTENT_TYPE,
  type InternalEventBody,
  internalEventBodySchema,
} from "@symplist/core/events";
import { errorCode, type OperationalLog } from "../../infra/scheduler/runtime.ts";
import { internalError } from "./internal-errors.ts";
import { InternalEventHandlerRegistry } from "./internal-event-handlers.ts";
import { INTERNAL_LOG } from "./internal-log.ts";
import { InternalRequestVerifier } from "./internal-request.verifier.ts";
import { mediaType, readRawBody } from "./raw-body.ts";

/**
 * `POST /internal/v1/events` (§6.2): worker announcements with ids-only payloads, dispatched to the
 * handler registered for their type. Route class `signed`: no cookies are read and no CORS applies.
 * Worker traffic arrives from shared Trigger egress addresses, so per-IP throttling is skipped; the
 * signature is the only gate (§5.3).
 */
@SkipThrottle()
@Controller()
export class InternalEventsController {
  constructor(
    @Inject(InternalRequestVerifier) private readonly verifier: InternalRequestVerifier,
    @Inject(InternalEventHandlerRegistry) private readonly handlers: InternalEventHandlerRegistry,
    @Inject(INTERNAL_LOG) private readonly log: OperationalLog,
  ) {}

  @Post("internal/v1/events")
  @HttpCode(202)
  async receive(@Req() request: IncomingMessage): Promise<{ readonly status: "accepted" }> {
    if (mediaType(request) !== INTERNAL_CONTENT_TYPE) throw internalError(400, "validation");
    const raw = await readRawBody(request, INTERNAL_BODY_LIMITS.events);
    if (!raw.ok) {
      throw raw.reason === "too_large"
        ? internalError(413, "validation")
        : internalError(400, "validation");
    }
    const verification = this.verifier.verify(request, raw.body, "internal.events");
    if (!verification.ok) {
      throw verification.reason === "memory_full"
        ? internalError(503, "rate.limited", 5)
        : internalError(404, "not_found");
    }
    const verified = verification.request;

    let event: InternalEventBody;
    try {
      const parsed = internalEventBodySchema.safeParse(JSON.parse(raw.body.toString("utf8")));
      if (!parsed.success || parsed.data.id !== verified.eventId) {
        this.log.warn("internal.event_invalid", { eventId: verified.eventId });
        throw internalError(400, "validation");
      }
      event = parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.log.warn("internal.event_invalid", { eventId: verified.eventId });
        throw internalError(400, "validation");
      }
      throw error;
    }

    const handler = this.handlers.get(event.type);
    if (!handler) {
      this.log.warn("internal.event_unhandled", { eventId: event.id, type: event.type });
      throw internalError(400, "validation");
    }
    try {
      await handler.handle(event);
    } catch (error) {
      verified.release();
      this.log.error("internal.event_handler_failed", {
        eventId: event.id,
        type: event.type,
        code: errorCode(error),
      });
      throw internalError(500, "internal");
    }
    this.log.info("internal.event_handled", {
      eventId: event.id,
      type: event.type,
      ownerId: event.ownerId,
      keyVersion: verified.keyVersion,
    });
    return { status: "accepted" };
  }
}
