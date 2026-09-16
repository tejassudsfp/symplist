import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { approvalIdSchema, simonApprovalDecisionSchema } from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { type ApprovalEditValidator, SimonApprovals, SimonRepository } from "@symplist/core/simon";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { ExecutionDispatcher } from "../../infra/executors/dispatcher.ts";
import { simonCall, simonWriteFold } from "./simon.http.ts";

/** Metadata/schema validation only: never a model or tool executor in the durable API. */
export const SIMON_APPROVAL_EDIT_VALIDATOR = Symbol("SIMON_APPROVAL_EDIT_VALIDATOR");
export type SimonApprovalEditValidatorFactory = (ownerId: string) => ApprovalEditValidator;

@Controller("approvals")
@RouteClass("app")
export class SimonApprovalsController {
  private readonly approvals: SimonApprovals;
  constructor(
    @Inject(SimonRepository) repository: SimonRepository,
    @Inject(ExecutionDispatcher) private readonly dispatcher: ExecutionDispatcher,
    @Optional()
    @Inject(SIMON_APPROVAL_EDIT_VALIDATOR)
    private readonly editValidator?: SimonApprovalEditValidatorFactory,
  ) {
    this.approvals = new SimonApprovals(repository);
  }

  @Get(":id")
  @Access("admitted")
  get(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: approvalIdSchema }) id: string,
  ) {
    return simonCall(() => this.approvals.load(session.userId, id));
  }

  @Post(":id/decision")
  @HttpCode(200)
  @Access("admitted", { fresh: true })
  @Idempotent({ folded: true })
  decide(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: approvalIdSchema }) id: string,
    @Body({ schema: simonApprovalDecisionSchema }) body: typeof simonApprovalDecisionSchema._output,
  ) {
    return simonCall(async () => {
      const result = await this.approvals.decide(
        session.userId,
        id,
        body,
        this.editValidator?.(session.userId),
        {
          ...simonWriteFold(req),
          authorization: {
            sql: `EXISTS (SELECT 1 FROM auth_sessions WHERE id = :simon_auth_session
              AND user_id = :simon_auth_owner AND revoked_at IS NULL)`,
            params: { simon_auth_session: session.sessionId, simon_auth_owner: session.userId },
          },
        },
      );
      if (result.status !== "pending") this.dispatcher.kick();
      return result;
    });
  }
}
