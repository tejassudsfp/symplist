import { schedulingDefaultPreferences } from "@symplist/contracts";
import { encryptFieldText, zeroize } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { taskTitleContext } from "../tasks/sql.ts";
import { NotificationsService } from "./notifications.ts";
import { ReminderScanner } from "./scanner.ts";
import { SchedulingService } from "./service.ts";

describe("shared reminder scan", () => {
  let env: DocumentsTestEnvironment;
  let schedules: SchedulingService;
  let notifications: NotificationsService;
  let owner: string;
  let task: string;
  const send = vi.fn(async () => ({ providerId: "resend-example" }));
  const notify = vi.fn(async () => {});
  const summary = vi.fn(async () => {});
  beforeEach(async () => {
    send.mockClear();
    notify.mockClear();
    summary.mockClear();
    env = await createDocumentsTestEnvironment();
    owner = await env.createUser();
    task = await env.createTask(owner);
    schedules = new SchedulingService({
      db: env.db,
      keys: env.keys,
      now: () => env.clock,
      policy: { betaAccessRequired: true },
    });
    notifications = new NotificationsService(schedules);
    const key = await schedules.accountKeys.require(owner);
    await env.db.run(
      sql("UPDATE tasks SET title_enc=:text WHERE id=:id", {
        id: task,
        text: encryptFieldText(key, taskTitleContext(owner, task), "PRIVATE REMINDER MARKER"),
      }),
    );
    zeroize(key.key);
    await env.db.run(
      sql(
        "INSERT INTO executor_state(id,mode,generation,updated_at,write_id) VALUES(1,'local',1,:now,'fixture') ON CONFLICT(id) DO UPDATE SET mode='local',generation=1",
        { now: String(env.clock) },
      ),
    );
    await notifications.savePreferences(owner, 0, { ...schedulingDefaultPreferences, email: true });
  });
  afterEach(async () => env.close());
  function scanner(overrides: Partial<ConstructorParameters<typeof ReminderScanner>[0]> = {}) {
    return new ReminderScanner({
      ...schedules.options,
      email: { send },
      notify,
      summary,
      renderEmail: async ({ occurrenceId }) => ({
        to: "receiver@example.test",
        subject: "You have a task reminder",
        html: "<p>A reminder</p>",
        text: "A reminder",
        sender: "reminders",
        idempotencyKey: `reminder/${occurrenceId}/email`,
      }),
      ...overrides,
    });
  }
  async function schedule(
    local = "2026-09-15T10:00",
    channels: ("email" | "in_app")[] = ["in_app", "email"],
  ) {
    await schedules.save({
      ownerId: owner,
      taskId: task,
      actor: "user",
      requestId: "scan",
      data: {
        baseVersion: 0,
        deadline: null,
        reminders: [
          {
            rule: { kind: "absolute", local, zone: "UTC", disambiguation: "reject" },
            channels,
            overrideQuiet: false,
          },
        ],
      },
    });
  }
  it.each(["local", "trigger"] as const)(
    "delivers once through the %s executor with only encrypted persisted content",
    async (executor) => {
      await schedule();
      env.clock += 3600000;
      await env.db.run(
        sql("UPDATE executor_state SET mode=:mode", {
          mode: executor === "trigger" ? "durable" : "local",
        }),
      );
      expect(await scanner().run({ executor, generation: 1 })).toEqual({
        occurrenceCount: 1,
        acceptedCount: 1,
      });
      await scanner().run({ executor, generation: 1 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      const rows = await env.db.all(sql("SELECT * FROM notification_outbox"));
      expect(rows[0]?.status).toBe("accepted");
      expect(rows[0]?.payload_enc).toMatch(/^sym1\./);
      expect(JSON.stringify(rows)).not.toContain("receiver");
      expect((await notifications.list(owner)).items[0]?.title).toBe("PRIVATE REMINDER MARKER");
      expect(JSON.stringify(await env.db.all(sql("SELECT * FROM notifications")))).not.toContain(
        "PRIVATE",
      );
    },
  );
  it("duplicate scanners claim one occurrence and one provider send", async () => {
    await schedule();
    env.clock += 3600000;
    await Promise.all([
      scanner().run({ executor: "local", generation: 1 }),
      scanner().run({ executor: "local", generation: 1 }),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await env.count("notifications")).toBe(1);
  });
  it("the wrong executor/generation and a mode switch before provider dispatch send nothing", async () => {
    await schedule();
    env.clock += 3600000;
    expect(await scanner().run({ executor: "trigger", generation: 1 })).toEqual({
      occurrenceCount: 0,
      acceptedCount: 0,
    });
    await scanner().run({ executor: "local", generation: 2 });
    expect(send).not.toHaveBeenCalled();
    await scanner({
      notify: async () => {
        await env.db.run(sql("UPDATE executor_state SET generation=2,mode='durable'"));
      },
    }).run({ executor: "local", generation: 1 });
    expect(send).not.toHaveBeenCalled();
  });
  it("restriction between planning and writing suppresses access", async () => {
    await schedule();
    env.clock += 3600000;
    await scanner({
      renderEmail: async ({ occurrenceId }) => {
        await env.relock(owner);
        return {
          to: "x@example.test",
          subject: "Reminder",
          html: "<p>Reminder</p>",
          text: "Reminder",
          sender: "reminders",
          idempotencyKey: `reminder/${occurrenceId}/email`,
        };
      },
    }).run({ executor: "local", generation: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(await env.count("notifications")).toBe(0);
    expect((await env.db.first(sql("SELECT status FROM reminder_occurrences")))?.status).toBe(
      "suppressed_access",
    );
  });
  it("quiet hours persist a silent notification, defer mail and emit one end-of-window summary", async () => {
    await schedule("2026-09-15T23:00");
    env.clock = Date.parse("2026-09-15T23:00Z");
    await scanner().run({ executor: "local", generation: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect((await notifications.list(owner)).items[0]?.quiet).toBe(true);
    env.clock = Date.parse("2026-09-16T08:00Z");
    await scanner().run({ executor: "local", generation: 1 });
    await scanner().run({ executor: "local", generation: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(summary).toHaveBeenCalledExactlyOnceWith(owner, 1);
  });
  it("disabling reminders cancels work and re-enabling does not revive it", async () => {
    await schedule();
    env.clock += 3600000;
    await scanner({ remindersEnabled: false }).run({ executor: "local", generation: 1 });
    await scanner().run({ executor: "local", generation: 1 });
    expect(send).not.toHaveBeenCalled();
    expect((await env.db.first(sql("SELECT status FROM reminder_occurrences")))?.status).toBe(
      "cancelled",
    );
  });
  it("expired occurrences do not send email", async () => {
    await schedule();
    env.clock += 26 * 3600000;
    await scanner().run({ executor: "local", generation: 1 });
    expect(send).not.toHaveBeenCalled();
    expect((await env.db.first(sql("SELECT status FROM reminder_occurrences")))?.status).toBe(
      "expired",
    );
  });
  it("retries unknown acceptance with the same immutable payload and stable provider key", async () => {
    const unstable = vi
      .fn()
      .mockRejectedValueOnce(new Error("PROVIDER PRIVATE ERROR"))
      .mockResolvedValueOnce({ providerId: "resend-ok" });
    await schedule();
    env.clock += 3600000;
    await scanner({ email: { send: unstable } }).run({ executor: "local", generation: 1 });
    env.clock += 3600000;
    await scanner({ email: { send: unstable } }).run({ executor: "local", generation: 1 });
    expect(unstable).toHaveBeenCalledTimes(2);
    expect(unstable.mock.calls[0]).toEqual(unstable.mock.calls[1]);
    expect(
      JSON.stringify(await env.db.all(sql("SELECT * FROM notification_outbox"))),
    ).not.toContain("PRIVATE ERROR");
  });
});
