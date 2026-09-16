import {
  Body,
  Controller,
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
  type SchedulingSave,
  schedulingCalendarQuerySchema,
  schedulingListQuerySchema,
  schedulingPrefsSaveSchema,
  schedulingSaveSchema,
  schedulingSnoozeSchema,
  schedulingSummaryQuerySchema,
  taskIdSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import {
  calendarTasks,
  NotificationsService,
  SchedulingError,
  SchedulingService,
} from "@symplist/core/scheduling";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { schedulingWriteFold as taskWriteFoldOf } from "./idempotency-fold.ts";
import { SchedulingRealtime } from "./scheduling.realtime.ts";

export async function schedulingCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SchedulingError)
      throw new ApiError(error.code as ConstructorParameters<typeof ApiError>[0]);
    throw error;
  }
}
function requestId(req: Request) {
  return req.get("Idempotency-Key") ?? "";
}

@Controller()
@RouteClass("app")
@Access("admitted")
export class SchedulingController {
  constructor(
    @Inject(SchedulingService) private readonly schedules: SchedulingService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(SchedulingRealtime) private readonly realtime: SchedulingRealtime,
  ) {}
  @Get("tasks/:id/schedule")
  get(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: taskIdSchema }) task: string,
  ) {
    return schedulingCall(() => this.schedules.get(session.userId, task));
  }
  @Get("schedule-summaries")
  summaries(
    @CurrentSession() session: SessionContext,
    @Query({ schema: schedulingSummaryQuerySchema })
    query: typeof schedulingSummaryQuerySchema._output,
  ) {
    return schedulingCall(() => this.schedules.summaries(session.userId, query.ids));
  }
  @Put("tasks/:id/schedule")
  @Idempotent({ folded: true })
  async save(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: taskIdSchema }) task: string,
    @Req() req: Request,
    @Body({ schema: schedulingSaveSchema }) data: SchedulingSave,
  ) {
    const result = await schedulingCall(() =>
      this.schedules.save({
        ownerId: session.userId,
        taskId: task,
        actor: "user",
        requestId: requestId(req),
        data,
        fold: taskWriteFoldOf(req),
      }),
    );
    await this.realtime.schedule(session.userId, task, result.version);
    return result;
  }
  @Post("schedules/preview")
  @HttpCode(200)
  preview(
    @CurrentSession() session: SessionContext,
    @Body({ schema: schedulingSaveSchema }) data: SchedulingSave,
  ) {
    return schedulingCall(() => this.schedules.preview(session.userId, data));
  }
  @Get("notification-preferences")
  preferences(@CurrentSession() session: SessionContext) {
    return schedulingCall(() => this.schedules.preferences(session.userId));
  }
  @Put("notification-preferences")
  @Idempotent({ folded: true })
  preferencesSave(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Body({ schema: schedulingPrefsSaveSchema }) body: typeof schedulingPrefsSaveSchema._output,
  ) {
    return schedulingCall(() =>
      this.notifications.savePreferences(
        session.userId,
        body.baseVersion,
        body.data,
        taskWriteFoldOf(req),
      ),
    );
  }
  @Get("notifications")
  list(
    @CurrentSession() session: SessionContext,
    @Query({ schema: schedulingListQuerySchema }) query: typeof schedulingListQuerySchema._output,
  ) {
    return schedulingCall(() => this.notifications.list(session.userId, query.cursor, query.limit));
  }
  @Post("notifications/:id/read")
  @HttpCode(200)
  @Idempotent({ folded: true })
  async read(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Param("id", { schema: taskIdSchema }) id: string,
  ) {
    const result = await schedulingCall(() =>
      this.notifications.mark(session.userId, id, "read", taskWriteFoldOf(req)),
    );
    await this.realtime.changed(session.userId, id);
    return result;
  }
  @Post("notifications/:id/dismiss")
  @HttpCode(200)
  @Idempotent({ folded: true })
  async dismiss(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Param("id", { schema: taskIdSchema }) id: string,
  ) {
    const result = await schedulingCall(() =>
      this.notifications.mark(session.userId, id, "dismiss", taskWriteFoldOf(req)),
    );
    await this.realtime.changed(session.userId, id);
    return result;
  }
  @Post("notifications/:id/snooze")
  @HttpCode(200)
  @Idempotent({ folded: true })
  snooze(
    @CurrentSession() session: SessionContext,
    @Req() req: Request,
    @Param("id", { schema: taskIdSchema }) id: string,
    @Body({ schema: schedulingSnoozeSchema }) body: typeof schedulingSnoozeSchema._output,
  ) {
    return schedulingCall(() =>
      this.notifications.snooze({
        ownerId: session.userId,
        notificationId: id,
        requestId: requestId(req),
        ...body,
        fold: taskWriteFoldOf(req),
      }),
    );
  }
  @Get("calendar")
  calendar(
    @CurrentSession() session: SessionContext,
    @Query({ schema: schedulingCalendarQuerySchema })
    query: typeof schedulingCalendarQuerySchema._output,
  ) {
    return schedulingCall(() => calendarTasks(this.schedules, session.userId, query));
  }
}
