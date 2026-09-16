import {
  type SchedulingNotification,
  type SchedulingPreferences,
  schedulingPrefsDataSchema,
  schedulingSnoozeSchema,
} from "@symplist/contracts";
import { computeDigest, decryptFieldText, verifyDigest, zeroize } from "@symplist/crypto";
import { int, type Statement, sql, uuidv7 } from "@symplist/db";
import type { TaskWriteFold } from "../tasks/service.ts";
import { deadlineFromRow, type SchedulingService, schedulingContext } from "./service.ts";
import { SchedulingError } from "./time.ts";

export class NotificationsService {
  constructor(readonly schedules: SchedulingService) {}
  async list(
    owner: string,
    before?: string,
    limit = 30,
  ): Promise<{ items: SchedulingNotification[]; unreadCount: number; nextCursor: string | null }> {
    limit = Math.min(50, Math.max(1, limit));
    const service = this.schedules;
    const [rows, count, keys] = await service.options.db.batch([
      sql(
        `SELECT n.*,t.status AS task_status,s.deadline_kind,s.deadline_date,s.deadline_local,s.deadline_zone,s.disambiguation FROM notifications n JOIN tasks t ON t.id=n.task_id AND t.owner_id=n.owner_id LEFT JOIN task_schedules s ON s.task_id=t.id AND s.owner_id=t.owner_id WHERE n.owner_id=:owner AND n.dismissed_at IS NULL AND ${service.access()} ${before ? "AND (n.created_at,n.id)<(SELECT created_at,id FROM notifications WHERE id=:before AND owner_id=:owner)" : ""} ORDER BY n.created_at DESC,n.id DESC LIMIT :limit`,
        { owner, limit: int(limit + 1), ...(before ? { before } : {}) },
      ),
      sql(
        `SELECT COUNT(*) AS count FROM notifications WHERE owner_id=:owner AND read_at IS NULL AND dismissed_at IS NULL AND ${service.access()}`,
        { owner },
      ),
      service.accountKeys.selectStatement(owner),
    ]);
    const keyRow = keys?.results[0];
    if (!keyRow) throw new SchedulingError("not_found");
    const key = service.accountKeys.unwrapRow(keyRow);
    try {
      const all = rows?.results ?? [];
      const items = all.slice(0, limit).map(
        (row): SchedulingNotification => ({
          id: String(row.id),
          taskId: String(row.task_id),
          title: decryptFieldText(
            key,
            schedulingContext(owner, "notifications", String(row.id), "text_enc"),
            String(row.text_enc),
          ),
          intendedAt: Number(row.intended_at),
          createdAt: Number(row.created_at),
          quiet: row.quiet === 1,
          late: row.late === 1,
          kind: row.kind as "reminder" | "missed",
          count: Number(row.count),
          readAt: row.read_at as number | null,
          taskActive: row.task_status === "active",
          deadline: deadlineFromRow(row),
        }),
      );
      return {
        items,
        unreadCount: Number(count?.results[0]?.count ?? 0),
        nextCursor: all.length > limit ? (items.at(-1)?.id ?? null) : null,
      };
    } finally {
      zeroize(key.key);
    }
  }
  async mark(owner: string, id: string, action: "read" | "dismiss", fold?: TaskWriteFold) {
    const service = this.schedules;
    const now = service.options.now();
    const w = uuidv7(now);
    const params = { owner, id, now: int(now), w, ...fold?.claim.guard.params };
    const statement = sql(
      `UPDATE notifications SET read_at=COALESCE(read_at,:now),${action === "dismiss" ? "dismissed_at=COALESCE(dismissed_at,:now)," : ""}write_id=:w WHERE id=:id AND owner_id=:owner AND ${service.access()} ${fold ? `AND ${fold.claim.guard.exists}` : ""}`,
      params,
    );
    return this.write(
      owner,
      [statement],
      "EXISTS(SELECT 1 FROM notifications WHERE id=:id AND owner_id=:owner AND write_id=:w)",
      { id, owner, w },
      { ok: true },
      fold,
    );
  }
  async savePreferences(
    owner: string,
    baseVersion: number,
    input: SchedulingPreferences,
    fold?: TaskWriteFold,
  ) {
    const data = schedulingPrefsDataSchema.parse(input);
    const service = this.schedules;
    const now = service.options.now();
    const w = uuidv7(now);
    const guard = "EXISTS(SELECT 1 FROM notification_prefs WHERE owner_id=:owner AND write_id=:w)";
    const values = {
      owner,
      w,
      now: int(now),
      version: int(baseVersion),
      zone: data.zone,
      hour: int(data.defaultHour),
      in_app: data.inApp ? "1" : "0",
      email: data.email ? "1" : "0",
      enabled: data.quietEnabled ? "1" : "0",
      start: int(data.quietStart),
      end: int(data.quietEnd),
      preview: data.emailPreview ? "1" : "0",
      ...fold?.claim.guard.params,
    };
    const statement = sql(
      `INSERT INTO notification_prefs(owner_id,version,zone,default_hour,in_app,email,quiet_enabled,quiet_start,quiet_end,email_preview,updated_at,write_id)
      SELECT :owner,1,:zone,:hour,:in_app,:email,:enabled,:start,:end,:preview,:now,:w WHERE ${service.access()} AND EXISTS(SELECT 1 FROM account_keys WHERE owner_id=:owner) ${fold ? `AND ${fold.claim.guard.exists}` : ""}
      AND (CAST(:version AS INTEGER)=0 OR EXISTS(SELECT 1 FROM notification_prefs WHERE owner_id=:owner))
      ON CONFLICT(owner_id) DO UPDATE SET version=notification_prefs.version+1,zone=excluded.zone,default_hour=excluded.default_hour,in_app=excluded.in_app,email=excluded.email,quiet_enabled=excluded.quiet_enabled,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,email_preview=excluded.email_preview,updated_at=excluded.updated_at,write_id=excluded.write_id WHERE notification_prefs.version=CAST(:version AS INTEGER)`,
      values,
    );
    const statements = [statement];
    statements.push(...disableChannels(owner, w, guard, data.inApp, data.email));
    if (!data.email)
      statements.push(
        sql(
          `UPDATE notification_outbox SET status='cancelled',write_id=:w WHERE owner_id=:owner AND channel='email' AND status IN ('pending','claimed','uncertain') AND ${guard}`,
          { owner, w },
        ),
      );
    // Cancel pending occurrences that no longer have any enabled channel. Re-enabling never revives them.
    if (!data.inApp || !data.email)
      statements.push(
        sql(
          `UPDATE reminder_occurrences SET status='cancelled',write_id=:w WHERE owner_id=:owner AND status IN ('pending','claimed') AND ${guard} AND EXISTS(SELECT 1 FROM reminders r WHERE r.id=reminder_occurrences.reminder_id AND NOT ((CAST(:in_app AS INTEGER)=1 AND r.channels_json LIKE '%in_app%') OR (CAST(:email AS INTEGER)=1 AND r.channels_json LIKE '%email%')))`,
          { owner, w, in_app: data.inApp ? "1" : "0", email: data.email ? "1" : "0" },
        ),
      );
    return this.write(
      owner,
      statements,
      guard,
      { owner, w },
      {
        version: baseVersion + 1,
        data,
        remindersEnabled: service.options.remindersEnabled !== false,
        emailEnabled: service.options.emailEnabled !== false,
      },
      fold,
    );
  }
  private async write<T>(
    owner: string,
    statements: Statement[],
    guard: string,
    guardParams: Record<string, string>,
    body: T,
    fold?: TaskWriteFold,
  ): Promise<T> {
    const service = this.schedules;
    const key = await service.accountKeys.require(owner);
    try {
      const writes: Statement[] = [...(fold?.statements ?? []), ...statements];
      if (fold) {
        writes.push(
          sql(
            `DELETE FROM idempotency_records WHERE scope=:scope AND user_id=:owner AND key=:idem AND write_id=:claim AND status='pending' AND NOT ${guard}`,
            {
              ...guardParams,
              scope: fold.claim.scope,
              idem: fold.claim.key,
              claim: fold.claim.writeId,
            },
          ),
        );
        writes.push(fold.completion({ status: 200, body }, key));
      }
      writes.push(sql(`SELECT 1 AS applied WHERE ${guard}`, guardParams));
      const results = await service.options.db.batch(writes);
      if (fold) {
        const decision = fold.decide(results, key, 0);
        if (decision.kind === "replay") return decision.body as T;
      }
      if (!results.at(-1)?.results.length) throw new SchedulingError("schedule.conflict");
      return body;
    } finally {
      zeroize(key.key);
    }
  }
  async snooze(input: {
    ownerId: string;
    notificationId: string;
    requestId: string;
    local: string;
    zone: string;
    disambiguation: "reject" | "earlier" | "later";
    fold?: TaskWriteFold;
  }) {
    const service = this.schedules;
    const body = schedulingSnoozeSchema.parse({
      local: input.local,
      zone: input.zone,
      disambiguation: input.disambiguation,
    });
    const fingerprintInput = { notificationId: input.notificationId, snooze: body };
    const replay = await service.replay({ ...input, actor: "user", fingerprint: fingerprintInput });
    if (replay) return replay;
    const row = await service.options.db.first(
      sql(
        `SELECT n.task_id,r.channels_json,r.override_quiet FROM notifications n JOIN reminder_occurrences o ON o.id=n.last_occurrence_id JOIN reminders r ON r.id=o.reminder_id WHERE n.id=:id AND n.owner_id=:owner AND n.dismissed_at IS NULL AND ${service.access()}`,
        { id: input.notificationId, owner: input.ownerId },
      ),
    );
    if (!row) throw new SchedulingError("not_found");
    const current = await service.get(input.ownerId, String(row.task_id));
    return service.save({
      ownerId: input.ownerId,
      taskId: current.taskId,
      actor: "user",
      requestId: input.requestId,
      fingerprintInput,
      data: {
        baseVersion: current.version,
        deadline: current.deadline,
        reminders: [
          ...current.reminders.map(({ id, rule, channels, overrideQuiet }) => ({
            id,
            rule,
            channels,
            overrideQuiet,
          })),
          {
            rule: { kind: "absolute", ...body },
            channels: JSON.parse(String(row.channels_json)),
            overrideQuiet: row.override_quiet === 1,
          },
        ],
      },
      ...(input.fold ? { fold: input.fold } : {}),
    });
  }
  unsubscribeToken(owner: string): string {
    const digest = computeDigest(
      this.schedules.options.keys,
      "REMINDER_UNSUBSCRIBE_SECRET",
      "reminder-unsubscribe",
      owner,
    );
    return `${owner}.${digest.version}.${digest.digest}`;
  }
  async unsubscribe(token: string): Promise<void> {
    const [owner, version, digest, extra] = token.split(".");
    if (
      !owner ||
      !/^\d+$/.test(version ?? "") ||
      !digest ||
      extra ||
      !verifyDigest(
        this.schedules.options.keys,
        "REMINDER_UNSUBSCRIBE_SECRET",
        "reminder-unsubscribe",
        owner,
        { version: Number(version), digest },
      )
    )
      throw new SchedulingError("not_found");
    const now = this.schedules.options.now();
    const w = uuidv7(now);
    // A narrow signed token can only turn email OFF, and cannot log in or alter tasks.
    await this.schedules.options.db.batch([
      sql(
        "UPDATE notification_prefs SET email=0,version=version+1,updated_at=:now,write_id=:w WHERE owner_id=:owner",
        { owner, now: int(now), w },
      ),
      sql(
        "UPDATE notification_outbox SET status='cancelled',write_id=:w WHERE owner_id=:owner AND channel='email' AND status IN ('pending','claimed','uncertain')",
        { owner, w },
      ),
      ...disableChannels(owner, w, "1=1", true, false),
    ]);
  }
}

