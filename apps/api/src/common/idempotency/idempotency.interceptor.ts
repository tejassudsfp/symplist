import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants.js";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum.js";
import { Reflector } from "@nestjs/core";
import { idempotencyKeyHeader, idempotencyKeySchema } from "@symplist/contracts";
import {
  type IdempotencyClaim,
  IdempotencyStore,
  redactOneTimeSecretResponse,
  type StoredIdempotentResponse,
} from "@symplist/core/idempotency";
import type { AccountDataKey } from "@symplist/crypto";
import type { Statement } from "@symplist/db";
import type { Request, Response } from "express";
import { catchError, from, mergeMap, type Observable, of, throwError } from "rxjs";
import { CLOCK, type Clock } from "../clock.ts";
import { ApiError } from "../errors/api-error.ts";
import { validationExceptionFactory } from "../errors/validation.ts";
import { IDEMPOTENT_METADATA, type IdempotentRequirement } from "../idempotent.decorator.ts";
import { AppLogger } from "../logging/logger.ts";
import { matchedRoute, requestStateOf } from "../request-context.ts";

/** Response header set on replayed responses. */
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";

/** Injection token for the api's {@link IdempotencyStore}. */
export const IDEMPOTENCY_STORE = "symplist:IDEMPOTENCY_STORE";

interface RouteArgument {
  readonly index: number;
  readonly data?: unknown;
  readonly schema?: {
    readonly "~standard": {
      validate(value: unknown): unknown;
    };
  };
}

type StandardResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: Parameters<typeof validationExceptionFactory>[0] };

/** The claim a handler can fold into its own batch (§6.1). */
export interface IdempotencyContext {
  readonly claim: IdempotencyClaim;
  /**
   * The statement that records the response inside the mutation's batch, redacted for one-time
   * secrets. Once taken, the interceptor does not record the response again.
   */
  completionStatement(response: StoredIdempotentResponse, accountKey: AccountDataKey): Statement;
}

const contextKey = Symbol("symplist.idempotency");
type RequestWithIdempotency = Request & { [contextKey]?: IdempotencyContext & { folded: boolean } };

/** The idempotency claim of the current request, for handlers that fold its completion. */
export function idempotencyContextOf(req: Request): IdempotencyContext | undefined {
  return (req as RequestWithIdempotency)[contextKey];
}

function plainJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as unknown);
}

function argumentSource(req: Request, type: number, data: unknown): unknown {
  const pick = (source: unknown) =>
    typeof data === "string" && typeof source === "object" && source !== null
      ? (source as Record<string, unknown>)[data]
      : source;
  switch (type) {
    case RouteParamtypes.BODY:
      return pick(req.body);
    case RouteParamtypes.QUERY:
      return pick(req.query);
    case RouteParamtypes.PARAM:
      return pick(req.params);
    default:
      return undefined;
  }
}

/**
 * The validated input of a route, computed exactly as the Standard Schema pipe will: every `@Body`,
 * `@Query` and `@Param` argument with its schema applied. Arguments without a schema contribute their
 * raw value. Invalid input fails here with the same `validation` error the pipe would return.
 */
export async function validatedRouteInput(
  context: ExecutionContext,
  req: Request,
): Promise<unknown> {
  const args = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    context.getClass(),
    context.getHandler().name,
  ) ?? {}) as Record<string, RouteArgument>;
  const input: Record<string, unknown> = {};
  for (const [key, argument] of Object.entries(args)) {
    const type = Number(key.split(":")[0]);
    if (
      !Number.isInteger(type) ||
      ![RouteParamtypes.BODY, RouteParamtypes.QUERY, RouteParamtypes.PARAM].includes(type)
    ) {
      continue;
    }
    let value = argumentSource(req, type, argument.data);
    if (argument.schema) {
      const result = (await argument.schema["~standard"].validate(value)) as StandardResult;
      if (result.issues) throw validationExceptionFactory(result.issues);
      value = result.value;
    }
    const name = `${RouteParamtypes[type]}:${typeof argument.data === "string" ? argument.data : ""}`;
    input[name] = plainJson(value);
  }
  return input;
}

/**
 * The §6.1 Idempotency-Key interceptor for routes marked `@Idempotent()` or `@OneTimeSecret()`. It
 * fingerprints the validated input with `IDEMPOTENCY_SECRET`, claims the key before the handler
 * runs, replays the recorded response for an exact retry, returns `idempotency.mismatch` for another
 * input and `idempotency.in_progress` while the first request runs, and records the response as a
 * field envelope. One-time secret responses are recorded only in redacted form.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== "http") return next.handle();
    const requirement = this.reflector.get<IdempotentRequirement | undefined>(
      IDEMPOTENT_METADATA,
      context.getHandler(),
    );
    if (!requirement) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const state = requestStateOf(req);
    const session = state?.session;
    const route = state?.route ?? matchedRoute(req);
    if (!session || !route) throw ApiError.internal();

    const rawKey = req.headers[idempotencyKeyHeader.toLowerCase()];
    if (rawKey === undefined) throw new ApiError("idempotency.key_required");
    const parsedKey = idempotencyKeySchema.safeParse(rawKey);
    if (!parsedKey.success) throw new ApiError("idempotency.key_invalid");

    const input = await validatedRouteInput(context, req);
    const begin = await this.store.begin({
      scope: `${req.method.toUpperCase()} ${route}`,
      userId: session.userId,
      key: parsedKey.data,
      input,
      now: this.clock.now(),
    });

    switch (begin.kind) {
      case "replay":
        res.status(begin.response.status);
        res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, "true");
        return of(begin.response.body);
      case "mismatch":
        throw new ApiError("idempotency.mismatch");
      case "in_progress":
        throw new ApiError("idempotency.in_progress");
      case "started":
        return this.run(begin.claim, requirement, req, res, next);
    }
  }

  private run(
    claim: IdempotencyClaim,
    requirement: IdempotentRequirement,
    req: Request,
    res: Response,
    next: CallHandler,
  ): Observable<unknown> {
    const recorded = (body: unknown): unknown =>
      requirement.secretFields ? redactOneTimeSecretResponse(body, requirement.secretFields) : body;
    const idempotency: IdempotencyContext & { folded: boolean } = {
      claim,
      folded: false,
      completionStatement: (response, accountKey) => {
        idempotency.folded = true;
        return this.store.completeStatement({
          claim,
          response: { status: response.status, body: recorded(response.body) },
          accountKey,
          now: this.clock.now(),
        });
      },
    };
    (req as RequestWithIdempotency)[contextKey] = idempotency;

    return next.handle().pipe(
      mergeMap((body) =>
        from(
          (async () => {
            if (!idempotency.folded) {
              await this.store.complete({
                claim,
                response: { status: res.statusCode, body: recorded(body) },
                now: this.clock.now(),
              });
            }
            return body;
          })(),
        ),
      ),
      catchError((error: unknown) => {
        // A client error means the handler refused before any effect, so a retry may run again.
        // Anything else may have committed; the claim stays pending until its lease expires.
        if (error instanceof ApiError && error.status < 500 && !idempotency.folded) {
          return from(
            this.store.release(claim).catch((releaseError: unknown) => {
              this.logger.warn("idempotency.release_failed", { error: releaseError });
            }),
          ).pipe(mergeMap(() => throwError(() => error)));
        }
        return throwError(() => error);
      }),
    );
  }
}
