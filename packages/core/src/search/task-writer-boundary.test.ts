import { taskNodeSchema } from "@symplist/contracts";
import { zeroize } from "@symplist/crypto";
import { expect, it, vi } from "vitest";
import { TaskService } from "../tasks/service.ts";
import { createSearchTestStore, insertOwner, ownerKey } from "./harness.test-support.ts";
import { D1SearchTaskSource } from "./sources/tasks.ts";

it("decrypts a workspace-created title through both search read paths using the writer's AAD", async () => {
  const store = await createSearchTestStore();
  try {
    const owner = await insertOwner(store, "writer@example.test");
    const tasks = new TaskService({
      db: store.db,
      keys: store.keys,
      policy: { betaAccessRequired: true },
      now: () => store.now,
    });
    const result = await tasks.create({
      ownerId: owner,
      actor: { kind: "user" },
      collection: "now",
      title: "Find this workspace-created title",
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("Task creation failed");
    const task = taskNodeSchema.parse((result.body as { task: unknown }).task);
    const key = await ownerKey(store, owner);
    try {
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const source = new D1SearchTaskSource(store.db, log);
      const direct = await source.readTasks(owner, [task.id], key);
      expect(direct.get(task.id)?.title).toBe("Find this workspace-created title");
      const scan = await source.listTasks(owner, { after: null, limit: 50 }, key);
      expect(scan.map((record) => record.title)).toEqual(["Find this workspace-created title"]);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      zeroize(key.key);
    }
  } finally {
    store.close();
  }
});
