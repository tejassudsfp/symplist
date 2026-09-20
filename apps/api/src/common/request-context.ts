import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { requestIdHeader } from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { uuidv7 } from "@symplist/db";
import type { NextFunction, Request, Response } from "express";
import { Observable } from "rxjs";
import type { RouteClass } from "./route-classes.ts";

/** Per-request state: identifiers for logs and envelopes, and the authenticated session (§6, §6.3). */
export interface RequestState {
  readonly requestId: string;
  readonly startedAt: number;
  /** The matched route template, for example `/v1/tasks/:id`; null until routing matched. */
  route: string | null;
  routeClass: RouteClass | null;
  /** Set by the access guard once the session cookie resolved. */
  session: SessionContext | null;
}

const stateKey = Symbol("symplist.request-state");

type StatefulRequest = Request & { [stateKey]?: RequestState };

const storage = new AsyncLocalStorage<RequestState>();

/** Creates and attaches the state of a request. */
export function attachRequestState(req: Request, now: number = Date.now()): RequestState {
  const state: RequestState = {
    requestId: uuidv7(now),
    startedAt: performance.now(),
    route: null,
    routeClass: null,
    session: null,
  };
  (req as StatefulRequest)[stateKey] = state;
  return state;
}

/** The state of a request that passed the request context middleware. */
export function requestStateOf(req: Request): RequestState | undefined {
  return (req as StatefulRequest)[stateKey];
}

/** The state of the request being handled on this async path, if any. */
export function currentRequestState(): RequestState | undefined {
  return storage.getStore();
}

/** Runs `work` with `state` as the current request state. */
export function runWithRequestState<T>(state: RequestState, work: () => T): T {
  return storage.run(state, work);
}

/** The route template Express matched, when routing has matched. */
export function matchedRoute(req: Request): string | null {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : null;
}

/**
 * First middleware after helmet: assigns the request id, echoes it as `X-Request-Id`, and makes the
 * state current for the rest of the synchronous middleware chain.
 */
export function requestContextMiddleware(now: () => number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const state = attachRequestState(req, now());
    res.setHeader(requestIdHeader, state.requestId);
    runWithRequestState(state, next);
  };
}

/**
 * Re-enters the request state around the handler. Body parsing resumes the middleware chain from
 * stream callbacks, which lose the async context, so handlers and the services they call get it back
 * here.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const state = requestStateOf(context.switchToHttp().getRequest<Request>());
    if (!state) return next.handle();
    return new Observable((subscriber) =>
      runWithRequestState(state, () => next.handle().subscribe(subscriber)),
    );
  }
}
