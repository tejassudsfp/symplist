import { Inject, Injectable } from "@nestjs/common";
import { SchedulingService } from "@symplist/core/scheduling";
import { sql } from "@symplist/db";
import { TopicHub } from "../realtime/topic-hub.ts";

@Injectable()
export class SchedulingRealtime {
  constructor(
    @Inject(SchedulingService) readonly schedules: SchedulingService,
    @Inject(TopicHub) readonly hub: TopicHub,
  ) {}
  async unread(owner: string) {
    const row = await this.schedules.options.db.first(
      sql(
        `SELECT COUNT(*) AS count FROM notifications WHERE owner_id=:owner AND read_at IS NULL AND dismissed_at IS NULL AND ${this.schedules.access()}`,
        { owner },
      ),
    );
    return Number(row?.count ?? 0);
  }
  async changed(owner: string, notificationId: string | null) {
    if (notificationId) {
      const row = await this.schedules.options.db.first(
        sql(
          `SELECT id FROM notifications WHERE owner_id=:owner AND id=:id AND ${this.schedules.access()}`,
          { owner, id: notificationId },
        ),
      );
      if (!row) return;
    }
    await this.hub.publishToUser(owner, {
      type: "notifications.changed",
      data: { notificationId, unreadCount: await this.unread(owner) },
    });
  }
  async schedule(owner: string, taskId: string, version: number) {
    await this.hub.publishToUser(owner, { type: "schedule.changed", data: { taskId, version } });
  }
  async summary(owner: string, _count: number) {
    // An internal event is only a hint: count persisted rows again, never trust worker-supplied count.
    const row = await this.schedules.options.db.first(
      sql(
        `SELECT COUNT(*) AS count FROM notifications n JOIN notification_prefs p ON p.owner_id=n.owner_id WHERE n.owner_id=:owner AND n.quiet=1 AND n.read_at IS NULL AND n.dismissed_at IS NULL AND n.created_at<=p.last_quiet_summary_at AND n.created_at>p.last_quiet_summary_at-86400000 AND ${this.schedules.access()}`,
        { owner },
      ),
    );
    const count = Number(row?.count ?? 0);
    if (count)
      await this.hub.publishToUser(owner, { type: "notifications.summary", data: { count } });
  }
}
