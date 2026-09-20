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
} from "@nestjs/common";
import {
  type DocumentCompareResponse,
  type DocumentConflictResponse,
  type DocumentHeadResponse,
  type DocumentHistoryResponse,
  type DocumentPublishResponse,
  type DocumentRevisionResponse,
  documentCompareQuerySchema,
  documentConflictQuerySchema,
  documentDraftDeleteQuerySchema,
  documentDraftPutRequestSchema,
  documentHistoryQuerySchema,
  documentRestoreRequestSchema,
  documentRevisionSchema,
  documentSaveRequestSchema,
  taskIdSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { DocumentService, type PublishResult } from "@symplist/core/documents";
import { sql } from "@symplist/db";
import type { PublicationFold } from "@symplist/docs";
import type { Request } from "express";
import type { z } from "zod";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import {
  type FoldedIdempotency,
  foldedIdempotencyOf,
} from "../../common/idempotency/idempotency.interceptor.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { documentCall } from "./documents.errors.ts";

function publishResponse(result: PublishResult): DocumentPublishResponse {
  return {
    taskId: result.taskId as DocumentPublishResponse["taskId"],
    status: result.status,
    revision: result.revision,
    generation: result.generation,
    changedSectionIds: [...result.changedSectionIds],
    restoredFrom: result.restoredFrom,
  };
}

/**
 * Folds the route's idempotency claim into the publication batch (§6.1, §9.2): the claim first, its
 * guard on the head update, the recorded response after the effect, and the record removed again in
 * the same batch when the publication lost its race, so a conflict never replays as a success.
 */
export function publicationFold(idempotency: FoldedIdempotency, taskId: string): PublicationFold {
  return {
    prefix: idempotency.statements,
    guard: { sql: idempotency.claim.guard.exists, params: idempotency.claim.guard.params },
    suffix: ({ outcome, headGuard, accountKey }) => {
      const result: PublishResult =
        outcome.status === "unchanged"
          ? {
              taskId,
              status: "unchanged",
              revision: outcome.commitId,
              generation: outcome.generation,
              changedSectionIds: [],
              restoredFrom: null,
            }
          : {
              taskId,
              status: "published",
              revision: outcome.document.commitId,
              generation: outcome.document.generation,
              changedSectionIds: [...outcome.document.changedSectionIds],
              restoredFrom: outcome.document.restoredFrom,
            };
      const statements = [
        idempotency.completionStatement(
          { status: result.status === "published" ? 201 : 200, body: publishResponse(result) },
          accountKey,
        ),
      ];
      if (headGuard) {
        statements.push(
          sql(
            `DELETE FROM idempotency_records
             WHERE scope = :idem_scope AND user_id = :idem_user AND key = :idem_key
               AND write_id = :idem_write_id AND NOT ${headGuard.sql}`,
            { ...idempotency.claim.guard.params, ...headGuard.params },
          ),
        );
      }
      return statements;
    },
    inspect: (results, accountKey) => {
      const decision = idempotency.decide(results, accountKey, 0);
      return decision.kind === "replay" ? { replay: decision.body } : null;
    },
  };
}

/**
 * The owner's task page API (§9.2, §9.3, document_history brief): the published head with the draft,
 * saves with an expected base and Idempotency-Key, drafts, history, revision previews, compare,
 * restore and conflict review. Every route is `app` class and requires admitted access; the service
 * re-checks ownership, access and the active task in its own D1 batch.
 */
@Controller("tasks/:taskId/document")
@RouteClass("app")
export class DocumentsController {
  constructor(@Inject(DocumentService) private readonly documents: DocumentService) {}

  @Get()
  @Access("admitted")
  getHead(
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
  ): Promise<DocumentHeadResponse> {
    return documentCall(async () => {
      const head = await this.documents.getHead({ kind: "user", userId: session.userId }, taskId);
      return {
        ...head,
        taskId: head.taskId as DocumentHeadResponse["taskId"],
        sections: [...head.sections],
        draft: head.draft ? { ...head.draft } : null,
      };
    });
  }

  @Post("commits")
  @Access("admitted")
  @Idempotent({ folded: true })
  save(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
    @Body({ schema: documentSaveRequestSchema }) body: z.output<typeof documentSaveRequestSchema>,
  ): Promise<unknown> {
    const idempotency = foldedIdempotencyOf(req);
    return documentCall(async () => {
      const outcome = await this.documents.save(
        { kind: "user", userId: session.userId },
        {
          taskId,
          baseRevision: body.baseRevision,
          markdown: body.markdown,
          kind: body.kind,
          ...(body.draftSeq === undefined ? {} : { draftSeq: body.draftSeq }),
        },
        { id: idempotency.claim.key, fold: publicationFold(idempotency, taskId) },
      );
      return outcome.kind === "replay" ? outcome.body : publishResponse(outcome.result);
    });
  }

  @Put("draft")
  @Access("admitted")
  putDraft(
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
    @Body({ schema: documentDraftPutRequestSchema }) body: z.output<
      typeof documentDraftPutRequestSchema
    >,
  ) {
    return documentCall(() =>
      this.documents.putDraft({ kind: "user", userId: session.userId }, { taskId, ...body }),
    );
  }

  @Delete("draft")
  @Access("admitted")
  @HttpCode(204)
  deleteDraft(
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
    @Query({ schema: documentDraftDeleteQuerySchema }) query: z.output<
      typeof documentDraftDeleteQuerySchema
    >,
  ): Promise<void> {
    return documentCall(() =>
      this.documents.deleteDraft({ kind: "user", userId: session.userId }, taskId, query.clientSeq),
    );
  }

  @Get("history")
  @Access("admitted")
  history(
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
    @Query({ schema: documentHistoryQuerySchema }) query: z.output<
      typeof documentHistoryQuerySchema
    >,
  ): Promise<DocumentHistoryResponse> {
    return documentCall(async () => {
      const page = await this.documents.history(
        { kind: "user", userId: session.userId },
        {
          taskId,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit ? { limit: query.limit } : {}),
        },
      );
      return {
        taskId: taskId as DocumentHistoryResponse["taskId"],
        headRevision: page.headRevision,
        items: [...page.items],
        nextCursor: page.nextCursor,
      };
    });
  }

  @Get("revisions/:revision")
  @Access("admitted")
  getRevision(
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
    @Param("revision", { schema: documentRevisionSchema }) revision: string,
  ): Promise<DocumentRevisionResponse> {
    return documentCall(async () => {
      const preview = await this.documents.getRevision(
        { kind: "user", userId: session.userId },
        taskId,
        revision,
      );
      return {
        ...preview,
        taskId: taskId as DocumentRevisionResponse["taskId"],
        sections: [...preview.sections],
      };
    });
  }

  @Get("compare")
  @Access("admitted")
  compare(
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
    @Query({ schema: documentCompareQuerySchema }) query: z.output<
      typeof documentCompareQuerySchema
    >,
  ): Promise<DocumentCompareResponse> {
    return documentCall(async () => {
      const result = await this.documents.compare(
        { kind: "user", userId: session.userId },
        {
          taskId,
          base: query.base,
          ...(query.target ? { target: query.target } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        },
      );
      return {
        ...result,
        taskId: taskId as DocumentCompareResponse["taskId"],
        hunks: result.hunks.map((hunk) => ({ ...hunk, lines: [...hunk.lines] })),
      };
    });
  }

  @Post("restore")
  @Access("admitted")
  @Idempotent({ folded: true })
  restore(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
    @Body({ schema: documentRestoreRequestSchema }) body: z.output<
      typeof documentRestoreRequestSchema
    >,
  ): Promise<unknown> {
    const idempotency = foldedIdempotencyOf(req);
    return documentCall(async () => {
      const outcome = await this.documents.restore(
        { kind: "user", userId: session.userId },
        { taskId, revision: body.revision, expectedRevision: body.expectedRevision },
        { id: idempotency.claim.key, fold: publicationFold(idempotency, taskId) },
      );
      return outcome.kind === "replay" ? outcome.body : publishResponse(outcome.result);
    });
  }

  @Get("conflict")
  @Access("admitted")
  conflict(
    @CurrentSession() session: SessionContext,
    @Param("taskId", { schema: taskIdSchema }) taskId: string,
    @Query({ schema: documentConflictQuerySchema }) query: z.output<
      typeof documentConflictQuerySchema
    >,
  ): Promise<DocumentConflictResponse> {
    return documentCall(async () => {
      const review = await this.documents.conflict(
        { kind: "user", userId: session.userId },
        { taskId, base: query.base === "none" ? null : query.base },
      );
      return {
        ...review,
        taskId: taskId as DocumentConflictResponse["taskId"],
        draft: review.draft ? { ...review.draft } : null,
        sections: [...review.sections],
      };
    });
  }
}
