import { schedulingSnapshotSchema, taskCreateResponseSchema } from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture() {
  const app = await bootTestApp();
  apps.push(app);
  const user = await app.createSignedInUser("admitted");
  const created = await app.post("/v1/tasks", {
    session: user.session,
    idempotencyKey: "create-scheduling-task",
    body: { title: "Refresh my portfolio", collection: "now" },
  });
  expect(created.status, created.text).toBe(201);
  const task = taskCreateResponseSchema.parse(created.json()).task.id;
  return { app, user, task };
}
const schedule = {
  baseVersion: 0,
  deadline: { kind: "date", date: "2026-09-17", zone: "Asia/Kathmandu" },
  reminders: [
    {
      rule: { kind: "calendar", daysBefore: 0, hour: 9 },
      channels: ["in_app"],
      overrideQuiet: false,
    },
  ],
};

describe("scheduling HTTP contract", () => {
  it("saves, previews, reads summaries/calendar and replays the folded idempotent response", async () => {
    const { app, user, task } = await fixture();
    const saved = await app.request("PUT", `/v1/tasks/${task}/schedule`, {
      session: user.session,
      idempotencyKey: "save-scheduling-request",
      body: schedule,
    });
    expect(saved.status, saved.text).toBe(200);
    expect(schedulingSnapshotSchema.parse(saved.json()).version).toBe(1);
    const retry = await app.request("PUT", `/v1/tasks/${task}/schedule`, {
      session: user.session,
      idempotencyKey: "save-scheduling-request",
      body: schedule,
    });
    expect(retry.status, retry.text).toBe(200);
    expect(retry.json()).toEqual(saved.json());
    const preview = await app.post("/v1/schedules/preview", {
      session: user.session,
      body: schedule,
    });
    expect(preview.status, preview.text).toBe(200);
    const summaries = await app.get(`/v1/schedule-summaries?ids=${task}`, {
      session: user.session,
    });
    expect(summaries.status, summaries.text).toBe(200);
    expect(summaries.json()).toMatchObject([{ taskId: task, version: 1 }]);
    const calendar = await app.get("/v1/calendar?from=2026-09-01&to=2026-09-30&zone=UTC", {
      session: user.session,
    });
    expect(calendar.status, calendar.text).toBe(200);
    expect(calendar.json()).toMatchObject({
      items: [{ taskId: task, title: "Refresh my portfolio" }],
    });
    expect((await app.get("/v1/notifications", { session: user.session })).json()).toEqual({
      items: [],
      unreadCount: 0,
      nextCursor: null,
    });
  });
  it("refuses CSRF, no origin, foreign users, stale edits and reused keys with changed content", async () => {
    const { app, user, task } = await fixture();
    for (const options of [{ csrf: null }, { origin: null }, { origin: "https://evil.example" }]) {
      const response = await app.request("PUT", `/v1/tasks/${task}/schedule`, {
        session: user.session,
        idempotencyKey: "csrf-schedule-request",
        body: schedule,
        ...options,
      });
      expect(response.status).toBe(403);
    }
    const stranger = await app.createSignedInUser("admitted");
    expect(
      (await app.get(`/v1/tasks/${task}/schedule`, { session: stranger.session })).status,
    ).toBe(404);
    expect(
      (
        await app.request("PUT", `/v1/tasks/${task}/schedule`, {
          session: user.session,
          idempotencyKey: "first-schedule-request",
          body: schedule,
        })
      ).status,
    ).toBe(200);
    const conflict = await app.request("PUT", `/v1/tasks/${task}/schedule`, {
      session: user.session,
      idempotencyKey: "other-schedule-request",
      body: schedule,
    });
    expect(conflict.status, conflict.text).toBe(409);
    const mismatch = await app.request("PUT", `/v1/tasks/${task}/schedule`, {
      session: user.session,
      idempotencyKey: "first-schedule-request",
      body: { ...schedule, deadline: null, reminders: [] },
    });
    expect(mismatch.status, mismatch.text).toBe(422);
  });
  it("saves notification preferences with conflict detection and never exposes analytics or keys", async () => {
    const { app, user } = await fixture();
    const original = await app.get("/v1/notification-preferences", { session: user.session });
    expect(original.status).toBe(200);
    const entry = original.json<{ version: number; data: Record<string, unknown> }>();
    const response = await app.request("PUT", "/v1/notification-preferences", {
      session: user.session,
      idempotencyKey: "notification-prefs-save",
      body: {
        baseVersion: entry.version,
        data: { ...entry.data, zone: "Asia/Kathmandu", email: true },
      },
    });
    expect(response.status, response.text).toBe(200);
    expect(response.text).not.toContain("analytics");
    expect(response.text).not.toContain("sym1");
    const denied = await app.createSignedInUser("relocked");
    expect(
      (await app.get("/v1/notification-preferences", { session: denied.session })).status,
    ).toBe(403);
  });
  it("unset Resend webhook returns 404 without receipts and warns once", async () => {
    const { app } = await fixture();
    const response = await app.post("/webhooks/resend", {
      body: { type: "email.delivered", private: "PRIVATE_WEBHOOK" },
    });
    expect(response.status, response.text).toBe(404);
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM webhook_receipts"))).toEqual({ n: 0 });
    expect(app.logs.events("email.delivery_tracking_disabled")).toHaveLength(1);
    expect(app.logs.text()).not.toContain("PRIVATE_WEBHOOK");
    expect((await app.post("/v1/webhooks/resend", { body: {} })).status).toBe(404);
  });
});
