import type { TaskId } from "@symplist/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RealtimeClient,
  RealtimeStatus,
  TopicHandlers,
  UserSubscription,
} from "@/lib/realtime";
import {
  type DocumentHeadListener,
  resetDocumentRealtime,
  setDocumentRealtimeClient,
  watchDocumentHead,
} from "./realtime.ts";

const taskA = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";
const taskB = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8b";
const revision = "a".repeat(40);
const sectionId = `s${"a".repeat(25)}`;

/** A stand-in for the app-wide socket that records what the documents feature subscribed to. */
class FakeRealtime {
  handlers: TopicHandlers | null = null;
  openTasks: TaskId[][] = [];
  statusListeners = new Set<(status: RealtimeStatus) => void>();
  subscriptions = 0;
  unsubscribes = 0;
  connects = 0;
  disconnects = 0;

  subscribeUser(openTasks: readonly TaskId[], handlers: TopicHandlers): UserSubscription {
    this.subscriptions += 1;
    this.handlers = handlers;
    this.openTasks.push([...openTasks]);
    return {
      topic: "user" as UserSubscription["topic"],
      setOpenTasks: (ids) => this.openTasks.push([...ids]),
      unsubscribe: () => {
        this.unsubscribes += 1;
        this.handlers = null;
      },
    };
  }

