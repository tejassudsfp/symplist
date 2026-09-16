import { taskCreateResponseSchema } from "@symplist/contracts";
import { uuidv7 } from "@symplist/db";
import { expect, it, vi } from "vitest";
import { bootTestApp } from "../../../test/harness.ts";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { TopicHub } from "../realtime/topic-hub.ts";

it("treats worker schedule events as owner-scoped hints and reloads the canonical version", async () => {
  const app = await bootTestApp();
  try {
    const owner = await app.createSignedInUser();
    const other = await app.createSignedInUser();
    const created = await app.post("/v1/tasks", {
      session: owner.session,
      idempotencyKey: "schedule-event-task",
      body: { title: "Owned task", collection: "now" },
    });
    expect(created.status).toBe(201);
    const taskId = taskCreateResponseSchema.parse(created.json()).task.id;
    const handler = app.app.get(InternalEventHandlerRegistry).get("schedule.changed");
    if (!handler) throw new Error("Missing production schedule handler");
    const publish = vi.spyOn(app.app.get(TopicHub), "publishToUser").mockResolvedValue();
    const event = {
      id: uuidv7(),
      type: "schedule.changed",
      ownerId: owner.id,
      occurredAt: app.clock.now(),
      payload: { taskId, version: 99999 },
    };
    await handler.handle(event);
    expect(publish).toHaveBeenCalledExactlyOnceWith(owner.id, {
      type: "schedule.changed",
      data: { taskId, version: 0 },
    });
    publish.mockClear();
    await expect(handler.handle({ ...event, ownerId: other.id })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(publish).not.toHaveBeenCalled();
    await handler.handle({ ...event, payload: {} });
    expect(publish).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await app.close();
  }
});
