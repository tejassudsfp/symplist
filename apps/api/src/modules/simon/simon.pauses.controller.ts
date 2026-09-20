import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { simonAnswerSchema, userAskIdSchema } from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { SimonRepository, SimonUserAsks } from "@symplist/core/simon";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { ExecutionDispatcher } from "../../infra/executors/dispatcher.ts";
import { simonCall, simonWriteFold } from "./simon.http.ts";

@Controller("user-asks")
@RouteClass("app")
export class SimonUserAsksController {
  private readonly asks: SimonUserAsks;
  constructor(
    @Inject(SimonRepository) repository: SimonRepository,
    @Inject(ExecutionDispatcher) private readonly dispatcher: ExecutionDispatcher,
  ) {
    this.asks = new SimonUserAsks(repository);
  }

  @Get(":id")
  @Access("admitted")
  get(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: userAskIdSchema }) askId: string,
  ) {
    return simonCall(() => this.asks.load(session.userId, askId));
  }

  @Post(":id/answer")
  @HttpCode(200)
  @Access("admitted")
  @Idempotent({ folded: true })
  answer(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: userAskIdSchema }) askId: string,
    @Body({ schema: simonAnswerSchema }) body: typeof simonAnswerSchema._output,
  ) {
    return this.decide(req, session, askId, { kind: "answer", text: body.text });
  }

  @Post(":id/dismiss")
  @HttpCode(200)
  @Access("admitted")
  @Idempotent({ folded: true })
  dismiss(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: userAskIdSchema }) askId: string,
  ) {
    return this.decide(req, session, askId, { kind: "dismiss" });
  }

  private decide(
    req: Request,
    session: SessionContext,
    askId: string,
    decision: { kind: "answer"; text: string } | { kind: "dismiss" },
  ) {
    return simonCall(async () => {
      const runId = await this.asks.decide(session.userId, askId, decision, simonWriteFold(req));
      this.dispatcher.kick();
      return { runId };
    });
  }
}
