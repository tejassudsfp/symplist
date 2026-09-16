import { Controller, HttpCode, Inject, Post, Query } from "@nestjs/common";
import { NotificationsService } from "@symplist/core/scheduling";
import { ApiError } from "../../common/errors/api-error.ts";
import { RouteClass } from "../../common/route-classes.ts";

/** RFC8058 POST only. The signed capability can disable reminder email, nothing else. No cookies. */
@Controller("webhooks/reminder-unsubscribe")
@RouteClass("signed")
export class ReminderUnsubscribeController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}
  @Post()
  @HttpCode(200)
  async unsubscribe(@Query("token") token: unknown) {
    if (typeof token !== "string" || token.length > 200) throw ApiError.notFound();
    try {
      await this.notifications.unsubscribe(token);
    } catch {
      throw ApiError.notFound();
    }
    return { ok: true };
  }
}
