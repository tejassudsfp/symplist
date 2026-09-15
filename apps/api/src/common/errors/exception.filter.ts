import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { RateLimitedError as CryptoRateLimitedError } from "@symplist/crypto";
import { DbRateLimitedError } from "@symplist/db";
import type { Request, Response } from "express";
import type { AppLogger } from "../logging/logger.ts";
import { matchedRoute, requestStateOf } from "../request-context.ts";
import { ApiError, sendApiError } from "./api-error.ts";
import { malformedRequestError } from "./validation.ts";

const stableCodePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

function httpErrorsStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, type } = error as { status?: unknown; type?: unknown };
  if (type === "entity.too.large" || status === 413) return 413;
  if (typeof type === "string" && type.startsWith("entity.") && status === 400) return 400;
  if (type === "encoding.unsupported" || type === "charset.unsupported") return 415;
  return undefined;
}

/**
 * Maps any thrown value to the §6 error envelope. `ApiError`s pass through; framework errors map to
 * stable codes (unknown routes to `not_found`, unparseable bodies to `validation`, budget and
 * semaphore refusals to `rate.limited`); everything else becomes `internal`. Failures are logged by
 * error name and stable code only (§6.3).
 */
export function toApiError(exception: unknown): ApiError {
  if (exception instanceof ApiError) return exception;
  if (exception instanceof DbRateLimitedError)
    return ApiError.rateLimited(exception.retryAfterSeconds);
  if (exception instanceof CryptoRateLimitedError)
    return ApiError.rateLimited(exception.retryAfter);
  if (exception instanceof ThrottlerException) return ApiError.rateLimited(1);
  const parserStatus = httpErrorsStatus(exception);
  if (parserStatus === 413) return new ApiError("request.too_large");
  if (parserStatus === 400 || parserStatus === 415) return malformedRequestError();
  if (exception instanceof BadRequestException) return malformedRequestError();
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404 || status === 405) return ApiError.notFound();
    if (status === 413) return new ApiError("request.too_large");
    if (status === 429) return ApiError.rateLimited(1);
  }
  return ApiError.internal();
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") throw exception;
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const state = requestStateOf(req);
    if (state && !state.route) state.route = matchedRoute(req);
    const error = toApiError(exception);

    if (error.status >= 500 && error.code !== "rate.limited") {
      const name = exception instanceof Error ? exception.name : typeof exception;
      const rawCode = (exception as { code?: unknown } | null)?.code;
      this.logger.error("http.unhandled_error", {
        errorName: name,
        errorCode:
          typeof rawCode === "string" && stableCodePattern.test(rawCode) ? rawCode : undefined,
      });
    }
    sendApiError(res, error, state?.requestId ?? "unknown");
  }
}
