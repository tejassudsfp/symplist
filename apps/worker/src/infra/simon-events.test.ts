import { announceTaskTreeCommitted } from "@symplist/core/tasks";
import { createLocalSqliteClient } from "@symplist/db";
import { expect, it, vi } from "vitest";
import { simonTaskAnnouncements } from "./simon-events.ts";

it("announces once per runtime, bounds task ids and waits for pending delivery", async () => {
  const db = createLocalSqliteClient({ path: ":memory:", env: {} });
  try {
    let resolve!: (value: "delivered") => void;
    const announce = vi.fn(
      () =>
        new Promise<"delivered">((done) => {
          resolve = done;
        }),
    );
    const runtime = { db, events: { announce }, logger: { warn: vi.fn() } };
    const flush = simonTaskAnnouncements(runtime);
    simonTaskAnnouncements(runtime);
    announceTaskTreeCommitted(db, {
      ownerId: "owner",
      taskTreeVersion: 8,
      taskIds: Array.from({ length: 150 }, (_, i) => `task-${i}`),
    });
    expect(announce).toHaveBeenCalledExactlyOnceWith({
      type: "task_tree.changed",
      ownerId: "owner",
      payload: { taskTreeVersion: 8, taskIds: Array.from({ length: 100 }, (_, i) => `task-${i}`) },
    });
    let finished = false;
    const waiting = flush().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    resolve("delivered");
    await waiting;
    expect(finished).toBe(true);
    await flush();
    expect(announce).toHaveBeenCalledOnce();
  } finally {
    db.close();
  }
});

it("never leaks a transport error or turns an already committed task into a failure", async () => {
  const db = createLocalSqliteClient({ path: ":memory:", env: {} });
  try {
    const warn = vi.fn();
    const runtime = {
      db,
      events: {
        announce: vi.fn(async (): Promise<"delivered"> => {
          throw new Error("PRIVATE-transport-marker");
        }),
      },
      logger: { warn },
    };
    const flush = simonTaskAnnouncements(runtime);
    announceTaskTreeCommitted(db, { ownerId: "owner", taskTreeVersion: 1, taskIds: [] });
    await expect(flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith("simon.announce_failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE-transport-marker");
  } finally {
    db.close();
  }
});
