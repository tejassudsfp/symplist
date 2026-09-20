import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { AccessFeatureError } from "@symplist/core/access";
import { catchError, type Observable, throwError } from "rxjs";
import { ApiError } from "../../common/errors/api-error.ts";

/** Maps a refusal from an access feature service to the §6 envelope. */
export function toAccessApiError(error: unknown): unknown {
  if (!(error instanceof AccessFeatureError)) return error;
  const details = error.details ? { ...error.details } : undefined;
  const retryAfter = typeof details?.retryAfter === "number" ? details.retryAfter : undefined;
  if (error.code === "rate.limited") return ApiError.rateLimited(retryAfter ?? 1);
  return new ApiError(error.code, details ? { details } : {});
}

/**
 * Converts `AccessFeatureError`s thrown by the access services into `ApiError`s inside the
 * controller, before the idempotency interceptor sees them, so a client error releases its claim.
 */
@Injectable()
export class AccessErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(catchError((error: unknown) => throwError(() => toAccessApiError(error))));
  }
}