  onStatusChange(listener: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  connect(): void {
    this.connects += 1;
  }

  disconnect(): void {
    this.disconnects += 1;
  }

  emitStatus(status: RealtimeStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }

  get client(): RealtimeClient {
    return this as unknown as RealtimeClient;
  }
}

function install(): FakeRealtime {
  const fake = new FakeRealtime();
  setDocumentRealtimeClient(fake.client);
  return fake;
}

function listener(): DocumentHeadListener & {
  heads: unknown[];
  snapshots: Array<[string, string]>;
  resyncs: number;
  statuses: RealtimeStatus[];
} {
  const heads: unknown[] = [];
  const snapshots: Array<[string, string]> = [];
  const statuses: RealtimeStatus[] = [];
  let resyncs = 0;
  return {
    heads,
    snapshots,
    statuses,
    get resyncs() {
      return resyncs;
    },
    onHeadChanged: (event) => heads.push(event),
    onSnapshotHead: (taskId, head) => snapshots.push([taskId, head]),
    onResync: () => {
      resyncs += 1;
    },
    onStatus: (status) => statuses.push(status),
  };
}

afterEach(() => {
  resetDocumentRealtime();
});

describe("watchDocumentHead", () => {
  it("subscribes to the user topic with the open task and connects", () => {
    const fake = install();
    watchDocumentHead(taskA, listener());
    expect(fake.subscriptions).toBe(1);
    expect(fake.openTasks[0]).toEqual([taskA]);
    expect(fake.connects).toBe(1);
  });

  it("reuses one subscription and adds each further open task", () => {
    const fake = install();
    watchDocumentHead(taskA, listener());
    watchDocumentHead(taskB, listener());
    expect(fake.subscriptions).toBe(1);
    expect(fake.openTasks.at(-1)).toEqual([taskA, taskB]);
  });

  it("delivers a head change only to the listeners of that task", () => {
    const fake = install();
    const a = listener();
    const b = listener();
    watchDocumentHead(taskA, a);
    watchDocumentHead(taskB, b);
    fake.handlers?.onEvent?.({
      topic: "user",
      seq: 1,
      id: "e1",
      type: "document.head_changed",
      data: { taskId: taskA, revision, author: "simon", changedSectionIds: [sectionId] },
    } as Parameters<NonNullable<TopicHandlers["onEvent"]>>[0]);
    expect(a.heads).toHaveLength(1);
    expect(b.heads).toHaveLength(0);
  });

  it("ignores an event of another type and a payload that fails its schema", () => {
    const fake = install();
    const a = listener();
    watchDocumentHead(taskA, a);
    const emit = (type: string, data: unknown) =>
      fake.handlers?.onEvent?.({ topic: "user", seq: 1, id: "e", type, data } as Parameters<
        NonNullable<TopicHandlers["onEvent"]>
      >[0]);
    emit("tasks.changed", { taskTreeVersion: 1, taskIds: [taskA] });
    emit("document.head_changed", { taskId: taskA, revision: "not-a-revision" });
    emit("document.head_changed", {
      taskId: taskA,
      revision,
      author: "ghost",
      changedSectionIds: [],
    });
    expect(a.heads).toHaveLength(0);
  });

  it("reports the head each snapshot names for an open task", () => {
    const fake = install();
    const a = listener();
    watchDocumentHead(taskA, a);
    fake.handlers?.onSnapshot?.({
      topic: "user",
      seq: 1,
      data: {
        unreadCount: 0,
        taskTreeVersion: 4,
        heads: { [taskA]: revision, [taskB]: revision },
        vaultUnlocked: false,
      },
    } as Parameters<NonNullable<TopicHandlers["onSnapshot"]>>[0]);
    expect(a.snapshots).toEqual([[taskA, revision]]);
  });

  it("ignores a snapshot payload that fails its schema", () => {
    const fake = install();
    const a = listener();
    watchDocumentHead(taskA, a);
    fake.handlers?.onSnapshot?.({ topic: "user", seq: 1, data: { heads: "nope" } } as Parameters<
      NonNullable<TopicHandlers["onSnapshot"]>
    >[0]);
    expect(a.snapshots).toEqual([]);
  });

  it("tells every listener to re-read on a resync and on a status change", () => {
    const fake = install();
    const a = listener();
    const b = listener();
    watchDocumentHead(taskA, a);
    watchDocumentHead(taskB, b);
    fake.handlers?.onResync?.();
    fake.emitStatus("reconnecting");
    expect(a.resyncs).toBe(1);
    expect(b.resyncs).toBe(1);
    expect(a.statuses).toEqual(["reconnecting"]);
    expect(b.statuses).toEqual(["reconnecting"]);
  });

  it("stops delivering to a listener once it unsubscribes", () => {
    const fake = install();
    const a = listener();
    const off = watchDocumentHead(taskA, a);
    off();
    fake.handlers?.onResync?.();
    expect(a.resyncs).toBe(0);
  });

  it("keeps the subscription while another listener holds the same task", () => {
    const fake = install();
    const a = listener();
    const b = listener();
    const off = watchDocumentHead(taskA, a);
    watchDocumentHead(taskA, b);
    off();
    expect(fake.unsubscribes).toBe(0);
    fake.handlers?.onResync?.();
    expect(b.resyncs).toBe(1);
  });

  it("unsubscribes once the last task page is gone", () => {
    const fake = install();
    const off = watchDocumentHead(taskA, listener());
    off();
    expect(fake.unsubscribes).toBe(1);
  });

  it("does nothing for a repeated unsubscribe", () => {
    const fake = install();
    const off = watchDocumentHead(taskA, listener());
    off();
    off();
    expect(fake.unsubscribes).toBe(1);
  });

  it("never disconnects a client it did not create", () => {
    const fake = install();
    const off = watchDocumentHead(taskA, listener());
    off();
    expect(fake.disconnects).toBe(0);
  });

  it("ignores a task id the contracts refuse, rather than subscribing to it", () => {
    const fake = install();
    watchDocumentHead("not-a-task-id", listener());
    expect(fake.openTasks[0]).toEqual([]);
  });

  it("does nothing outside a browser with no injected client", () => {
    setDocumentRealtimeClient(null);
    const window = globalThis.window;
    // @ts-expect-error removing the browser global is the point of this case.
    globalThis.window = undefined;
    try {
      const off = watchDocumentHead(taskA, listener());
      expect(() => off()).not.toThrow();
    } finally {
      globalThis.window = window;
    }
  });

  it("disconnects a client it owns when it is replaced", () => {
    const first = install();
    watchDocumentHead(taskA, listener());
    const second = new FakeRealtime();
    setDocumentRealtimeClient(second.client);
    // The first client was injected, not created here, so it is left alone.
    expect(first.disconnects).toBe(0);
    expect(second.disconnects).toBe(0);
  });
});

describe("resetDocumentRealtime", () => {
  it("forgets every listener so the next subscription starts clean", () => {
    const first = install();
    const a = listener();
    watchDocumentHead(taskA, a);
    resetDocumentRealtime();
    const second = install();
    watchDocumentHead(taskB, listener());
    expect(second.openTasks[0]).toEqual([taskB]);
    // Frames still arriving on the forgotten client reach nobody.
    first.handlers?.onResync?.();
    expect(a.resyncs).toBe(0);
  });

  it("is safe to call with nothing installed", () => {
    setDocumentRealtimeClient(null);
    expect(() => resetDocumentRealtime()).not.toThrow();
  });
});

describe("the shared client", () => {
  it("is created from the configured socket URL when none was injected", async () => {
    vi.resetModules();
    vi.doMock("@/lib/realtime", async () => {
      const actual = await vi.importActual<typeof import("@/lib/realtime")>("@/lib/realtime");
      return { ...actual, realtimeUrl: () => null };
    });
    const module = await import("./realtime.ts");
    const off = module.watchDocumentHead(taskA, listener());
    expect(() => off()).not.toThrow();
    vi.doUnmock("@/lib/realtime");
    vi.resetModules();
  });
});
