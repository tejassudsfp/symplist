import type { IncomingMessage } from "node:http";
import { Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  INTERNAL_BODY_LIMITS,
  INTERNAL_CONTENT_TYPE,
  type InternalEventBody,
  internalEventBodySchema,
} from "@symplist/core/events";
import { ApiError } from "../../common/errors/api-error.ts";
import { malformedRequestError } from "../../common/errors/validation.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { errorCode, type OperationalLog } from "../../infra/scheduler/runtime.ts";
import { InternalEventHandlerRegistry } from "./internal-event-handlers.ts";
import { INTERNAL_LOG } from "./internal-log.ts";
import { InternalRequestVerifier } from "./internal-request.verifier.ts";
import { mediaType, readRawBody } from "./raw-body.ts";

interface StatusResponse {
  status(code: number): unknown;
}

/**
 * `POST /internal/v1/events` (§6.2): worker announcements with ids-only payloads, dispatched to the
 * handler registered for their type. Route class `signed`: no cookies are read and no CORS applies.
 * Worker traffic arrives from shared Trigger egress addresses, so per-IP throttling is skipped; the
 * signature is the only gate (§5.3). Every verification failure answers the same `not_found`.
 *
 * A verified request's event id tells a retry what became of the earlier try: 202 when this request
 * took effect, 200 `duplicate` when an earlier request with the id did, and 409
 * `idempotency.in_progress` while an earlier request is still being handled (the worker stops waiting
 * after 2 seconds and retries the identical request). A handler failure, or a refusal before any
 * handler ran, forgets the id, so the next identical try is handled afresh.
 */
@SkipThrottle()
@RouteClass("signed")
@Controller()
export class InternalEventsController {
  constructor(
    @Inject(InternalRequestVerifier) private readonly verifier: InternalRequestVerifier,
    @Inject(InternalEventHandlerRegistry) private readonly handlers: InternalEventHandlerRegistry,
    @Inject(INTERNAL_LOG) private readonly log: OperationalLog,
  ) {}

  @Post("internal/v1/events")
  @HttpCode(202)
  async receive(
    @Req() request: IncomingMessage,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<{ readonly status: "accepted" | "duplicate" }> {
    if (mediaType(request) !== INTERNAL_CONTENT_TYPE) throw malformedRequestError();
    const raw = await readRawBody(request, INTERNAL_BODY_LIMITS.events);
    if (!raw.ok) {
      throw raw.reason === "too_large"
        ? new ApiError("request.too_large")
        : malformedRequestError();
    }
    const verification = this.verifier.verify(request, raw.body, "internal.events");
    if (!verification.ok) {
      switch (verification.reason) {
        case "replayed":
          response.status(200);
          return { status: "duplicate" };
        case "in_progress":
          throw new ApiError("idempotency.in_progress");
        case "memory_full":
          throw ApiError.rateLimited(5);
        default:
          throw ApiError.notFound();
      }
    }
    const verified = verification.request;

    // Refusals before any handler ran had no effect: the id is forgotten, so an identical retry gets
    // the same answer instead of `in_progress`.
    let parsed: ReturnType<typeof internalEventBodySchema.safeParse> | null;
    try {
      parsed = internalEventBodySchema.safeParse(JSON.parse(raw.body.toString("utf8")));
    } catch {
      parsed = null;
    }
    if (!parsed?.success || parsed.data.id !== verified.eventId) {
      verified.release();
      this.log.warn("internal.event_invalid", { eventId: verified.eventId });
      throw malformedRequestError();
    }
    const event: InternalEventBody = parsed.data;

    const handler = this.handlers.get(event.type);
    if (!handler) {
      verified.release();
      this.log.warn("internal.event_unhandled", { eventId: event.id, type: event.type });
      throw malformedRequestError();
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
      throw ApiError.internal();
    }
    verified.complete();
    this.log.info("internal.event_handled", {
      eventId: event.id,
      type: event.type,
      ownerId: event.ownerId,
      keyVersion: verified.keyVersion,
    });
    return { status: "accepted" };
  }
}
