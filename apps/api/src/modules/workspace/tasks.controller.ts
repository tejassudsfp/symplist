import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  type ArchiveQuery,
  type ArchiveResponse,
  archiveQuerySchema,
  type TaskCompleteRequest,
  type TaskCompleteResponse,
  type TaskCreateRequest,
  type TaskCreateResponse,
  type TaskDetailResponse,
  type TaskMoveRequest,
  type TaskMoveResponse,
  type TaskRenameRequest,
  type TaskRenameResponse,
  type TaskRestoreResponse,
  type TaskTreeQuery,
  type TaskTreeResponse,
  taskCompleteRequestSchema,
  taskCreateRequestSchema,
  taskIdSchema,
  taskMoveRequestSchema,
  taskRenameRequestSchema,
  taskTreeQuerySchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { TaskService, TaskWriteResult } from "@symplist/core/tasks";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { taskWriteFoldOf } from "./idempotency-fold.ts";
import { workspaceCall } from "./workspace.errors.ts";
import { WorkspaceEvents } from "./workspace.events.ts";
import { TASK_SERVICE } from "./workspace.providers.ts";

const user = { kind: "user" } as const;

/**
 * The task tree (§2.1): list a collection, read a task, and create, rename, move, complete and
 * restore tasks. Every route is an owner-scoped `app` route at `admitted` access; every mutation takes
 * an `Idempotency-Key` whose claim is folded into the write's single D1 batch.
 */
@Controller("tasks")
@RouteClass("app")
export class TasksController {
  constructor(
    @Inject(TASK_SERVICE) private readonly tasks: TaskService,
    @Inject(WorkspaceEvents) private readonly events: WorkspaceEvents,
  ) {}

  @Get()
  @Access("admitted")
  list(
    @CurrentSession() session: SessionContext,
    @Query({ schema: taskTreeQuerySchema }) query: TaskTreeQuery,
  ): Promise<TaskTreeResponse> {
    return workspaceCall(() =>
      this.tasks.listCollection(session.userId, query.collection, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    );
  }

  @Get(":id")
  @Access("admitted")
  detail(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: taskIdSchema }) taskId: string,
  ): Promise<TaskDetailResponse> {
    return workspaceCall(() => this.tasks.getTask(session.userId, taskId));
  }

  @Post()
  @Access("admitted")
  @Idempotent({ folded: true })
  create(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Body({ schema: taskCreateRequestSchema }) body: TaskCreateRequest,
  ): Promise<TaskCreateResponse> {
    return this.write(() =>
      this.tasks.create({
        ownerId: session.userId,
        actor: user,
        title: body.title,
        ...(body.collection === undefined ? {} : { collection: body.collection }),
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        ...(body.afterId === undefined ? {} : { afterId: body.afterId }),
        ...(body.placement === undefined ? {} : { placement: body.placement }),
        fold: taskWriteFoldOf(req),
      }),
    );
  }

  @Patch(":id")
  @Access("admitted")
  @Idempotent({ folded: true })
  rename(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: taskIdSchema }) taskId: string,
    @Body({ schema: taskRenameRequestSchema }) body: TaskRenameRequest,
  ): Promise<TaskRenameResponse> {
    return this.write(() =>
      this.tasks.rename({
        ownerId: session.userId,
        taskId,
        title: body.title,
        fold: taskWriteFoldOf(req),
      }),
    );
  }

  @Post(":id/move")
  @HttpCode(200)
  @Access("admitted")
  @Idempotent({ folded: true })
  move(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: taskIdSchema }) taskId: string,
    @Body({ schema: taskMoveRequestSchema }) body: TaskMoveRequest,
  ): Promise<TaskMoveResponse> {
    return this.write(() =>
      this.tasks.move({
        ownerId: session.userId,
        actor: user,
        taskId,
        ...(body.collection === undefined ? {} : { collection: body.collection }),
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        ...(body.afterId === undefined ? {} : { afterId: body.afterId }),
        ...(body.beforeId === undefined ? {} : { beforeId: body.beforeId }),
        fold: taskWriteFoldOf(req),
      }),
    );
  }

  @Post(":id/complete")
  @HttpCode(200)
  @Access("admitted")
  @Idempotent({ folded: true })
  complete(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: taskIdSchema }) taskId: string,
    @Body({ schema: taskCompleteRequestSchema }) body: TaskCompleteRequest,
  ): Promise<TaskCompleteResponse> {
    return this.write(() =>
      this.tasks.complete({
        ownerId: session.userId,
        taskId,
        mode: body.mode,
        stopRun: body.stopRun,
        fold: taskWriteFoldOf(req),
      }),
    );
  }

  @Post(":id/restore")
  @HttpCode(200)
  @Access("admitted")
  @Idempotent({ folded: true })
  restore(
    @Req() req: Request,
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: taskIdSchema }) taskId: string,
  ): Promise<TaskRestoreResponse> {
    return this.write(() =>
      this.tasks.restore({ ownerId: session.userId, taskId, fold: taskWriteFoldOf(req) }),
    );
  }

  private async write<Body>(work: () => Promise<TaskWriteResult<Body>>): Promise<Body> {
    const result = await workspaceCall(work);
    if (result.kind === "replay") return result.body as Body;
    this.events.captured(result);
    return result.body;
  }
}

/** The archive (§2.1, archive brief): completed tasks grouped by local completion date. */
@Controller("archive")
@RouteClass("app")
export class ArchiveController {
  constructor(@Inject(TASK_SERVICE) private readonly tasks: TaskService) {}

  @Get()
  @Access("admitted")
  list(
    @CurrentSession() session: SessionContext,
    @Query({ schema: archiveQuerySchema }) query: ArchiveQuery,
  ): Promise<ArchiveResponse> {
    return workspaceCall(() =>
      this.tasks.listArchive({
        ownerId: session.userId,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.timeZone === undefined ? {} : { timeZone: query.timeZone }),
      }),
    );
  }
}