/** Remove disabled channels from existing pending reminders; an opt-in later cannot resurrect them. */
function disableChannels(
  owner: string,
  w: string,
  guard: string,
  inApp: boolean,
  email: boolean,
): Statement[] {
  if (inApp && email) return [];
  const params = { owner, w, in_app: inApp ? "1" : "0", email: email ? "1" : "0" };
  const disabled = `((CAST(:in_app AS INTEGER)=0 AND channels_json LIKE '%in_app%') OR (CAST(:email AS INTEGER)=0 AND channels_json LIKE '%email%'))`;
  return [
    sql(
      `UPDATE task_schedules SET version=version+1,write_id=:w WHERE owner_id=:owner AND ${guard} AND task_id IN (SELECT task_id FROM reminders WHERE owner_id=:owner AND status='active' AND ${disabled})`,
      params,
    ),
    sql(
      `UPDATE reminders SET channels_json=(SELECT json_group_array(value) FROM json_each(reminders.channels_json) WHERE (value='in_app' AND CAST(:in_app AS INTEGER)=1) OR (value='email' AND CAST(:email AS INTEGER)=1)),write_id=:w WHERE owner_id=:owner AND status='active' AND ${guard} AND ${disabled}`,
      params,
    ),
    sql(
      `UPDATE reminder_occurrences SET status='cancelled',write_id=:w WHERE owner_id=:owner AND status IN ('pending','claimed') AND ${guard} AND reminder_id IN (SELECT id FROM reminders WHERE owner_id=:owner AND channels_json='[]')`,
      { owner, w },
    ),
    sql(
      `UPDATE reminders SET status='cancelled',generation=generation+1,write_id=:w WHERE owner_id=:owner AND status='active' AND channels_json='[]' AND ${guard}`,
      { owner, w },
    ),
  ];
}
