import { Controller, Get, Inject, Param, Query, UseInterceptors } from "@nestjs/common";
import {
  type AdminEventDetail,
  type AdminEventPage,
  idSchema,
  type ListActivityQuery,
  listActivityQuerySchema,
} from "@symplist/contracts";
import type { ActivityService } from "@symplist/core/access";
import { Access } from "../../common/access.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { ACTIVITY_SERVICE } from "./access.tokens.ts";
import { AccessErrorsInterceptor } from "./access-errors.interceptor.ts";

/** The immutable access audit log (admin activity brief). Read-only: there is no edit or delete. */
@Controller("admin/activity")
@RouteClass("app")
@UseInterceptors(AccessErrorsInterceptor)
export class AdminActivityController {
  constructor(@Inject(ACTIVITY_SERVICE) private readonly activity: ActivityService) {}

  @Get()
  @Access("admin", { fresh: true })
  list(
    @Query({ schema: listActivityQuerySchema }) query: ListActivityQuery,
  ): Promise<AdminEventPage> {
    return this.activity.list(query);
  }

  @Get(":id")
  @Access("admin", { fresh: true })
  detail(@Param("id", { schema: idSchema }) eventId: string): Promise<AdminEventDetail> {
    return this.activity.detail(eventId);
  }
}
