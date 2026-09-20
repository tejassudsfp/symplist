import { SharingRepository } from "@symplist/core/sharing";
import { sql, uuidv7 } from "@symplist/db";
import { expect, it, vi } from "vitest";
import { createDocumentsTestEnvironment } from "../../../../../packages/core/src/documents/test-support.ts";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { SharingEvents } from "./sharing.events.ts";

it("registers a canonical id-only relay and fences foreign, missing, deleted and relocked artifacts", async () => {
  const env = await createDocumentsTestEnvironment();
  try {
    const owner = await env.createUser();
    const other = await env.createUser();
    const task = await env.createTask(owner);
    const revision = String(
      (
        await env.tools.updateSection(env.simon(owner, task), {
          taskId: task,
          expectedRevision: null,
          placement: "end",
          markdown: "# Private source\nPrivate content",
        })
      ).revision,
    );
    const repo = new SharingRepository({
      db: env.db,
      objects: env.objects,
      keys: env.keys,
      now: () => env.clock,
      policy: { betaAccessRequired: true },
      artifactOrigin: "https://share.example.test",
    });
    const artifact = await repo.snapshot(
      env.user(owner),
      task,
      { revision, sectionIds: [], title: "Private title" },
      "event-artifact",
    );
    const registry = new InternalEventHandlerRegistry();
    const publishToUser = vi.fn(async () => {});
    new SharingEvents(repo, registry, {
      publish: vi.fn(),
      publishToConversation: vi.fn(),
      publishToUser,
    }).onModuleInit();
    const handler = registry.get("share_grant.changed");
    if (!handler) throw new Error("Missing grant handler");
    const event = {
      id: uuidv7(),
      type: "share_grant.changed",
      ownerId: owner,
      occurredAt: env.clock,
      payload: { artifactId: artifact.id, taskId: uuidv7(), token: "UNTRUSTED-SECRET-MARKER" },
    };
    await handler.handle(event);
    expect(publishToUser).toHaveBeenCalledExactlyOnceWith(owner, {
      type: "share_grant.changed",
      data: { taskId: task, artifactId: artifact.id },
    });
    publishToUser.mockClear();
    await expect(handler.handle({ ...event, ownerId: other })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      handler.handle({ ...event, payload: { artifactId: uuidv7() } }),
    ).rejects.toMatchObject({ code: "not_found" });
    await handler.handle({ ...event, payload: {} });
    await handler.handle({ ...event, payload: { artifactId: false } });
    await env.db.run(
      sql("UPDATE artifacts SET deleted_at=:now WHERE id=:id", {
        now: String(env.clock),
        id: artifact.id,
      }),
    );
    await expect(handler.handle(event)).rejects.toMatchObject({ code: "not_found" });
    await env.db.run(sql("UPDATE artifacts SET deleted_at=NULL WHERE id=:id", { id: artifact.id }));
    await env.relock(owner);
    await expect(handler.handle(event)).rejects.toMatchObject({ code: "not_found" });
    expect(publishToUser).not.toHaveBeenCalled();
  } finally {
    await env.close();
  }
});
