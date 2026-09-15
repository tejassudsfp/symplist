import { Body, Controller, Inject, Module, Param, Post, Req, Res } from "@nestjs/common";
import type { SessionContext } from "@symplist/core/access";
import type { AccountKeyStore } from "@symplist/core/account";
import { zeroize } from "@symplist/crypto";
import { type DbClient, sql, uuidv7 } from "@symplist/db";
import type { Request, Response } from "express";
import { z } from "zod";
import { ACCOUNT_KEYS } from "../../src/common/access/access.providers.ts";
import { Access, CurrentSession } from "../../src/common/access.decorator.ts";
import { ApiError } from "../../src/common/errors/api-error.ts";
import {
  foldedIdempotencyOf,
  idempotencyContextOf,
} from "../../src/common/idempotency/idempotency.interceptor.ts";
import { Idempotent, OneTimeSecret } from "../../src/common/idempotent.decorator.ts";
import { RouteClass } from "../../src/common/route-classes.ts";
import { DB_CLIENT } from "../../src/infra/db/db.providers.ts";

/** Handler invocations and minted secrets recorded by the probe, reset by each test. */
export const idempotencyProbe = {
  effects: [] as string[],
  mintedSecrets: [] as string[],
  release: undefined as (() => void) | undefined,
  reset(): void {
    this.effects.length = 0;
    this.mintedSecrets.length = 0;
    this.release = undefined;
  },
};

/** A secret the leaky route repeats outside its declared field. */
export const leakedSecret = "sym_leak_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/** Idempotent routes: ordinary mutations, failures, slow handlers, one-time secrets and folding (§6.1). */
@Controller("idem")
@RouteClass("app")
export class IdempotencyProbeController {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(ACCOUNT_KEYS) private readonly keys: AccountKeyStore,
  ) {}

  @Post("tasks/:list")
  @Access("admitted")
  @Idempotent()
  create(
    @Param("list", { schema: z.enum(["now", "later"]) }) list: string,
    @Body({ schema: z.strictObject({ title: z.string().trim().min(1).max(100) }) })
    body: { title: string },
  ) {
    idempotencyProbe.effects.push(`create:${list}:${body.title}`);
    return { id: uuidv7(Date.now()), title: body.title, list };
  }

  @Post("raw")
  @Access("admitted")
  @Idempotent()
  raw(@Req() req: Request) {
    const { amount } = req.body as { amount: number };
    idempotencyProbe.effects.push(`raw:${amount}`);
    return { amount };
  }

  @Post("accepted")
  @Access("admitted")
  @Idempotent()
  accepted(@Res({ passthrough: true }) res: Response) {
    idempotencyProbe.effects.push("accepted");
    res.status(202);
    return { queued: true };
  }

  @Post("conflict")
  @Access("admitted")
  @Idempotent()
  conflict(@Body() body: { attempt: number }) {
    idempotencyProbe.effects.push(`conflict:${body.attempt}`);
    throw new ApiError("task.archived");
  }

  @Post("slow")
  @Access("admitted")
  @Idempotent()
  async slow() {
    idempotencyProbe.effects.push("slow");
    await new Promise<void>((resolve) => {
      idempotencyProbe.release = resolve;
    });
    return { done: true };
  }

  @Post("keys")
  @Access("admitted")
  @OneTimeSecret(["apiKey"])
  mint(@Body() body: { label: string }) {
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const apiKey = `sym_${uuidv7(Date.now()).replaceAll("-", "")}_${secret}`;
    idempotencyProbe.mintedSecrets.push(apiKey);
    idempotencyProbe.effects.push(`mint:${body.label}`);
    return {
      grantId: uuidv7(Date.now()),
      hint: apiKey.slice(-4),
      apiKey,
      secretUnavailable: false,
    };
  }

  @Post("leaky")
  @Access("admitted")
  @OneTimeSecret(["apiKey"])
  leaky() {
    return { apiKey: leakedSecret, echo: leakedSecret, secretUnavailable: false };
  }

  @Post("folded")
  @Access("admitted")
  @Idempotent()
  async folded(@Req() req: Request, @CurrentSession() session: SessionContext) {
    const idempotency = idempotencyContextOf(req);
    if (!idempotency) throw ApiError.internal();
    const accountKey = await this.keys.require(session.userId);
    const body = { folded: true };
    await this.db.batch([
      sql(
        `INSERT INTO probe_effects (label) SELECT 'folded' WHERE ${idempotency.claim.guard.exists}`,
        idempotency.claim.guard.params,
      ),
      idempotency.completionStatement({ status: 201, body }, accountKey),
    ]);
    idempotencyProbe.effects.push("folded");
    return body;
  }
}

/**
 * The worked example of `apps/api/src/common/idempotency/README.md`: an effectful mutation that folds
 * the idempotency claim, its effect and the recorded response into one D1 batch (§3.1, §6.1).
 */
@Controller("idem")
@RouteClass("app")
export class FoldedIdempotencyProbeController {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(ACCOUNT_KEYS) private readonly keys: AccountKeyStore,
  ) {}

  @Post("labels")
  @Access("admitted")
  @Idempotent({ folded: true })
  async addLabel(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Body({ schema: z.strictObject({ label: z.string().trim().min(1).max(40) }) })
    body: { label: string },
  ) {
    const idempotency = foldedIdempotencyOf(req);
    // The handler holds the owner's key anyway to encrypt its own fields; the response envelope uses it.
    const accountKey = await this.keys.require(session.userId);
    try {
      const response = { status: 201, body: { label: body.label } };
      const { exists, params } = idempotency.claim.guard;
      const results = await this.db.batch([
        // 1. The claim: insert the pending record, then read it back.
        ...idempotency.statements,
        // 2. The effect, applied only while this request's claim holds the key.
        sql(`INSERT INTO probe_effects (label) SELECT :label WHERE ${exists}`, {
          ...params,
          label: body.label,
        }),
        // 3. The recorded response, in the same transaction as the effect.
        idempotency.completionStatement(response, accountKey),
      ]);
      const decision = idempotency.decide(results, accountKey);
      if (decision.kind === "replay") return decision.body;
      idempotencyProbe.effects.push(`label:${body.label}`);
      return response.body;
    } finally {
      zeroize(accountKey.key);
    }
  }

  @Post("labels/forgotten")
  @Access("admitted")
  @Idempotent({ folded: true })
  async forgetsTheClaim(@Body() body: { label: string }) {
    idempotencyProbe.effects.push(`forgotten:${body.label}`);
    return { label: body.label };
  }

  @Post("labels/unfolded")
  @Access("admitted")
  @Idempotent()
  unfolded(@Req() req: Request) {
    return { folded: foldedIdempotencyOf(req) !== undefined };
  }
}

@Module({ controllers: [IdempotencyProbeController, FoldedIdempotencyProbeController] })
export class IdempotencyProbeModule {}
