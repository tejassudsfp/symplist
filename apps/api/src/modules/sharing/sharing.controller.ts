import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import {
  type HandoffRequest,
  handoffRequestSchema,
  idSchema,
  type SharingGrantRequest,
  type SharingSnapshotRequest,
  sharingGrantRequestSchema,
  sharingSnapshotRequestSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import {
  SharingError,
  type SharingFold,
  SharingGrants,
  SharingRepository,
} from "@symplist/core/sharing";
import { sql } from "@symplist/db";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import {
  type FoldedIdempotency,
  foldedIdempotencyOf,
} from "../../common/idempotency/idempotency.interceptor.ts";
import { Idempotent, OneTimeSecret } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";

export function sharingFold(idempotency: FoldedIdempotency): SharingFold {
  return {
    prefix: idempotency.statements,
    guard: { sql: idempotency.claim.guard.exists, params: idempotency.claim.guard.params },
    complete: (body, key, effect) => [
      idempotency.completionStatement({ status: 201, body }, key),
      // No success record survives a failed conditional effect (restriction, stale revision, etc.).
      sql(
        `DELETE FROM idempotency_records WHERE scope = :idem_scope AND user_id = :idem_user AND key = :idem_key AND write_id = :idem_write_id AND NOT ${effect.sql}`,
        { ...idempotency.claim.guard.params, ...effect.params },
      ),
    ],
    decide: (results, key) => {
      const decision = idempotency.decide(results, key);
      return decision.kind === "replay" ? { replay: decision.body } : null;
    },
  };
}
export async function sharingCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SharingError)
      throw new ApiError(
        error.code,
        error.code === "rate.limited" ? { details: { retryAfter: 900 } } : undefined,
      );
    throw error;
  }
}

@Controller()
@RouteClass("app")
export class SharingController {
  constructor(
    @Inject(SharingRepository) private readonly repo: SharingRepository,
    @Inject(SharingGrants) private readonly grants: SharingGrants,
  ) {}

  @Get("tasks/:taskId/artifacts")
  @Access("admitted")
  list(
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: idSchema }) taskId: string,
  ) {
    return sharingCall(() => this.repo.list({ kind: "user", userId: session.userId }, taskId));
  }
  @Post("tasks/:taskId/artifacts")
  @Access("admitted", { fresh: true })
  @Idempotent({ folded: true })
  snapshot(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: idSchema }) taskId: string,
    @Body({ schema: sharingSnapshotRequestSchema }) body: SharingSnapshotRequest,
  ) {
    const idempotency = foldedIdempotencyOf(req);
    return sharingCall(() =>
      this.repo.snapshot(
        { kind: "user", userId: session.userId },
        taskId,
        body,
        `snapshot:${taskId}:${idempotency.claim.key}`,
        sharingFold(idempotency),
      ),
    );
  }
  @Post("tasks/:taskId/handoffs")
  @Access("admitted", { fresh: true })
  @Idempotent({ folded: true })
  handoff(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: idSchema }) taskId: string,
    @Body({ schema: handoffRequestSchema }) body: HandoffRequest,
  ) {
    const idempotency = foldedIdempotencyOf(req);
    return sharingCall(() =>
      this.repo.snapshot(
        { kind: "user", userId: session.userId },
        taskId,
        { title: body.title, revision: body.revision, sectionIds: [] },
        `handoff:${taskId}:${idempotency.claim.key}`,
        sharingFold(idempotency),
        body,
      ),
    );
  }
  @Get("artifacts/:artifactId")
  @Access("admitted")
  preview(
    @CurrentSession() session: SessionContext,
    @Param("artifactId", { schema: idSchema }) artifactId: string,
  ) {
    return sharingCall(() => this.repo.preview(session.userId, artifactId));
  }
  @Post("artifacts/:artifactId/grants")
  @Access("admitted", { fresh: true })
  @OneTimeSecret(["url"], { folded: true })
  release(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("artifactId", { schema: idSchema }) artifactId: string,
    @Body({ schema: sharingGrantRequestSchema }) body: SharingGrantRequest,
  ) {
    return sharingCall(() =>
      this.grants.release(session.userId, artifactId, body, sharingFold(foldedIdempotencyOf(req))),
    );
  }
  @Post("artifacts/:artifactId/grants/:grantId/revoke")
  @Access("admitted", { fresh: true })
  @Idempotent({ folded: true })
  revoke(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("artifactId", { schema: idSchema }) artifactId: string,
    @Param("grantId", { schema: idSchema }) grantId: string,
  ) {
    return sharingCall(() =>
      this.grants.revoke(
        { kind: "user", userId: session.userId },
        artifactId,
        grantId,
        sharingFold(foldedIdempotencyOf(req)),
      ),
    );
  }
}
