import { schedulingDefaultPreferences } from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { NotificationsService } from "./notifications.ts";
import { SchedulingService } from "./service.ts";
import { type SchedulingToolActor, taskScheduleTool } from "./tools.ts";

describe("the authenticated task_schedule seam", () => {
  let env: DocumentsTestEnvironment;
  let service: SchedulingService;
  let actor: SchedulingToolActor;
  let task: string;
  beforeEach(async () => {
    env = await createDocumentsTestEnvironment();
    const ownerId = await env.createUser();
    task = await env.createTask(ownerId);
    service = new SchedulingService({
      db: env.db,
      keys: env.keys,
      policy: { betaAccessRequired: true },
      now: () => env.clock,
    });
    actor = {
      kind: "simon",
      ownerId,
      requestId: "tool-request",
      taskIds: [task],
      scopes: [],
      guards: [{ sql: "1=1", params: {} }],
    };
  });
  afterEach(async () => env.close());
  const reminder = {
    rule: {
      kind: "absolute",
      local: "2026-09-17T09:00",
      zone: "UTC",
      disambiguation: "reject",
    } as const,
    channels: ["in_app"] as "in_app"[],
    overrideQuiet: false,
  };
  it("replays an exact add before re-planning, even after it is due, without duplicate output", async () => {
    const input = {
      operation: "add_reminder",
      taskId: task,
      expectedVersion: 0,
      reminder,
    } as const;
    const first = await taskScheduleTool(service, actor, input);
    env.clock += 4 * 86400000;
    expect(await taskScheduleTool(service, actor, input)).toEqual(first);
    expect(await env.count("reminders")).toBe(1);
    expect(await env.count("reminder_occurrences")).toBe(1);
    const audit = await env.db.first(
      sql("SELECT fingerprint_enc,response_enc FROM schedule_audit"),
    );
    expect(audit?.response_enc).toMatch(/^sym1\./);
    expect(JSON.stringify(audit)).not.toContain("absolute");
  });
  it("replays cancel after the reminder disappears and refuses changing the same request", async () => {
    const first = await taskScheduleTool(service, actor, {
      operation: "add_reminder",
      taskId: task,
      expectedVersion: 0,
      reminder,
    });
    const cancel = {
      operation: "cancel_reminder",
      taskId: task,
      expectedVersion: 1,
      reminderId: first.reminders[0]?.id ?? "",
    } as const;
    const cancelling = { ...actor, requestId: "cancel" };
    const result = await taskScheduleTool(service, cancelling, cancel);
    expect(result.reminders).toEqual([]);
    expect(await taskScheduleTool(service, cancelling, cancel)).toEqual(result);
    await expect(
      taskScheduleTool(service, cancelling, { ...cancel, expectedVersion: 2 }),
    ).rejects.toThrow("idempotency.mismatch");
  });
  it("rejects missing guards, foreign task scope, read-only MCP writes and revoked guards", async () => {
    const input = {
      operation: "add_reminder",
      taskId: task,
      expectedVersion: 0,
      reminder,
    } as const;
    for (const invalid of [
      { ...actor, guards: [] },
      { ...actor, taskIds: [] },
      { ...actor, kind: "mcp" as const, scopes: ["tasks:read"] },
      { ...actor, guards: [{ sql: "0=1", params: {} }] },
    ]) {
      await expect(taskScheduleTool(service, invalid, input)).rejects.toThrow("not_found");
    }
    expect(await env.count("reminders")).toBe(0);
    await taskScheduleTool(service, actor, input);
    await env.relock(actor.ownerId);
    await expect(taskScheduleTool(service, actor, input)).rejects.toThrow("not_found");
  });
  it("requires confirmation when clearing relative reminders but preserves standalone ones", async () => {
    const initial = await service.save({
      ownerId: actor.ownerId,
      taskId: task,
      actor: "user",
      requestId: "setup",
      data: {
        baseVersion: 0,
        deadline: { kind: "date", date: "2026-09-17", zone: "UTC" },
        reminders: [reminder, { ...reminder, rule: { kind: "calendar", daysBefore: 0, hour: 9 } }],
      },
    });
    await expect(
      taskScheduleTool(service, actor, {
        operation: "clear_deadline",
        taskId: task,
        expectedVersion: initial.version,
        removeRelativeReminders: false,
      }),
    ).rejects.toThrow("schedule.deadline_required");
    const result = await taskScheduleTool(service, actor, {
      operation: "clear_deadline",
      taskId: task,
      expectedVersion: initial.version,
      removeRelativeReminders: true,
    });
    expect(result.deadline).toBeNull();
    expect(result.reminders).toHaveLength(1);
    expect(result.reminders[0]?.rule.kind).toBe("absolute");
  });
  it("turning a mixed channel off and on cannot revive it and invalidates stale schedule editors", async () => {
    const notifications = new NotificationsService(service);
    await notifications.savePreferences(actor.ownerId, 0, {
      ...schedulingDefaultPreferences,
      email: true,
    });
    await service.save({
      ownerId: actor.ownerId,
      taskId: task,
      actor: "user",
      requestId: "mixed",
      data: {
        baseVersion: 0,
        deadline: null,
        reminders: [{ ...reminder, channels: ["in_app", "email"] }],
      },
    });
    await notifications.savePreferences(actor.ownerId, 1, {
      ...schedulingDefaultPreferences,
      email: false,
    });
    await notifications.savePreferences(actor.ownerId, 2, {
      ...schedulingDefaultPreferences,
      email: true,
    });
    const current = await service.get(actor.ownerId, task);
    expect(current.version).toBe(2);
    expect(current.reminders[0]?.channels).toEqual(["in_app"]);
    await notifications.savePreferences(actor.ownerId, 3, {
      ...schedulingDefaultPreferences,
      inApp: false,
      email: false,
    });
    await notifications.savePreferences(actor.ownerId, 4, {
      ...schedulingDefaultPreferences,
      inApp: true,
      email: true,
    });
    expect((await service.get(actor.ownerId, task)).reminders).toEqual([]);
    expect((await env.db.first(sql("SELECT status FROM reminder_occurrences")))?.status).toBe(
      "cancelled",
    );
  });
});
