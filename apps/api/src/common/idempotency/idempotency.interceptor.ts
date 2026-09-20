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
  type FoldedClaimDecision,
  type IdempotencyClaim,
  type IdempotencyRequest,
  IdempotencyStore,
  redactOneTimeSecretResponse,
  type StoredIdempotentResponse,
} from "@symplist/core/idempotency";
import type { AccountDataKey } from "@symplist/crypto";
import type { Statement, StatementResult } from "@symplist/db";
import type { Request, Response } from "express";
import { catchError, from, map, mergeMap, type Observable, of, throwError } from "rxjs";
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

/** What a folded claim decided for the handler. */
export type FoldedIdempotencyDecision =
  /** This request holds the key: its effect applied in the batch together with the record. */
  | { readonly kind: "started" }
  /**
   * An exact retry: nothing applied. Return `body`; the interceptor sends the recorded status and
   * body with `Idempotency-Replayed: true`.
   */
  | { readonly kind: "replay"; readonly body: unknown };

/**
 * The claim of a `@Idempotent({ folded: true })` route, folded into the handler's deciding D1 batch
 * (§3.1, §6.1): put `statements` first, guard every effect statement with `claim.guard.exists` and
 * its params, add `completionStatement`, then read the outcome with `decide`. D1 runs the batch as one
 * transaction, so the effect applies exactly once, together with the recorded response, in one
 * request. See `apps/api/src/common/idempotency/README.md`.
 */
export interface FoldedIdempotency {
  readonly claim: IdempotencyClaim;
  /** The claim insert and the record read, in this order, first in the batch. */
  readonly statements: readonly Statement[];
  /**
   * Records `response` for exact retries (redacted for a one-time secret endpoint), guarded by the
   * claim. The live response is sent with `response.status`.
   */
  completionStatement(response: StoredIdempotentResponse, accountKey: AccountDataKey): Statement;
  /**
   * The claim's decision from the batch results (`offset`: the index of the first claim statement).
   * Throws `idempotency.mismatch` for another input under the key and `idempotency.in_progress` for
   * a record whose outcome is not known yet. `accountKey` decrypts a replayed response; the caller
   * zeroises it afterwards.
   */
  decide(
    results: readonly StatementResult[],
    accountKey: AccountDataKey,
    offset?: number,
  ): FoldedIdempotencyDecision;
}

const contextKey = Symbol("symplist.idempotency");
const foldedKey = Symbol("symplist.idempotency.folded");
type RequestWithIdempotency = Request & {
  [contextKey]?: IdempotencyContext & { folded: boolean };
  [foldedKey]?: FoldedIdempotency;
};

/** The idempotency claim of the current request, for handlers that fold its completion. */
export function idempotencyContextOf(req: Request): IdempotencyContext | undefined {
  return (req as RequestWithIdempotency)[contextKey];
}

/**
 * The folded claim of the current request. Throws `internal` when the route is not declared
 * `@Idempotent({ folded: true })`, so a handler can never apply its effect without a claim.
 */
export function foldedIdempotencyOf(req: Request): FoldedIdempotency {
  const folded = (req as RequestWithIdempotency)[foldedKey];
  if (!folded) throw ApiError.internal();
  return folded;
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
 * raw value. A source the handler declares no argument for (for example a handler that reads
 * `req.body` through `@Req()`) contributes its raw value, so a retry with another body can never
 * replay the first response. Invalid input fails here with the same `validation` error the pipe
 * would return.
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
  const declared = new Set<number>();
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
    declared.add(type);
  }
  for (const type of [RouteParamtypes.BODY, RouteParamtypes.QUERY, RouteParamtypes.PARAM]) {
    if (!declared.has(type)) {
      input[`${RouteParamtypes[type]}:*raw`] = plainJson(
        argumentSource(req, type, undefined) ?? null,
      );
    }
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
    const request: IdempotencyRequest = {
      scope: `${req.method.toUpperCase()} ${route}`,
      userId: session.userId,
      key: parsedKey.data,
      input,
      now: this.clock.now(),
    };
    if (requirement.folded) return this.runFolded(request, requirement, req, res, next);
    const begin = await this.store.begin(request);

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

  /**
   * A folded route: no D1 request here. The handler's batch claims the key, applies the effect and
   * records the response; this only sends the decision's status and fails closed when the handler did
   * not fold the claim, since its effect would then have no record.
   */
  private runFolded(
    request: IdempotencyRequest,
    requirement: IdempotentRequirement,
    req: Request,
    res: Response,
    next: CallHandler,
  ): Observable<unknown> {
    const folded = this.store.foldedClaim(request);
    let decision: FoldedClaimDecision | null = null;
    let liveStatus: number | null = null;
    const context: FoldedIdempotency = {
      claim: folded.claim,
      statements: folded.statements,
      completionStatement: (response, accountKey) => {
        liveStatus = response.status;
        return this.store.completeStatement({
          claim: folded.claim,
          response: requirement.secretFields
            ? {
                status: 200,
                body: redactOneTimeSecretResponse(response.body, requirement.secretFields),
              }
            : response,
          accountKey,
          now: this.clock.now(),
        });
      },
      decide: (results, accountKey, offset = 0) => {
        decision = this.store.decideFoldedClaim({ request, folded, results, accountKey, offset });
        switch (decision.kind) {
          case "started":
            return { kind: "started" };
          case "replay":
            return { kind: "replay", body: decision.response.body };
          case "mismatch":
            throw new ApiError("idempotency.mismatch");
          case "in_progress":
            throw new ApiError("idempotency.in_progress");
        }
      },
    };
    (req as RequestWithIdempotency)[foldedKey] = context;

    return next.handle().pipe(
      map((body) => {
        const decided = decision as FoldedClaimDecision | null;
        if (decided?.kind === "replay") {
          res.status(decided.response.status);
          res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, "true");
          return decided.response.body;
        }
        if (decided?.kind !== "started" || liveStatus === null) {
          this.logger.error("idempotency.fold_incomplete");
          throw ApiError.internal();
        }
        res.status(liveStatus);
        return body;
      }),
    );
  }

  private run(
    claim: IdempotencyClaim,
    requirement: IdempotentRequirement,
    req: Request,
    res: Response,
    next: CallHandler,
  ): Observable<unknown> {
    // A one-time secret endpoint records only its redacted outcome, which an exact retry receives
    // with status 200 (§6.1); other endpoints record the status and body they sent.
    const recorded = (status: number, body: unknown): StoredIdempotentResponse =>
      requirement.secretFields
        ? { status: 200, body: redactOneTimeSecretResponse(body, requirement.secretFields) }
        : { status, body };
    const idempotency: IdempotencyContext & { folded: boolean } = {
      claim,
      folded: false,
      completionStatement: (response, accountKey) => {
        idempotency.folded = true;
        return this.store.completeStatement({
          claim,
          response: recorded(response.status, response.body),
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
                response: recorded(res.statusCode, body),
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
