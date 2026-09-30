import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
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
  type TaskLabels,
  type TaskLabelsUpdate,
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
  taskLabelsUpdateSchema,
  taskMoveRequestSchema,
  taskRenameRequestSchema,
  taskTreeQuerySchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { LabelService, TaskService, TaskWriteResult } from "@symplist/core/tasks";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { taskWriteFoldOf } from "./idempotency-fold.ts";
import { workspaceCall } from "./workspace.errors.ts";
import { WorkspaceEvents } from "./workspace.events.ts";
import { LABEL_SERVICE, TASK_SERVICE } from "./workspace.providers.ts";

const user = { kind: "user" } as const;

/**
 * The task tree (§2.1): list a collection, read a task, and create, rename, move, complete and
 * restore tasks, and replace the labels a task carries. Every route is an owner-scoped `app` route at
 * `admitted` access; every tree mutation takes an `Idempotency-Key` whose claim is folded into the
 * write's single D1 batch. `PUT :id/labels` is the one exception, and says below why it needs none.
 */
@Controller("tasks")
@RouteClass("app")
export class TasksController {
  constructor(
    @Inject(TASK_SERVICE) private readonly tasks: TaskService,
    @Inject(LABEL_SERVICE) private readonly labels: LabelService,
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

  /**
   * Replaces the labels this task carries.
   *
   * A `PUT` of the whole set rather than an add and a remove, which is what makes it idempotent and
   * what makes two surfaces editing at once — this row and a connected assistant over MCP — settle on a
   * state the person can see instead of on the difference of two deltas neither of them sent. It takes
   * no `Idempotency-Key` for the same reason.
   */
  @Put(":id/labels")
  @Access("admitted")
  setLabels(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: taskIdSchema }) taskId: string,
    @Body({ schema: taskLabelsUpdateSchema }) body: TaskLabelsUpdate,
  ): Promise<TaskLabels> {
    return workspaceCall(() => this.labels.setTaskLabels(session.userId, taskId, body.labelIds));
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
