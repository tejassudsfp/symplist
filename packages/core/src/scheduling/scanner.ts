import {
  computeEmailSuppressionDigestCandidates,
  decryptFieldText,
  encryptFieldText,
  zeroize,
} from "@symplist/crypto";
import { type DbRow, int, type Statement, sql, uuidv7 } from "@symplist/db";
import type { EmailMessage, EmailTransport } from "@symplist/email/transport";
import { Temporal } from "temporal-polyfill";
import { taskTitleContext } from "../tasks/sql.ts";
import { ScannerBatchDb } from "./batching.ts";
import {
  preferencesFromRow,
  type SchedulingOptions,
  SchedulingService,
  schedulingContext,
} from "./service.ts";
import { afterQuiet, isQuiet } from "./time.ts";

export interface ScannerExecution {
  readonly executor: "local" | "trigger";
  readonly generation: number;
  readonly signal?: AbortSignal;
}
export interface ReminderScannerOptions extends SchedulingOptions {
  readonly email: EmailTransport;
  readonly renderEmail: (input: {
    ownerId: string;
    taskId: string;
    occurrenceId: string;
    title: string;
    row: DbRow;
    late: boolean;
  }) => Promise<EmailMessage>;
  readonly notify?: (ownerId: string, notificationId: string) => Promise<void>;
  readonly summary?: (ownerId: string, count: number) => Promise<void>;
  readonly maxLatenessHours?: number;
  readonly batchSize?: number;
}

