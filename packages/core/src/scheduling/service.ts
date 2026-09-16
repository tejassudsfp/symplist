import {
  type SchedulingDeadline,
  type SchedulingPreferences,
  type SchedulingSave,
  type SchedulingSnapshot,
  schedulingDefaultPreferences,
  schedulingSaveSchema,
} from "@symplist/contracts";
import {
  canonicalJson,
  decryptFieldText,
  encryptFieldText,
  type KeyProvider,
  zeroize,
} from "@symplist/crypto";
import { type DbClient, type DbRow, int, type Statement, sql, uuidv7 } from "@symplist/db";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";
import type { TaskWriteFold } from "../tasks/service.ts";
import { deadlineInstant, previewReminder, SchedulingError } from "./time.ts";

export interface SchedulingOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  readonly remindersEnabled?: boolean;
  readonly emailEnabled?: boolean;
  readonly defaultZone?: string;
}
export function schedulingContext(ownerId: string, table: string, rowId: string, column: string) {
  return { purpose: "scheduling", ownerId, table, rowId, column };
}
export function preferencesFromRow(row: DbRow | undefined, zone = "UTC"): SchedulingPreferences {
  return row
    ? {
        zone: String(row.zone),
        defaultHour: Number(row.default_hour),
        inApp: row.in_app === 1,
        email: row.email === 1,
        quietEnabled: row.quiet_enabled === 1,
        quietStart: Number(row.quiet_start),
        quietEnd: Number(row.quiet_end),
        emailPreview: row.email_preview === 1,
      }
    : { ...schedulingDefaultPreferences, zone };
}
export function deadlineFromRow(row: DbRow | undefined): SchedulingDeadline | null {
  if (!row?.deadline_kind) return null;
  return row.deadline_kind === "date"
    ? { kind: "date", date: String(row.deadline_date), zone: String(row.deadline_zone) }
    : {
        kind: "timed",
        local: String(row.deadline_local),
        zone: String(row.deadline_zone),
        disambiguation: row.disambiguation as "earlier" | "later" | "reject",
      };
}
export class SchedulingService {
  readonly accountKeys: AccountKeyStore;
  constructor(readonly options: SchedulingOptions) {
    this.accountKeys = new AccountKeyStore(options);
  }
  access(ownerParam = "owner") {
    return accessCondition({
      level: "admitted",
      policy: this.options.policy,
      userParam: ownerParam,
    });
  }
  async summaries(owner: string, ids: readonly string[]) {
    if (ids.length > 50 || ids.length === 0) throw new SchedulingError("validation");
    const params = { owner, ...Object.fromEntries(ids.map((id, index) => [`id${index}`, id])) };
    const rows = await this.options.db.all(
      sql(
        `SELECT t.id,s.* FROM tasks t LEFT JOIN task_schedules s ON s.task_id=t.id AND s.owner_id=t.owner_id WHERE t.owner_id=:owner AND t.id IN (${ids.map((_, index) => `:id${index}`).join(",")}) AND ${this.access()}`,
        params,
      ),
    );
    return rows.map((row) => ({
      taskId: String(row.id),
      version: Number(row.version ?? 0),
      deadline: deadlineFromRow(row),
      deadlineAt: (row.deadline_at as number | null) ?? null,
    }));
  }
  async get(ownerId: string, taskId: string): Promise<SchedulingSnapshot> {
    const [tasks, schedules, reminders, preferences] = await this.options.db.batch([
      sql(`SELECT id FROM tasks WHERE id=:task AND owner_id=:owner AND ${this.access()}`, {
        task: taskId,
        owner: ownerId,
      }),
      sql("SELECT * FROM task_schedules WHERE task_id=:task AND owner_id=:owner", {
        task: taskId,
        owner: ownerId,
      }),
      sql(
        `SELECT r.*,o.intended_at FROM reminders r JOIN reminder_occurrences o ON o.reminder_id=r.id AND o.generation=r.generation
        WHERE r.owner_id=:owner AND r.task_id=:task AND r.status='active' AND o.status IN ('pending','claimed') ORDER BY o.intended_at LIMIT 20`,
        { owner: ownerId, task: taskId },
      ),
      sql("SELECT * FROM notification_prefs WHERE owner_id=:owner", { owner: ownerId }),
    ]);
    if (!tasks?.results.length) throw new SchedulingError("not_found");
    const row = schedules?.results[0];
    const deadline = deadlineFromRow(row);
    const prefs = preferencesFromRow(preferences?.results[0], this.options.defaultZone);
    return {
      taskId,
      version: Number(row?.version ?? 0),
      deadline,
      deadlineAt: (row?.deadline_at as number | null) ?? null,
      reminders: (reminders?.results ?? []).map((reminder) => {
        const rule = JSON.parse(String(reminder.rule_json));
        const overrideQuiet = reminder.override_quiet === 1;
        return {
          id: String(reminder.id),
          rule,
          channels: JSON.parse(String(reminder.channels_json)),
          overrideQuiet,
          ...previewReminder(rule, deadline, prefs, overrideQuiet),
        };
      }),
    };
  }
  async preferences(ownerId: string) {
    const [access, prefs] = await this.options.db.batch([
      sql(`SELECT id FROM users WHERE id=:owner AND ${this.access()}`, { owner: ownerId }),
      sql("SELECT * FROM notification_prefs WHERE owner_id=:owner", { owner: ownerId }),
    ]);
    if (!access?.results.length) throw new SchedulingError("not_found");
    const row = prefs?.results[0];
    return {
      version: Number(row?.version ?? 0),
      data: preferencesFromRow(row, this.options.defaultZone),
      remindersEnabled: this.options.remindersEnabled !== false,
      emailEnabled: this.options.emailEnabled !== false,
    };
  }
  async preview(ownerId: string, input: SchedulingSave) {
    const body = schedulingSaveSchema.parse(input);
    const preferences = (await this.preferences(ownerId)).data;
    const due = deadlineInstant(body.deadline);
    return {
      deadlineAt: due,
      reminders: body.reminders.map((r) => ({
        ...r,
        ...previewReminder(r.rule, body.deadline, preferences, r.overrideQuiet),
      })),
    };
  }
  async save(input: {
    ownerId: string;
    taskId: string;
    actor: "user" | "simon" | "mcp";
    requestId: string;
    data: SchedulingSave;
    fold?: TaskWriteFold;
  }): Promise<SchedulingSnapshot> {
    const data = schedulingSaveSchema.parse(input.data);
    const { ownerId: owner, taskId: task } = input;
    const [current, preferenceState, key] = await Promise.all([
      this.get(owner, task),
      this.preferences(owner),
      this.accountKeys.require(owner),
    ]);
    const now = this.options.now();
    const w = uuidv7(now);
    try {
      const fingerprint = canonicalJson({ task, actor: input.actor, data });
      const old = await this.options.db.first(
        sql(
          `SELECT fingerprint_enc FROM schedule_audit WHERE owner_id=:owner AND request_id=:request AND ${this.access()}`,
          { owner, request: input.requestId },
        ),
      );
      if (old && !input.fold) {
        const saved = decryptFieldText(
          key,
          schedulingContext(owner, "schedule_audit", input.requestId, "fingerprint_enc"),
          String(old.fingerprint_enc),
        );
        if (saved !== fingerprint) throw new SchedulingError("idempotency.mismatch");
        return current;
      }
      const reminders = data.reminders.map((r) => {
        if (r.id && !current.reminders.some((existing) => existing.id === r.id))
          throw new SchedulingError("not_found");
        const preview = previewReminder(
          r.rule,
          data.deadline,
          preferenceState.data,
          r.overrideQuiet,
        );
        if (preview.intendedAt <= now) throw new SchedulingError("schedule.past_reminder");
        if (this.options.remindersEnabled === false)
          throw new SchedulingError("schedule.unavailable");
        if (
          (r.channels.includes("email") &&
            (!preferenceState.data.email || this.options.emailEnabled === false)) ||
          (r.channels.includes("in_app") && !preferenceState.data.inApp)
        )
          throw new SchedulingError("schedule.channel_disabled");
        return { ...r, id: r.id ?? uuidv7(now), ...preview };
      });
      const deadlineAt = deadlineInstant(data.deadline);
      const snapshot: SchedulingSnapshot = {
        taskId: task,
        version: data.baseVersion + 1,
        deadline: data.deadline,
        deadlineAt,
        reminders,
      };
      const guard = `EXISTS(SELECT 1 FROM task_schedules WHERE task_id=:task AND owner_id=:owner AND write_id=:w)`;
      const foldGuard = input.fold ? `AND ${input.fold.claim.guard.exists}` : "";
      const params = {
        owner,
        task,
        w,
        now: int(now),
        version: int(data.baseVersion),
        kind: data.deadline?.kind ?? "",
        date: data.deadline?.kind === "date" ? data.deadline.date : "",
        local: data.deadline?.kind === "timed" ? data.deadline.local : "",
        zone: data.deadline?.zone ?? "",
        due: deadlineAt === null ? "" : int(deadlineAt),
        choice: data.deadline?.kind === "timed" ? data.deadline.disambiguation : "",
        ...input.fold?.claim.guard.params,
      };
      const assignments = `deadline_kind=NULLIF(:kind,''),deadline_date=NULLIF(:date,''),deadline_local=NULLIF(:local,''),deadline_zone=NULLIF(:zone,''),deadline_at=CAST(NULLIF(:due,'') AS INTEGER),disambiguation=NULLIF(:choice,''),updated_at=:now,write_id=:w`;
      const active = `EXISTS(SELECT 1 FROM tasks WHERE id=:task AND owner_id=:owner AND status='active') AND ${this.access()} AND EXISTS(SELECT 1 FROM account_keys WHERE owner_id=:owner) ${foldGuard}`;
      const statements: Statement[] = [
        ...(input.fold?.statements ?? []),
        data.baseVersion === 0
          ? sql(
              `INSERT INTO task_schedules(task_id,owner_id,version,deadline_kind,deadline_date,deadline_local,deadline_zone,deadline_at,disambiguation,updated_at,write_id)
          SELECT :task,:owner,CAST(:version AS INTEGER)+1,NULLIF(:kind,''),NULLIF(:date,''),NULLIF(:local,''),NULLIF(:zone,''),CAST(NULLIF(:due,'') AS INTEGER),NULLIF(:choice,''),:now,:w WHERE ${active} ON CONFLICT(task_id) DO NOTHING`,
              params,
            )
          : sql(
              `UPDATE task_schedules SET version=version+1,${assignments} WHERE task_id=:task AND owner_id=:owner AND version=CAST(:version AS INTEGER) AND ${active}`,
              params,
            ),
        ...cancelTaskStatements(owner, task, w, guard),
      ];
      for (const r of reminders) {
        statements.push(
          sql(
            `INSERT INTO reminders(id,owner_id,task_id,rule_json,channels_json,override_quiet,generation,status,created_at,write_id)
          SELECT :id,:owner,:task,:rule,:channels,:override,1,'active',:now,:w WHERE ${guard}
          ON CONFLICT(id) DO UPDATE SET rule_json=excluded.rule_json,channels_json=excluded.channels_json,override_quiet=excluded.override_quiet,generation=reminders.generation+1,status='active',write_id=excluded.write_id WHERE reminders.owner_id=:owner AND reminders.task_id=:task`,
            {
              owner,
              task,
              w,
              now: int(now),
              id: r.id,
              rule: JSON.stringify(r.rule),
              channels: JSON.stringify(r.channels),
              override: r.overrideQuiet ? "1" : "0",
            },
          ),
        );
        statements.push(
          sql(
            `INSERT INTO reminder_occurrences(id,owner_id,task_id,reminder_id,generation,intended_at,status,created_at,write_id)
          SELECT :id,:owner,:task,id,generation,:intended,'pending',:now,:w FROM reminders WHERE id=:reminder AND owner_id=:owner AND write_id=:w AND ${guard}`,
            {
              id: uuidv7(now),
              owner,
              task,
              reminder: r.id,
              intended: int(r.intendedAt),
              now: int(now),
              w,
            },
          ),
        );
      }
      statements.push(
        sql(
          `INSERT INTO schedule_audit(id,owner_id,task_id,actor,version,request_id,fingerprint_enc,created_at) SELECT :id,:owner,:task,:actor,:version,:request,:fingerprint,:now WHERE ${guard}`,
          {
            id: w,
            owner,
            task,
            actor: input.actor,
            version: int(snapshot.version),
            request: input.requestId,
            fingerprint: encryptFieldText(
              key,
              schedulingContext(owner, "schedule_audit", input.requestId, "fingerprint_enc"),
              fingerprint,
            ),
            now: int(now),
            w,
          },
        ),
      );
      if (input.fold) {
        statements.push(
          sql(
            `DELETE FROM idempotency_records WHERE scope=:scope AND user_id=:owner AND key=:idem AND write_id=:claim AND status='pending' AND NOT ${guard}`,
            {
              scope: input.fold.claim.scope,
              owner,
              idem: input.fold.claim.key,
              claim: input.fold.claim.writeId,
              task,
              w,
            },
          ),
        );
        statements.push(input.fold.completion({ status: 200, body: snapshot }, key));
      }
      statements.push(
        sql(
          `SELECT version FROM task_schedules WHERE task_id=:task AND owner_id=:owner AND write_id=:w`,
          { task, owner, w },
        ),
      );
      const results = await this.options.db.batch(statements);
      if (input.fold) {
        const result = input.fold.decide(results, key, 0);
        if (result.kind === "replay") return result.body as SchedulingSnapshot;
      }
      if (!results.at(-1)?.results.length) throw new SchedulingError("schedule.conflict");
      return snapshot;
    } finally {
      zeroize(key.key);
    }
  }
}

export function cancelTaskStatements(
  owner: string,
  task: string,
  w: string,
  guard: string,
): Statement[] {
  const params = { owner, task, w };
  return [
    sql(
      `UPDATE reminders SET generation=generation+1,status='cancelled',write_id=:w WHERE owner_id=:owner AND task_id=:task AND status='active' AND ${guard}`,
      params,
    ),
    sql(
      `UPDATE reminder_occurrences SET status='cancelled',write_id=:w WHERE owner_id=:owner AND task_id=:task AND status IN ('pending','claimed') AND ${guard}`,
      params,
    ),
    sql(
      `UPDATE notification_outbox SET status='cancelled',write_id=:w WHERE owner_id=:owner AND task_id=:task AND status IN ('pending','claimed','uncertain') AND ${guard}`,
      params,
    ),
  ];
}
