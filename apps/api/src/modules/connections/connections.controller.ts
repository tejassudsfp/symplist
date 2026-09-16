import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  type ConnectionCallback,
  type ConnectionParams,
  type ConnectionStart,
  connectionCallbackSchema,
  connectionParamsSchema,
  connectionStartSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { IntegrationError } from "@symplist/integrations";
import type { Request, Response } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { foldedIdempotencyOf } from "../../common/idempotency/idempotency.interceptor.ts";
import { Idempotent, OneTimeSecret } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { CONNECTIONS_RUNTIME, type ConnectionsRuntime } from "./connections.runtime.ts";

function actor(session: SessionContext) {
  return { ownerId: session.userId, sessionId: session.sessionId };
}
async function answer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof IntegrationError)
      throw new ApiError(error.code, {
        ...(error.details.retryAfter ? { retryAfter: error.details.retryAfter } : {}),
      });
    throw error;
  }
}

@Controller("connections")
@RouteClass("app")
@Access("admitted")
export class ConnectionsController {
  constructor(
    @Inject(CONNECTIONS_RUNTIME) private readonly runtime: ConnectionsRuntime | null,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async list(@CurrentSession() session: SessionContext) {
    return {
      enabled: this.runtime?.enabled ?? false,
      connections: this.runtime
        ? await answer(() => this.required().service.list(actor(session)))
        : [],
    };
  }

  @Get("catalogue")
  async catalogue() {
    return {
      enabled: this.runtime?.enabled ?? false,
      items: this.runtime ? await answer(() => this.required().catalogue.list()) : [],
    };
  }

  @Post()
  @Access("admitted", { fresh: true })
  @OneTimeSecret(["url"], { folded: true })
  start(
    @CurrentSession() session: SessionContext,
    @Body({ schema: connectionStartSchema }) body: ConnectionStart,
    @Req() request: Request,
  ) {
    if (!this.runtime?.enabled) throw new ApiError("integration.unavailable");
    return answer(() =>
      this.required().service.start(actor(session), body, foldedIdempotencyOf(request)),
    );
  }

  @Delete(":id")
  @Access("admitted", { fresh: true })
  @Idempotent({ folded: true })
  disconnect(
    @CurrentSession() session: SessionContext,
    @Param({ schema: connectionParamsSchema }) params: ConnectionParams,
    @Req() request: Request,
  ) {
    return answer(() =>
      this.required().mutations.disconnect(actor(session), params.id, foldedIdempotencyOf(request)),
    );
  }

  @Get("callback")
  @RouteClass("connection_callback")
  @Access("admitted", { fresh: true })
  async callback(
    @CurrentSession() session: SessionContext,
    @Query({ schema: connectionCallbackSchema }) query: ConnectionCallback,
    @Res() response: Response,
  ) {
    let result = "cancelled";
    if (query.session_uri) {
      try {
        await this.required().service.callback(actor(session), {
          attemptId: query.attempt,
          nonce: query.n,
          sessionUri: query.session_uri,
        });
        result = "connected";
      } catch {
        result = "failed";
      }
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.redirect(303, `${this.config.WEB_ORIGIN}/settings/connections?result=${result}`);
  }

  private required(): ConnectionsRuntime {
    if (!this.runtime) throw new ApiError("integration.unavailable");
    return this.runtime;
  }
}
