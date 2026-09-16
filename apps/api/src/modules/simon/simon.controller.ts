import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import {
  conversationIdSchema,
  runIdSchema,
  simonConversationInputSchema,
  simonHistoryQuerySchema,
  simonMessageInputSchema,
  simonQuickSaveInputSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { SimonQuickChats, SimonRepository, SimonRetries, SimonViews } from "@symplist/core/simon";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { ExecutionDispatcher } from "../../infra/executors/dispatcher.ts";
import { simonCall, simonWriteFold } from "./simon.http.ts";

/** Cookie/Origin/CSRF-protected commands. No model, tool or agent dependency lives here. */
@Controller()
@RouteClass("app")
export class SimonController {
  constructor(
    @Inject(SimonRepository) private readonly repository: SimonRepository,
    @Inject(SimonQuickChats) private readonly quickChats: SimonQuickChats,
    @Inject(ExecutionDispatcher) private readonly dispatcher: ExecutionDispatcher,
    private readonly logger: AppLogger,
  ) {}

  @Get("conversations/:id")
  @Access("admitted")
  conversation(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: conversationIdSchema }) conversationId: string,
    @Query({ schema: simonHistoryQuerySchema }) query: typeof simonHistoryQuerySchema._output,
  ) {
    return simonCall(() =>
      new SimonViews(this.repository).conversation(session.userId, conversationId, query.beforeSeq),
    );
  }

  @Post("conversations")
  @Access("admitted")
  @Idempotent({ folded: true })
  create(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Body({ schema: simonConversationInputSchema })
    body: typeof simonConversationInputSchema._output,
  ) {
    return simonCall(async () => ({
      conversationId: await this.repository.createConversation(
        session.userId,
        body.kind === "task" ? body.taskId : null,
        simonWriteFold(req),
      ),
    }));
  }

  @Post("conversations/:id/messages")
  @HttpCode(202)
  @Access("admitted")
  @Idempotent({ folded: true })
  message(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: conversationIdSchema }) conversationId: string,
    @Body({ schema: simonMessageInputSchema }) body: typeof simonMessageInputSchema._output,
  ) {
    return simonCall(async () => {
      const fold = simonWriteFold(req);
      const accepted = await this.repository.acceptMessage(
        session.userId,
        conversationId,
        fold.claim.key,
        body,
        fold,
      );
      this.dispatcher.kick();
      return accepted;
    });
  }

  @Post("conversations/:id/save-as-task")
  @Access("admitted")
  @Idempotent({ folded: true })
  saveQuickChat(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: conversationIdSchema }) conversationId: string,
    @Body({ schema: simonQuickSaveInputSchema }) body: typeof simonQuickSaveInputSchema._output,
  ) {
    return simonCall(() =>
      this.quickChats.save(session.userId, conversationId, body, simonWriteFold(req)),
    );
  }

  @Get("runs/:id")
  @Access("admitted")
  run(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: runIdSchema }) runId: string,
  ) {
    return simonCall(async () => {
      const run = await this.repository.run(session.userId, runId);
      if (!run) throw ApiError.notFound();
      return {
        runId: run.id,
        conversationId: run.conversationId,
        taskId: run.taskId,
        status: run.status,
        tier: run.tier,
        stopRequested: run.cancelRequestedAt !== null,
      };
    });
  }

  @Post("runs/:id/stop")
  @HttpCode(200)
  @Access("admitted")
  @Idempotent({ folded: true })
  stop(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: runIdSchema }) runId: string,
  ) {
    return simonCall(async () => {
      await this.repository.stop(session.userId, runId, simonWriteFold(req));
      // Cancellation is safe to repeat. A provider outage cannot undo the committed stop flag;
      // the executor checks it between steps and reconciliation finishes stopped runs.
      try {
        await this.dispatcher.cancel("simon_run", runId);
      } catch {
        this.logger.warn("simon.cancel_pending");
      }
      this.dispatcher.kick();
      return { runId };
    });
  }

  @Post("runs/:id/retry")
  @HttpCode(202)
  @Access("admitted")
  @Idempotent({ folded: true })
  retry(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: runIdSchema }) runId: string,
  ) {
    return simonCall(async () => {
      const created = await new SimonRetries(this.repository).create(
        session.userId,
        runId,
        simonWriteFold(req),
      );
      this.dispatcher.kick();
      return created;
    });
  }
}
