import type { IncomingMessage } from "node:http";
import { Controller, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  INTERNAL_BODY_LIMITS,
  INTERNAL_CONTENT_TYPE,
  type RunOutputBody,
  runOutputBodySchema,
} from "@symplist/core/events";
import { ApiError } from "../../common/errors/api-error.ts";
import { malformedRequestError } from "../../common/errors/validation.ts";
import { RouteClass } from "../../common/route-classes.ts";
import type { OperationalLog } from "../../infra/scheduler/runtime.ts";
import { INTERNAL_LOG } from "./internal-log.ts";
import { InternalRequestVerifier } from "./internal-request.verifier.ts";
import { mediaType, readRawBody } from "./raw-body.ts";
import { RunOutputRelay } from "./run-output.relay.ts";

interface StatusResponse {
  status(code: number): unknown;
}

/**
 * `POST /internal/v1/runs/:runId/output` (§8.2): signed, encrypted run output chunks relayed to the
 * run's conversation topic. 202 when relayed, 200 for a duplicate `(runId, seq)`; every ownership,
 * status or generation failure returns `not_found`. Replays are made harmless by that dedupe, not by
 * the event id replay memory: the worker re-signs each retry with a fresh event id, and a streaming
 * run would otherwise fill the memory internal events share. Route class `signed`; per-IP throttling
 * is skipped because each run pushes up to ten batches a second from shared Trigger egress addresses.
 */
@SkipThrottle()
@RouteClass("signed")
@Controller()
export class RunOutputController {
  constructor(
    @Inject(InternalRequestVerifier) private readonly verifier: InternalRequestVerifier,
    @Inject(RunOutputRelay) private readonly relay: RunOutputRelay,
    @Inject(INTERNAL_LOG) private readonly log: OperationalLog,
  ) {}

  @Post("internal/v1/runs/:runId/output")
  @HttpCode(202)
  async receive(
    @Req() request: IncomingMessage,
    @Param("runId") runId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<{ readonly status: "accepted" | "duplicate"; readonly relayed?: number }> {
    if (mediaType(request) !== INTERNAL_CONTENT_TYPE) throw malformedRequestError();
    const raw = await readRawBody(request, INTERNAL_BODY_LIMITS.runOutput);
    if (!raw.ok) {
      throw raw.reason === "too_large"
        ? new ApiError("request.too_large")
        : malformedRequestError();
    }
    const verification = this.verifier.verifySignature(request, raw.body, "internal.run_output");
    if (!verification.ok) throw ApiError.notFound();
    const verified = verification.request;

    let body: RunOutputBody;
    try {
      const parsed = runOutputBodySchema.safeParse(JSON.parse(raw.body.toString("utf8")));
      if (!parsed.success) throw new SyntaxError("invalid body");
      body = parsed.data;
    } catch {
      this.log.warn("internal.run_output_invalid", { eventId: verified.eventId });
      throw malformedRequestError();
    }

    const result = await this.relay.accept(runId, body);
    switch (result.status) {
      case "accepted":
        return { status: "accepted", relayed: result.relayed };
      case "duplicate":
        response.status(200);
        return { status: "duplicate" };
      case "rejected":
        switch (result.reason) {
          case "undecryptable":
          case "invalid_plaintext":
            throw malformedRequestError();
          case "unavailable":
            throw ApiError.rateLimited(1);
          case "shutting_down":
          case "capacity":
            throw ApiError.rateLimited(5);
          default:
            throw ApiError.notFound();
        }
    }
  }
}
