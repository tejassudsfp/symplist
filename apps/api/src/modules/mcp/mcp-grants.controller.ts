import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from "@nestjs/common";
import {
  type ConnectionParams,
  connectionParamsSchema,
  type McpCreateKey,
  mcpCreateKeySchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { McpError, type McpGrants } from "@symplist/core/mcp";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { foldedIdempotencyOf } from "../../common/idempotency/idempotency.interceptor.ts";
import { Idempotent, OneTimeSecret } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";

export const MCP_GRANTS = "symplist:MCP_GRANTS";
export async function mcpAnswer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpError) throw new ApiError(error.code);
    throw error;
  }
}
function actor(session: SessionContext) {
  return { ownerId: session.userId, sessionId: session.sessionId };
}

@Controller("mcp/grants")
@RouteClass("app")
@Access("admitted")
export class McpGrantsController {
  constructor(
    @Inject(MCP_GRANTS) private readonly grants: McpGrants,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async list(@CurrentSession() session: SessionContext) {
    return {
      server: `${this.config.API_ORIGIN}/mcp`,
      grants: await mcpAnswer(() => this.grants.list(actor(session))),
    };
  }
  @Post()
  @Access("admitted", { fresh: true })
  @OneTimeSecret(["key"], { folded: true })
  create(
    @CurrentSession() session: SessionContext,
    @Body({ schema: mcpCreateKeySchema }) body: McpCreateKey,
    @Req() request: Request,
  ) {
    return mcpAnswer(() =>
      this.grants.createKey(actor(session), body, foldedIdempotencyOf(request)),
    );
  }
  @Delete(":id")
  @Access("admitted", { fresh: true })
  @Idempotent({ folded: true })
  revoke(
    @CurrentSession() session: SessionContext,
    @Param({ schema: connectionParamsSchema }) params: ConnectionParams,
    @Req() request: Request,
  ) {
    return mcpAnswer(() =>
      this.grants.revoke(actor(session), params.id, foldedIdempotencyOf(request)),
    );
  }
}