/** One bounded in-process scan; no child jobs and no model calls. Claims are conditional, generation- and lease-fenced. */
export class ReminderScanner {
  readonly service: SchedulingService;
  constructor(readonly options: ReminderScannerOptions) {
    this.service = new SchedulingService(options);
  }
  executorGuard() {
    return "EXISTS(SELECT 1 FROM executor_state WHERE id=1 AND mode=:mode AND generation=CAST(:generation AS INTEGER))";
  }
  executionParams(input: ScannerExecution) {
    return {
      mode: input.executor === "trigger" ? "durable" : "local",
      generation: int(input.generation),
    };
  }
  async run(input: ScannerExecution) {
    // One scan-scoped client folds simultaneous phase work; provider delivery remains five-wide.
    const batched = new ReminderScanner({
      ...this.options,
      db: new ScannerBatchDb(this.options.db, input.signal),
    });
    return batched.runBatched(input);
  }
  private async runBatched(input: ScannerExecution) {
    const now = this.options.now();
    const limit = Math.min(50, Math.max(1, this.options.batchSize ?? 50));
    const rows = await this.options.db.all(
      sql(
        `SELECT id FROM reminder_occurrences WHERE (status='pending' OR (status='claimed' AND lease_until<=:now)) AND intended_at<=:now AND ${this.executorGuard()} ORDER BY intended_at DESC,id LIMIT :limit`,
        { now: int(now), limit: int(limit), ...this.executionParams(input) },
      ),
    );
    let occurrenceCount = 0;
    let acceptedCount = 0;
    const announcements = new Map<string, string>();
    await Promise.all(
      rows.map(async (row) => {
        if (input.signal?.aborted) return;
        const announcement = await this.materialize(String(row.id), input);
        if (announcement) announcements.set(announcement.owner, announcement.id);
        occurrenceCount++;
      }),
    );
    await Promise.all([...announcements].map(([owner, id]) => this.options.notify?.(owner, id)));
    const due = await this.options.db.all(
      sql(
        `SELECT id FROM notification_outbox WHERE (status='pending' OR (status='claimed' AND lease_until<=:now)) AND deliver_after<=:now AND ${this.executorGuard()} ORDER BY deliver_after,id LIMIT :limit`,
        { now: int(this.options.now()), limit: int(limit), ...this.executionParams(input) },
      ),
    );
    for (let index = 0; index < due.length && !input.signal?.aborted; index += 5) {
      const outcomes = await Promise.all(
        due.slice(index, index + 5).map((row) => this.deliver(String(row.id), input)),
      );
      acceptedCount += outcomes.filter(Boolean).length;
    }
    await this.quietSummaries(input);
    return { occurrenceCount, acceptedCount };
  }
  private async materialize(id: string, input: ScannerExecution) {
    const now = this.options.now();
    const lease = uuidv7(now);
    const [_, claimed] = await this.options.db.batch([
      sql(
        `UPDATE reminder_occurrences SET status='claimed',lease_owner=:lease,lease_until=:until,fence=fence+1,executor_generation=:generation,attempts=attempts+1,write_id=:lease
        WHERE id=:id AND intended_at<=:now AND (status='pending' OR (status='claimed' AND lease_until<=:now)) AND ${this.executorGuard()}`,
        { id, lease, until: int(now + 120000), now: int(now), ...this.executionParams(input) },
      ),
      sql(
        `SELECT o.*,r.channels_json,r.override_quiet,r.generation AS current_generation,r.status AS reminder_status,t.status AS task_status,t.title_enc,u.email,
        p.zone,p.default_hour,p.in_app,p.email AS email_enabled,p.quiet_enabled,p.quiet_start,p.quiet_end,p.email_preview,p.version AS preference_version,
        s.deadline_kind,s.deadline_date,s.deadline_local,s.deadline_zone,s.deadline_at,s.disambiguation,
        k.kek_version,k.wrapped_key,
        (SELECT n.id FROM notifications n WHERE n.owner_id=o.owner_id AND n.task_id=o.task_id AND n.kind='missed' AND n.read_at IS NULL AND n.dismissed_at IS NULL LIMIT 1) AS missed_id,
        (SELECT COUNT(*) FROM reminder_occurrences prior JOIN reminders pr ON pr.id=prior.reminder_id WHERE prior.owner_id=o.owner_id AND prior.task_id=o.task_id AND (prior.intended_at<o.intended_at OR (prior.intended_at=o.intended_at AND prior.id<o.id)) AND prior.status IN ('pending','claimed') AND pr.generation=prior.generation AND pr.status='active' AND pr.channels_json LIKE '%in_app%' AND NOT EXISTS(SELECT 1 FROM notifications n JOIN reminder_occurrences counted ON counted.id=n.last_occurrence_id WHERE n.owner_id=o.owner_id AND n.task_id=o.task_id AND n.kind='missed' AND n.read_at IS NULL AND n.dismissed_at IS NULL AND (prior.intended_at<counted.intended_at OR (prior.intended_at=counted.intended_at AND prior.id<=counted.id)))) AS missed_count
        FROM reminder_occurrences o JOIN reminders r ON r.id=o.reminder_id JOIN tasks t ON t.id=o.task_id JOIN users u ON u.id=o.owner_id
        LEFT JOIN notification_prefs p ON p.owner_id=o.owner_id LEFT JOIN task_schedules s ON s.task_id=o.task_id LEFT JOIN account_keys k ON k.owner_id=o.owner_id
        WHERE o.id=:id AND o.write_id=:lease`,
        { id, lease },
      ),
    ]);
    const row = claimed?.results[0];
    if (!row) return;
    const owner = String(row.owner_id);
    const task = String(row.task_id);
    const fence = Number(row.fence);
    const guard = `EXISTS(SELECT 1 FROM reminder_occurrences WHERE id=:occurrence AND lease_owner=:lease AND fence=CAST(:fence AS INTEGER) AND lease_until>:now AND status='claimed') AND ${this.executorGuard()} AND COALESCE((SELECT version FROM notification_prefs WHERE owner_id=:pref_owner),0)=CAST(:pref_version AS INTEGER)`;
    const params = {
      occurrence: id,
      lease,
      fence: int(fence),
      now: int(now),
      pref_owner: owner,
      pref_version: int(Number(row.preference_version ?? 0)),
      ...this.executionParams(input),
    };
    const access = this.service.access();
    const live = `${access} AND EXISTS(SELECT 1 FROM tasks WHERE id=:task AND owner_id=:owner AND status='active') AND EXISTS(SELECT 1 FROM reminders WHERE id=:reminder AND owner_id=:owner AND generation=CAST(:reminder_generation AS INTEGER) AND status='active') AND EXISTS(SELECT 1 FROM account_keys WHERE owner_id=:owner)`;
    const liveParams = {
      owner,
      task,
      reminder: String(row.reminder_id),
      reminder_generation: int(Number(row.generation)),
    };
    const lateness = now - Number(row.intended_at);
    const late = lateness >= 60_000;
    const invalid =
      this.options.remindersEnabled === false ||
      row.task_status !== "active" ||
      row.reminder_status !== "active" ||
      row.generation !== row.current_generation ||
      !row.wrapped_key;
    const tooLate = lateness > (this.options.maxLatenessHours ?? 24) * 3600000;
    if (invalid) {
      await this.options.db.run(
        sql(
          `UPDATE reminder_occurrences SET status=:status,write_id=:lease WHERE id=:occurrence AND ${guard}`,
          { ...params, status: invalid ? "cancelled" : "expired" },
        ),
      );
      return;
    }
    const key = this.service.accountKeys.unwrapRow({
      owner_id: owner,
      kek_version: row.kek_version ?? null,
      wrapped_key: row.wrapped_key ?? null,
    });
    try {
      const title = decryptFieldText(key, taskTitleContext(owner, task), String(row.title_enc));
      const prefs = preferencesFromRow(
        row.zone ? { ...row, email: row.email_enabled ?? 0 } : undefined,
        this.options.defaultZone,
      );
      const quiet = row.override_quiet !== 1 && isQuiet(Number(row.intended_at), prefs);
      const channels: string[] = JSON.parse(String(row.channels_json));
      const kind = late ? "missed" : "reminder";
      const notificationId =
        late && typeof row.missed_id === "string" ? row.missed_id : uuidv7(now);
      const payload =
        !tooLate && channels.includes("email") && prefs.email && this.options.emailEnabled !== false
          ? await this.options.renderEmail({
              ownerId: owner,
              taskId: task,
              occurrenceId: id,
              title,
              row,
              late,
            })
          : null;
      // Rendering may yield; every deciding statement compares the lease against a fresh clock.
      params.now = int(this.options.now());
      const statements: Statement[] = [];
      if (channels.includes("in_app") && prefs.inApp) {
        const text = encryptFieldText(
          key,
          schedulingContext(owner, "notifications", notificationId, "text_enc"),
          title,
        );
        // Normal entries are unique per occurrence. Catch-up is collapsed below after one latest delivery.
        statements.push(
          sql(
            `INSERT INTO notifications(id,owner_id,task_id,occurrence_id,kind,text_enc,intended_at,quiet,late,count,last_occurrence_id,created_at,write_id)
          SELECT :id,:owner,:task,:occurrence,:kind,:text,:intended,:quiet,:late,:count,:occurrence,:now,:lease WHERE ${guard} AND ${live}
          AND COALESCE((SELECT in_app FROM notification_prefs WHERE owner_id=:owner),1)=1
          AND EXISTS(SELECT 1 FROM reminders WHERE id=:reminder AND channels_json LIKE '%in_app%')
          AND NOT EXISTS(SELECT 1 FROM reminder_occurrences newer JOIN reminders nr ON nr.id=newer.reminder_id WHERE newer.owner_id=:owner AND newer.task_id=:task AND (newer.intended_at>CAST(:intended AS INTEGER) OR (newer.intended_at=CAST(:intended AS INTEGER) AND newer.id>:occurrence)) AND newer.intended_at<=:now AND newer.status IN ('pending','claimed','delivered','expired') AND nr.status='active' AND nr.generation=newer.generation AND nr.channels_json LIKE '%in_app%')
          ON CONFLICT(id) DO UPDATE SET count=notifications.count+excluded.count,last_occurrence_id=excluded.last_occurrence_id,intended_at=excluded.intended_at,text_enc=excluded.text_enc,quiet=excluded.quiet,write_id=excluded.write_id WHERE notifications.last_occurrence_id<>excluded.last_occurrence_id
          ON CONFLICT(occurrence_id,kind) DO NOTHING`,
            {
              ...params,
              ...liveParams,
              id: notificationId,
              text,
              intended: int(Number(row.intended_at)),
              quiet: quiet ? "1" : "0",
              late: late ? "1" : "0",
              kind,
              count: int(1 + (late ? Number(row.missed_count) : 0)),
            },
          ),
        );
      }
      if (payload) {
        const outboxId = uuidv7(now);
        const encrypted = encryptFieldText(
          key,
          schedulingContext(owner, "notification_outbox", outboxId, "payload_enc"),
          JSON.stringify(payload),
        );
        statements.push(
          sql(
            `INSERT INTO notification_outbox(id,owner_id,task_id,occurrence_id,channel,deliver_after,idempotency_key,payload_enc,status,created_at,write_id)
          SELECT :id,:owner,:task,:occurrence,'email',:after,:idem,:payload,'pending',:now,:lease WHERE ${guard} AND ${live}
          AND EXISTS(SELECT 1 FROM notification_prefs WHERE owner_id=:owner AND email=1)
          AND EXISTS(SELECT 1 FROM reminders WHERE id=:reminder AND channels_json LIKE '%email%')
          AND NOT EXISTS(SELECT 1 FROM reminder_occurrences newer JOIN reminders nr ON nr.id=newer.reminder_id WHERE newer.owner_id=:owner AND newer.task_id=:task AND (newer.intended_at>CAST(:intended AS INTEGER) OR (newer.intended_at=CAST(:intended AS INTEGER) AND newer.id>:occurrence)) AND newer.intended_at<=:now AND newer.status IN ('pending','claimed','delivered') AND nr.status='active' AND nr.generation=newer.generation AND nr.channels_json LIKE '%email%') ON CONFLICT(occurrence_id,channel) DO NOTHING`,
            {
              ...params,
              ...liveParams,
              id: outboxId,
              after: int(
                quiet ? afterQuiet(Number(row.intended_at), prefs) : Number(row.intended_at),
              ),
              idem: `reminder/${id}/email`,
              payload: encrypted,
              intended: int(Number(row.intended_at)),
            },
          ),
        );
      }
      statements.push(
        sql(
          `UPDATE reminder_occurrences SET status=CASE WHEN NOT (${live}) THEN 'suppressed_access' WHEN CAST(:expired AS INTEGER)=1 THEN 'expired' WHEN EXISTS(SELECT 1 FROM notifications WHERE last_occurrence_id=:occurrence) OR EXISTS(SELECT 1 FROM notification_outbox WHERE occurrence_id=:occurrence) THEN 'delivered' ELSE 'skipped' END,late=:late,write_id=:lease WHERE id=:occurrence AND ${guard}`,
          { ...params, ...liveParams, late: late ? "1" : "0", expired: tooLate ? "1" : "0" },
        ),
      );
      statements.push(
        sql("SELECT id FROM notifications WHERE id=:id AND write_id=:lease", {
          id: notificationId,
          lease,
        }),
      );
      const result = await this.options.db.batch(statements);
      if (result.at(-1)?.results.length && !quiet) return { owner, id: notificationId };
    } finally {
      zeroize(key.key);
    }
  }
  private async deliver(id: string, input: ScannerExecution): Promise<boolean> {
    const now = this.options.now();
    const lease = uuidv7(now);
    const [_, result] = await this.options.db.batch([
      sql(
        `UPDATE notification_outbox SET status='claimed',lease_owner=:lease,lease_until=:until,fence=fence+1,executor_generation=:generation,attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,:now),write_id=:lease
        WHERE id=:id AND deliver_after<=:now AND (status='pending' OR (status='claimed' AND lease_until<=:now)) AND ${this.executorGuard()}`,
        { id, lease, until: int(now + 120000), now: int(now), ...this.executionParams(input) },
      ),
      sql(
        `SELECT b.*,o.intended_at,o.generation AS reminder_generation,r.generation AS current_generation,r.status AS reminder_status,r.override_quiet,t.status AS task_status,u.email,p.email AS email_enabled,p.version AS prefs_version,p.zone,p.default_hour,p.in_app,p.quiet_enabled,p.quiet_start,p.quiet_end,p.email_preview,k.kek_version,k.wrapped_key
        FROM notification_outbox b JOIN reminder_occurrences o ON o.id=b.occurrence_id JOIN reminders r ON r.id=o.reminder_id JOIN tasks t ON t.id=b.task_id JOIN users u ON u.id=b.owner_id
        LEFT JOIN notification_prefs p ON p.owner_id=b.owner_id LEFT JOIN account_keys k ON k.owner_id=b.owner_id WHERE b.id=:id AND b.write_id=:lease`,
        { id, lease },
      ),
    ]);
    const row = result?.results[0];
    if (!row) return false;
    const owner = String(row.owner_id);
    const fence = int(Number(row.fence));
    const guard = `id=:id AND lease_owner=:lease AND fence=CAST(:fence AS INTEGER) AND status='claimed' AND lease_until>:now AND ${this.executorGuard()}`;
    const params = { id, lease, fence, now: int(now), ...this.executionParams(input) };
    const invalid =
      this.options.remindersEnabled === false ||
      this.options.emailEnabled === false ||
      row.email_enabled !== 1 ||
      row.task_status !== "active" ||
      row.reminder_status !== "active" ||
      row.reminder_generation !== row.current_generation ||
      !row.wrapped_key;
    const expired = now - Number(row.intended_at) > (this.options.maxLatenessHours ?? 24) * 3600000;
    const uncertain = now - Number(row.first_attempt_at) >= 24 * 3600000;
    if (invalid || expired || uncertain) {
      await this.options.db.run(
        sql(`UPDATE notification_outbox SET status=:status,write_id=:lease WHERE ${guard}`, {
          ...params,
          status: invalid ? "cancelled" : uncertain ? "uncertain" : "expired",
        }),
      );
      return false;
    }
    const currentPreferences = preferencesFromRow({ ...row, email: row.email_enabled ?? 0 });
    if (row.override_quiet !== 1 && isQuiet(now, currentPreferences)) {
      await this.options.db.run(
        sql(
          `UPDATE notification_outbox SET status='pending',deliver_after=:after,write_id=:lease WHERE ${guard}`,
          {
            ...params,
            after: int(afterQuiet(now, currentPreferences)),
          },
        ),
      );
      return false;
    }
    const candidates = computeEmailSuppressionDigestCandidates(
      this.options.keys,
      String(row.email),
    );
    const suppressionParams = Object.fromEntries(
      candidates.flatMap((digest, index) => [
        [`digest${index}`, digest.digest],
        [`version${index}`, int(digest.version)],
      ]),
    );
    const suppression = candidates
      .map(
        (_, index) =>
          `(address_digest=:digest${index} AND digest_version=CAST(:version${index} AS INTEGER))`,
      )
      .join(" OR ");
    // This is the dispatch boundary. Every send rechecks live access, lease, generation and suppression.
    const live = await this.options.db.first(
      sql(
        `SELECT id FROM notification_outbox WHERE ${guard} AND ${this.service.access()}
      AND EXISTS(SELECT 1 FROM tasks WHERE id=notification_outbox.task_id AND owner_id=:owner AND status='active')
      AND EXISTS(SELECT 1 FROM notification_prefs WHERE owner_id=:owner AND email=1 AND version=CAST(:prefs_version AS INTEGER))
      AND EXISTS(SELECT 1 FROM reminders r JOIN reminder_occurrences o ON o.reminder_id=r.id WHERE o.id=notification_outbox.occurrence_id AND r.status='active' AND r.generation=o.generation AND r.channels_json LIKE '%email%')
      AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE ${suppression})`,
        {
          ...params,
          now: int(this.options.now()),
          owner,
          prefs_version: int(Number(row.prefs_version)),
          ...suppressionParams,
        },
      ),
    );
    if (!live || input.signal?.aborted) {
      await this.options.db.run(
        sql(
          `UPDATE notification_outbox SET status='pending',deliver_after=:now,write_id=:lease WHERE ${guard}`,
          params,
        ),
      );
      return false;
    }
    const key = this.service.accountKeys.unwrapRow({
      owner_id: owner,
      kek_version: row.kek_version ?? null,
      wrapped_key: row.wrapped_key ?? null,
    });
    try {
      const payload = JSON.parse(
        decryptFieldText(
          key,
          schedulingContext(owner, "notification_outbox", id, "payload_enc"),
          String(row.payload_enc),
        ),
      ) as EmailMessage;
      try {
        const sent = await this.options.email.send(payload);
        await this.options.db.run(
          sql(
            `UPDATE notification_outbox SET status='accepted',provider_id=NULLIF(:provider,''),write_id=:lease WHERE ${guard}`,
            { ...params, now: int(this.options.now()), provider: sent.providerId ?? "" },
          ),
        );
        return true;
      } catch {
        // Unknown acceptance can be retried only inside Resend's dedupe window, with the immutable key/payload.
        await this.options.db.run(
          sql(
            `UPDATE notification_outbox SET status=:status,deliver_after=:after,write_id=:lease WHERE ${guard}`,
            {
              ...params,
              now: int(this.options.now()),
              status: Number(row.attempts) >= 5 ? "uncertain" : "pending",
              after: int(now + Math.min(3600000, 60000 * 2 ** Number(row.attempts))),
            },
          ),
        );
        return false;
      }
    } finally {
      zeroize(key.key);
    }
  }
  async quietSummaries(input: ScannerExecution): Promise<void> {
    const now = this.options.now();
    const owners = await this.options.db.all(
      sql(
        `SELECT * FROM notification_prefs p WHERE quiet_enabled=1 AND EXISTS(SELECT 1 FROM notifications n WHERE n.owner_id=p.owner_id AND n.quiet=1 AND n.created_at>=COALESCE(p.last_quiet_summary_at,0) AND n.read_at IS NULL AND n.dismissed_at IS NULL) AND ${this.executorGuard()} ORDER BY owner_id LIMIT 50`,
        this.executionParams(input),
      ),
    );
    await Promise.all(
      owners.map(async (row) => {
        if (input.signal?.aborted) return;
        const prefs = preferencesFromRow(row);
        if (isQuiet(now, prefs)) return;
        const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(prefs.zone);
        let end = local.with({ hour: prefs.quietEnd, minute: 0, second: 0, millisecond: 0 });
        if (end.epochMilliseconds > now) end = end.subtract({ days: 1 });
        const start = (prefs.quietStart > prefs.quietEnd ? end.subtract({ days: 1 }) : end).with({
          hour: prefs.quietStart,
        });
        const owner = String(row.owner_id);
        const w = uuidv7(now);
        const params = {
          owner,
          w,
          end: int(end.epochMilliseconds),
          start: int(start.epochMilliseconds),
          version: int(Number(row.version)),
          ...this.executionParams(input),
        };
        const result = await this.options.db.batch([
          sql(
            `UPDATE notification_prefs SET last_quiet_summary_at=:end,last_quiet_summary_start_at=:start,write_id=:w WHERE owner_id=:owner AND version=CAST(:version AS INTEGER) AND (last_quiet_summary_at IS NULL OR last_quiet_summary_at<CAST(:end AS INTEGER)) AND ${this.executorGuard()} AND ${this.service.access()}`,
            params,
          ),
          sql(
            `SELECT COUNT(*) AS count FROM notifications WHERE owner_id=:owner AND quiet=1 AND created_at>=CAST(:start AS INTEGER) AND created_at<CAST(:end AS INTEGER) AND read_at IS NULL AND dismissed_at IS NULL AND EXISTS(SELECT 1 FROM notification_prefs WHERE owner_id=:owner AND write_id=:w)`,
            { owner, w, start: int(start.epochMilliseconds), end: int(end.epochMilliseconds) },
          ),
        ]);
        const count = Number(result[1]?.results[0]?.count ?? 0);
        if (count) await this.options.summary?.(owner, count);
      }),
    );
  }
}
