import type { TaskId } from "@symplist/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { TaskStore } from "./task-store.ts";
import { FakeWorkspaceApi } from "./test-support.tsx";

function seeded() {
  const api = new FakeWorkspaceApi([
    { id: "portfolio", title: "Refresh my portfolio" },
    { id: "pick", title: "Pick five projects to feature", parentId: "portfolio" },
    { id: "outline", title: "Send the project outline" },
    { id: "weekend", title: "Plan a quiet weekend", collection: "later" },
  ]);
  return { api, store: new TaskStore(api) };
}

const titles = (store: TaskStore, collection: "now" | "later" | "unclassified" = "now") =>
  store.collection(collection).tasks.map((task) => task.title);

describe("TaskStore", () => {
  it("loads a collection once and reports its status", async () => {
    const { store, api } = seeded();
    expect(store.collection("now").status).toBe("idle");
    store.ensureCollection("now");
    store.ensureCollection("now");
    await vi.waitFor(() => expect(store.collection("now").status).toBe("ready"));
    expect(titles(store)).toEqual([
      "Refresh my portfolio",
      "Pick five projects to feature",
      "Send the project outline",
    ]);
    expect(api.calls.filter((call) => call.method === "listTasks")).toHaveLength(1);
  });

  it("keeps a failed load explained, and recovers on retry", async () => {
    const { store, api } = seeded();
    api.fail("listTasks");
    await store.refresh("now");
    expect(store.collection("now").status).toBe("error");
    expect(store.collection("now").failure?.kind).toBe("busy");
    await store.refresh("now");
    expect(store.collection("now").status).toBe("ready");
  });

  it("shows a created task, a rename and a move at once and keeps them until the tree catches up", async () => {
    const { store } = seeded();
    await store.refresh("now");
    await store.create({ title: "Book a bike tune-up", collection: "now" }, "key-create");
    expect(titles(store)).toContain("Book a bike tune-up");

    await store.rename("outline", "Send the outline", "key-rename");
    expect(titles(store)).toContain("Send the outline");

    await store.refresh("later");
    await store.move(
      "outline",
      { collection: "later" },
      { collection: "later", parentId: null },
      "key-move",
    );
    expect(titles(store)).not.toContain("Send the outline");
    expect(titles(store, "later")).toContain("Send the outline");
  });

  it("puts a task back when the write is refused", async () => {
    const { store, api } = seeded();
    await store.refresh("now");
    api.fail("moveTask");
    await expect(
      store.move(
        "outline",
        { collection: "later" },
        { collection: "later", parentId: null },
        "key-move",
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(titles(store)).toContain("Send the project outline");
  });

  it("hides a completed task and its subtasks, and brings them back on Undo", async () => {
    const { store } = seeded();
    await store.refresh("now");
    const subtree = store.collection("now").tasks.filter((task) => task.id === "portfolio");
    const response = await store.complete(
      "portfolio",
      { mode: "all", stopRun: false },
      "key-complete",
    );
    expect(response.archivedTaskIds).toHaveLength(2);
    expect(titles(store)).toEqual(["Send the project outline"]);

    await store.restore("portfolio", "key-restore", {
      subtree,
      placement: { collection: "now", parentId: null },
    });
    await vi.waitFor(() => expect(titles(store)).toContain("Refresh my portfolio"));
  });

  it("promotes the subtasks of a parent completed on its own", async () => {
    const { store } = seeded();
    await store.refresh("now");
    await store.complete("portfolio", { mode: "parent_only", stopRun: false }, "key-parent-only");
    await vi.waitFor(() =>
      expect(titles(store)).toEqual(["Pick five projects to feature", "Send the project outline"]),
    );
  });

  it("refetches the lists a newer tree version touched", async () => {
    const { store, api } = seeded();
    await store.refresh("now");
    api.seed({ id: "walk", title: "Take a long walk" });
    store.noteTreeVersion(999);
    await vi.waitFor(() => expect(titles(store)).toContain("Take a long walk"));
  });

  it("loads a task's detail and forgets it when the task is gone", async () => {
    const { store } = seeded();
    await store.refreshDetail("pick");
    expect(store.detail("pick").detail?.task.title).toBe("Pick five projects to feature");
    expect(store.detail("pick").detail?.ancestors.map((task) => task.title)).toEqual([
      "Refresh my portfolio",
    ]);
    await store.refreshDetail("01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a" as TaskId);
    const missing = store.detail("01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a");
    expect(missing.status).toBe("error");
    expect(missing.failure?.kind).toBe("not_found");
    expect(missing.detail).toBeNull();
  });
});
