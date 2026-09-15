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
 * The stable code for a Nest `HttpException` thrown by framework or library code (a guard returning
 * false, `NotFoundException`, `PayloadTooLargeException`, …), or null for statuses without a safe
 * mapping, which stay `internal`. Contracts declare no 405, 415 or generic 403 code, so a wrong method
 * is an unknown route (`not_found`), an unsupported media type an unparseable request (`validation`),
 * and a bare refusal the generic `auth.csrf_invalid` ("the request could not be verified"); platform
 * guards throw their specific codes themselves. Rate limits are 503 `rate.limited` (decision C6.7).
 */
function httpExceptionError(exception: HttpException): ApiError | null {
  switch (exception.getStatus()) {
    case 400:
    case 415:
      return malformedRequestError();
    case 401:
      return new ApiError("auth.session_required");
    case 403:
      return new ApiError("auth.csrf_invalid");
    case 404:
    case 405:
      return ApiError.notFound();
    case 413:
      return new ApiError("request.too_large");
    case 429:
      return ApiError.rateLimited(1);
    default:
      return null;
  }
}

/**
 * Maps any thrown value to the §6 error envelope. `ApiError`s pass through; framework errors map to
 * stable codes (unknown routes to `not_found`, unparseable bodies to `validation`, budget and
 * semaphore refusals to `rate.limited`, Nest HTTP exceptions by status); everything else becomes
 * `internal`. Messages and bodies of framework exceptions are never copied. Failures are logged by
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
  if (exception instanceof HttpException)
    return httpExceptionError(exception) ?? ApiError.internal();
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
