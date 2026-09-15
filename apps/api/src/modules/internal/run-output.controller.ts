import type { IncomingMessage } from "node:http";
import { Controller, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import {
  INTERNAL_BODY_LIMITS,
  INTERNAL_CONTENT_TYPE,
  type RunOutputBody,
  runOutputBodySchema,
} from "@symplist/core/events";
import type { OperationalLog } from "../../infra/scheduler/runtime.ts";
import { internalError } from "./internal-errors.ts";
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
 * status or generation failure returns `not_found`. Route class `signed`.
 */
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
    if (mediaType(request) !== INTERNAL_CONTENT_TYPE) throw internalError(400, "validation");
    const raw = await readRawBody(request, INTERNAL_BODY_LIMITS.runOutput);
    if (!raw.ok) {
      throw raw.reason === "too_large"
        ? internalError(413, "validation")
        : internalError(400, "validation");
    }
    const verification = this.verifier.verify(request, raw.body, "internal.run_output");
    if (!verification.ok) {
      throw verification.reason === "memory_full"
        ? internalError(503, "rate.limited", 5)
        : internalError(404, "not_found");
    }
    const verified = verification.request;

    let body: RunOutputBody;
    try {
      const parsed = runOutputBodySchema.safeParse(JSON.parse(raw.body.toString("utf8")));
      if (!parsed.success) throw new SyntaxError("invalid body");
      body = parsed.data;
    } catch {
      this.log.warn("internal.run_output_invalid", { eventId: verified.eventId });
      throw internalError(400, "validation");
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
            throw internalError(400, "validation");
          case "unavailable":
            verified.release();
            throw internalError(503, "rate.limited", 1);
          case "shutting_down":
            verified.release();
            throw internalError(503, "rate.limited", 5);
          default:
            throw internalError(404, "not_found");
        }
    }
  }
}
