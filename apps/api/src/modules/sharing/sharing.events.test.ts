import { documentPublishResponseSchema, sharingArtifactSchema } from "@symplist/contracts";
import { int, sql, uuidv7 } from "@symplist/db";
import { expect, it, vi } from "vitest";
import { bootTestApp } from "../../../test/harness.ts";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { TopicHub } from "../realtime/topic-hub.ts";

it("relays worker grant hints only after reloading canonical owner-authorized artifact identity", async () => {
  const app = await bootTestApp();
  try {
    const owner = await app.createSignedInUser();
    const other = await app.createSignedInUser();
    const taskId = uuidv7();
    await app.db.run(
      sql(
        `INSERT INTO tasks (id,owner_id,collection,position,source,write_id,title_enc,created_at,updated_at)
      VALUES (:id,:owner,'now','a0','user',:write,'sym1.1.x.y',:now,:now)`,
        { id: taskId, owner: owner.id, write: uuidv7(), now: int(app.clock.now()) },
      ),
    );
    const saved = await app.post(`/v1/tasks/${taskId}/document/commits`, {
      session: owner.session,
      idempotencyKey: "sharing-event-source",
      body: { baseRevision: null, markdown: "# Source\nPrivate content" },
    });
    expect(saved.status, saved.text).toBe(201);
    const revision = documentPublishResponseSchema.parse(saved.json()).revision;
    const created = await app.post(`/v1/tasks/${taskId}/artifacts`, {
      session: owner.session,
      idempotencyKey: "sharing-event-artifact",
      body: { title: "Private title", revision },
    });
    expect(created.status, created.text).toBe(201);
    const artifactId = sharingArtifactSchema.parse(created.json()).id;
    const handler = app.app.get(InternalEventHandlerRegistry).get("share_grant.changed");
    if (!handler) throw new Error("Missing Sharing internal event registration");
    const publish = vi.spyOn(app.app.get(TopicHub), "publishToUser").mockResolvedValue();
    const event = {
      id: uuidv7(),
      type: "share_grant.changed",
      ownerId: owner.id,
      occurredAt: app.clock.now(),
      payload: { artifactId, taskId: uuidv7(), token: "UNTRUSTED-EVENT-SECRET" },
    };
    await handler.handle(event);
    expect(publish).toHaveBeenCalledExactlyOnceWith(owner.id, {
      type: "share_grant.changed",
      data: { taskId, artifactId },
    });
    publish.mockClear();
    await expect(handler.handle({ ...event, ownerId: other.id })).rejects.toMatchObject({
      code: "not_found",
    });
    await handler.handle({ ...event, payload: {} });
    await handler.handle({ ...event, payload: { artifactId: 42 } });
    expect(publish).not.toHaveBeenCalled();
    await app.db.run(
      sql(
        "UPDATE users SET beta_state='relocked',access_generation=access_generation+1 WHERE id=:id",
        { id: owner.id },
      ),
    );
    await expect(handler.handle(event)).rejects.toMatchObject({ code: "not_found" });
    expect(publish).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await app.close();
  }
});
