import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  idSchema,
  isErrorCode,
  otpVerifyRequestSchema,
  type VaultGrantRequest,
  type VaultItemContent,
  vaultGrantRequestSchema,
  vaultItemContentSchema,
  vaultItemUpdateSchema,
  vaultListQuerySchema,
  vaultResetRequestSchema,
  vaultSetupRequestSchema,
  vaultUnlockRequestSchema,
  vaultVersionSchema,
} from "@symplist/contracts";
import { AccessFeatureError, type SessionContext } from "@symplist/core/access";
import {
  disposeOpenVault,
  VaultError,
  VaultGrants,
  VaultItems,
  VaultReset,
  VaultSessions,
} from "@symplist/core/vault";
import { RateLimitedError } from "@symplist/crypto";
import type { Request, Response } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { cookieNames } from "../../common/auth/session-cookies.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { foldedIdempotencyOf } from "../../common/idempotency/idempotency.interceptor.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { IpLimit } from "../../infra/limits/ip-limits.ts";

async function vaultCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof VaultError && isErrorCode(error.code))
      throw new ApiError(error.code, {
        ...(error.retryAfter ? { details: { retryAfter: error.retryAfter } } : {}),
      });
    if (error instanceof AccessFeatureError)
      throw new ApiError(error.code, error.details ? { details: { ...error.details } } : {});
    if (error instanceof RateLimitedError) throw ApiError.rateLimited(error.retryAfter);
    throw error;
  }
}
/** Cookie-only, fresh admitted access and the app Origin/CSRF matrix on every route. */
@Controller("vault")
@RouteClass("app")
@Access("admitted", { fresh: true })
export class VaultController {
  constructor(
    @Inject(VaultSessions) private readonly sessions: VaultSessions,
    @Inject(VaultItems) private readonly items: VaultItems,
    @Inject(VaultReset) private readonly resetService: VaultReset,
    @Inject(VaultGrants) private readonly grants: VaultGrants,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}
  private token(req: Request): string | undefined {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[
      cookieNames(this.config).vault
    ];
    return typeof value === "string" ? value : undefined;
  }
  private cookie(res: Response, token: string | null) {
    if (token)
      res.cookie(cookieNames(this.config).vault, token, {
        secure: this.config.NODE_ENV === "production",
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 3600000,
      });
  }
  private clear(res: Response) {
    res.clearCookie(cookieNames(this.config).vault, {
      secure: this.config.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  }
  @Get()
  status(@CurrentSession() session: SessionContext, @Req() req: Request) {
    return vaultCall(() => this.sessions.status(session, this.token(req)));
  }
  @Post("setup")
  @Idempotent({ folded: true })
  @HttpCode(200)
  @IpLimit("vault_unlock")
  setup(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: vaultSetupRequestSchema }) body: { passphrase: string; confirmation: string },
  ) {
    return vaultCall(async () => {
      const result = await this.sessions.setup(session, body.passphrase, foldedIdempotencyOf(req));
      this.cookie(res, result.token);
      return { status: result.status };
    });
  }
  @Post("unlock")
  @Idempotent({ folded: true })
  @HttpCode(200)
  @IpLimit("vault_unlock")
  unlock(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: vaultUnlockRequestSchema }) body: { passphrase: string },
  ) {
    return vaultCall(async () => {
      const result = await this.sessions.unlock(session, body.passphrase, foldedIdempotencyOf(req));
      this.cookie(res, result.token);
      return { status: result.status };
    });
  }
  @Post("lock")
  @HttpCode(200)
  lock(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return vaultCall(async () => {
      const result = await this.sessions.lock(session, this.token(req));
      this.clear(res);
      return result;
    });
  }
  @Post("touch")
  @HttpCode(200)
  touch(@CurrentSession() session: SessionContext, @Req() req: Request) {
    return vaultCall(async () => {
      const open = await this.sessions.open(session, this.token(req));
      try {
        return { idleExpiresAt: open.idleExpiresAt };
      } finally {
        disposeOpenVault(open);
      }
    });
  }
  @Get("items")
  list(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Query({ schema: vaultListQuerySchema }) query: { cursor?: string },
  ) {
    return vaultCall(() => this.items.list(session, this.token(req), query.cursor));
  }
  @Get("items/:id")
  read(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Param("id", { schema: idSchema }) id: string,
  ) {
    return vaultCall(() => this.items.read(session, this.token(req), id));
  }
  @Post("items")
  @Idempotent({ folded: true })
  create(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Body({ schema: vaultItemContentSchema }) body: VaultItemContent,
  ) {
    return vaultCall(() =>
      this.items.save(session, this.token(req), body, undefined, foldedIdempotencyOf(req)),
    );
  }
  @Put("items/:id")
  @Idempotent({ folded: true })
  update(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Param("id", { schema: idSchema }) id: string,
    @Body({ schema: vaultItemUpdateSchema }) body: VaultItemContent & { version: number },
  ) {
    const { version, ...content } = body;
    return vaultCall(() =>
      this.items.save(session, this.token(req), content, { id, version }, foldedIdempotencyOf(req)),
    );
  }
  @Delete("items/:id")
  @Idempotent({ folded: true })
  remove(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Param("id", { schema: idSchema }) id: string,
    @Body({ schema: vaultVersionSchema }) body: { version: number },
  ) {
    return vaultCall(() =>
      this.items.delete(session, this.token(req), id, body.version, foldedIdempotencyOf(req)),
    );
  }
  @Post("reset/otp")
  @IpLimit("otp_send")
  sendCode(@CurrentSession() session: SessionContext) {
    return vaultCall(() => this.resetService.sendCode(session));
  }
  @Post("reset/verify")
  @HttpCode(200)
  @IpLimit("otp_verify")
  verifyCode(
    @CurrentSession() session: SessionContext,
    @Body({ schema: otpVerifyRequestSchema }) body: { challengeId: string; code: string },
  ) {
    return vaultCall(() => this.resetService.verifyCode(session, body));
  }
  @Post("reset")
  @Idempotent({ folded: true })
  @HttpCode(200)
  @IpLimit("vault_unlock")
  reset(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: vaultResetRequestSchema }) body: {
      authorizationId: string;
      passphrase: string;
      confirmation: string;
    },
  ) {
    return vaultCall(async () => {
      const result = await this.resetService.reset(session, body, foldedIdempotencyOf(req));
      this.clear(res);
      return result;
    });
  }
  @Post("grants")
  @Idempotent({ folded: true })
  grant(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Body({ schema: vaultGrantRequestSchema }) body: VaultGrantRequest,
  ) {
    return vaultCall(() =>
      this.grants.create(session, this.token(req), body, foldedIdempotencyOf(req)),
    );
  }
  @Delete("grants/:id")
  @Idempotent({ folded: true })
  revoke(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Param("id", { schema: idSchema }) id: string,
  ) {
    return vaultCall(() =>
      this.grants.revoke(session, this.token(req), id, foldedIdempotencyOf(req)),
    );
  }
}
