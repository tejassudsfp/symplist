import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  MethodNotAllowedException,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { errorEnvelopeSchema, rateLimitedErrorSchema } from "@symplist/contracts";
import { RateLimitedError } from "@symplist/crypto";
import { DbRateLimitedError, DbUnknownOutcomeError } from "@symplist/db";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api-error.ts";
import { toApiError } from "./exception.filter.ts";

describe("error envelope mapping (§6)", () => {
  it("maps framework, budget and unknown failures to stable codes", () => {
    expect(toApiError(new NotFoundException("Cannot GET /v1/secret-path")).code).toBe("not_found");
    expect(toApiError(new HttpException("method", 405)).code).toBe("not_found");
    expect(toApiError(new BadRequestException("Unexpected token")).code).toBe("validation");
    expect(
      toApiError(Object.assign(new Error("too big"), { type: "entity.too.large", status: 413 }))
        .code,
    ).toBe("request.too_large");
    expect(
      toApiError(Object.assign(new Error("bad"), { type: "entity.parse.failed", status: 400 }))
        .code,
    ).toBe("validation");
    expect(toApiError(new ThrottlerException()).code).toBe("rate.limited");
    expect(toApiError(new DbRateLimitedError("circuit_open", 300_000))).toMatchObject({
      code: "rate.limited",
      retryAfter: 300,
      status: 503,
    });
    expect(toApiError(new RateLimitedError(1))).toMatchObject({
      code: "rate.limited",
      retryAfter: 1,
    });
    expect(toApiError(new DbUnknownOutcomeError("timeout")).code).toBe("internal");
    expect(toApiError(new Error("boom")).code).toBe("internal");
    expect(toApiError("thrown string").code).toBe("internal");
  });

  it("maps Nest HTTP exceptions by status to stable codes instead of internal", () => {
    const cases: Array<[HttpException, string, number]> = [
      [new BadRequestException("Unexpected token in JSON"), "validation", 400],
      [new HttpException({ error: "custom body" }, 400), "validation", 400],
      [
        new UnauthorizedException("Token expired for maya@example.test"),
        "auth.session_required",
        401,
      ],
      [new ForbiddenException("Forbidden resource"), "auth.csrf_invalid", 403],
      [new NotFoundException("Cannot POST /internal/v1/nope"), "not_found", 404],
      [new MethodNotAllowedException(), "not_found", 404],
      [new PayloadTooLargeException("request entity too large"), "request.too_large", 413],
      [new UnsupportedMediaTypeException("text/xml"), "validation", 400],
      [new HttpException("Too Many Requests", 429), "rate.limited", 503],
    ];
    for (const [exception, code, status] of cases) {
      const mapped = toApiError(exception);
      expect([mapped.code, mapped.status], exception.name).toEqual([code, status]);
      const envelope = JSON.stringify(mapped.toEnvelope("req-1"));
      expect(envelope).not.toContain("maya@example.test");
      expect(envelope).not.toContain("custom body");
      expect(envelope).not.toContain("/internal/v1/nope");
    }
    expect(toApiError(new HttpException("Too Many Requests", 429)).retryAfter).toBe(1);
    // Statuses without a safe mapping stay internal.
    expect(toApiError(new ConflictException("conflict")).code).toBe("internal");
    expect(toApiError(new InternalServerErrorException("boom")).code).toBe("internal");
    expect(toApiError(new HttpException("unavailable", 503)).code).toBe("internal");
  });

  it("gives unknown and unauthorized resources the identical not_found body", () => {
    const unknown = ApiError.notFound().toEnvelope("req-1");
    const foreign = toApiError(
      new NotFoundException("Task 0190-foreign belongs to another user"),
    ).toEnvelope("req-1");
    expect(foreign).toEqual(unknown);
    expect(JSON.stringify(foreign)).not.toContain("foreign");
    expect(errorEnvelopeSchema.parse(unknown)).toEqual({
      error: { code: "not_found", message: "Not found", requestId: "req-1" },
    });
  });

  it("builds rate.limited envelopes with retryAfter in whole seconds", () => {
    const envelope = ApiError.rateLimited(2.2).toEnvelope("r");
    expect(rateLimitedErrorSchema.parse(envelope).error.details.retryAfter).toBe(3);
    expect(ApiError.rateLimited(0).retryAfter).toBe(1);
    expect(ApiError.rateLimited(10 ** 9).retryAfter).toBe(86_400);
  });

  it("refuses undeclared codes", () => {
    expect(() => new ApiError("not.declared" as never)).toThrow(TypeError);
  });
});
