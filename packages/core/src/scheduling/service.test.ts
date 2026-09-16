import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SchedulingService } from "./service.ts";

describe("authorized scheduling persistence", () => {
  let env: DocumentsTestEnvironment;
  let service: SchedulingService;
  let owner: string;
  let task: string;
  beforeEach(async () => {
    env = await createDocumentsTestEnvironment();
    owner = await env.createUser();
    task = await env.createTask(owner);
    service = new SchedulingService({
      db: env.db,
      keys: env.keys,
      policy: { betaAccessRequired: true },
      now: () => env.clock,
    });
  });
  afterEach(async () => {
    await env.close();
  });
  const data = () => ({
    baseVersion: 0,
    deadline: { kind: "date", date: "2026-09-17", zone: "Asia/Kathmandu" } as const,
    reminders: [
      {
        rule: { kind: "calendar", daysBefore: 0, hour: 9 } as const,
        channels: ["in_app"] as "in_app"[],
        overrideQuiet: false,
      },
    ],
  });
  const save = (requestId = "request-one") =>
    service.save({ ownerId: owner, taskId: task, actor: "user", requestId, data: data() });
  it("starts without a deadline and persists encrypted audit and local scheduling metadata", async () => {
    expect(await service.get(owner, task)).toMatchObject({
      version: 0,
      deadline: null,
      reminders: [],
    });
    expect(await save()).toMatchObject({
      version: 1,
      deadline: data().deadline,
      reminders: [{ intendedAt: Date.parse("2026-09-17T03:15Z") }],
    });
    expect((await service.get(owner, task)).reminders).toHaveLength(1);
    const audit = await env.db.first(sql("SELECT * FROM schedule_audit"));
    expect(audit?.fingerprint_enc).toMatch(/^sym1\./);
    expect(JSON.stringify(audit)).not.toContain("Kathmandu");
    expect(await env.count("reminder_occurrences")).toBe(1);
  });
  it("exact mutation retry adds no occurrence, different content rejects", async () => {
    await save();
    await save();
    expect(await env.count("reminder_occurrences")).toBe(1);
    await expect(
      service.save({
        ownerId: owner,
        taskId: task,
        actor: "user",
        requestId: "request-one",
        data: { ...data(), deadline: null },
      }),
    ).rejects.toThrow("idempotency.mismatch");
  });
  it("concurrent saves have one winner and preserve task identity/collection", async () => {
    const outcomes = await Promise.allSettled([save("a"), save("b")]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await env.count("reminder_occurrences")).toBe(1);
    expect(
      await env.db.first(sql("SELECT id,collection FROM tasks WHERE id=:id", { id: task })),
    ).toEqual({ id: task, collection: "now" });
  });
  it("rejects foreign task, archived task, and restricted owner", async () => {
    const stranger = await env.createUser();
    await expect(service.get(stranger, task)).rejects.toThrow("not_found");
    await env.archiveTask(task);
    await expect(save()).rejects.toThrow("schedule.conflict");
    await env.relock(owner);
    await expect(service.get(owner, task)).rejects.toThrow("not_found");
  });
  it("cancel-and-replace fences old occurrences while standalone reminders survive clearing a deadline", async () => {
    await save();
    const result = await service.save({
      ownerId: owner,
      taskId: task,
      actor: "simon",
      requestId: "two",
      data: {
        baseVersion: 1,
        deadline: null,
        reminders: [
          {
            rule: {
              kind: "absolute",
              local: "2026-09-18T10:00",
              zone: "UTC",
              disambiguation: "reject",
            },
            channels: ["in_app"],
            overrideQuiet: false,
          },
        ],
      },
    });
    expect(result.deadline).toBeNull();
    expect(
      (await env.db.all(sql("SELECT status FROM reminder_occurrences ORDER BY intended_at"))).map(
        (row) => row.status,
      ),
    ).toEqual(["cancelled", "pending"]);
  });
  it("rejects past times and email without explicit preference", async () => {
    await expect(
      service.save({
        ownerId: owner,
        taskId: task,
        actor: "user",
        requestId: "past",
        data: {
          ...data(),
          reminders: [
            {
              rule: {
                kind: "absolute",
                local: "2026-09-15T08:00",
                zone: "UTC",
                disambiguation: "reject",
              },
              channels: ["in_app"],
              overrideQuiet: false,
            },
          ],
        },
      }),
    ).rejects.toThrow("schedule.past_reminder");
    await expect(
      service.save({
        ownerId: owner,
        taskId: task,
        actor: "user",
        requestId: "email",
        data: {
          ...data(),
          reminders: [
            {
              rule: { kind: "calendar", daysBefore: 0, hour: 9 },
              overrideQuiet: false,
              channels: ["email"],
            },
          ],
        },
      }),
    ).rejects.toThrow("schedule.channel_disabled");
  });
  it("does not block an unrelated edit while an unchanged saved reminder awaits its scan", async () => {
    const original = await save();
    env.clock = Date.parse("2026-09-17T04:00Z");
    const reminders = original.reminders.map(({ id, rule, channels, overrideQuiet }) => ({
      id,
      rule,
      channels,
      overrideQuiet,
    }));
    const result = await service.save({
      ownerId: owner,
      taskId: task,
      actor: "user",
      requestId: "unchanged-overdue",
      data: { baseVersion: original.version, deadline: original.deadline, reminders },
    });
    expect(result.version).toBe(2);
    expect(result.reminders[0]?.intendedAt).toBe(original.reminders[0]?.intendedAt);
    await expect(
      service.save({
        ownerId: owner,
        taskId: task,
        actor: "user",
        requestId: "changed-overdue",
        data: {
          baseVersion: result.version,
          deadline: result.deadline,
          reminders: reminders.map((reminder) => ({ ...reminder, overrideQuiet: true })),
        },
      }),
    ).rejects.toThrow("schedule.past_reminder");
  });
});
