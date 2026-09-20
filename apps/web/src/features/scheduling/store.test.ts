import { describe, expect, it, vi } from "vitest";
import { DeadlineStore, scheduleOverlay } from "./store.ts";
import { stubSchedulingApi } from "./test-support.ts";

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
describe("bounded visible deadline summaries", () => {
  it("does not let an old editor close a newer global overlay", () => {
    const first = scheduleOverlay.open("first-task");
    const second = scheduleOverlay.open("second-task", true);
    expect(scheduleOverlay.close(first)).toBe(false);
    expect(scheduleOverlay.get()).toBe(second);
    expect(scheduleOverlay.close(second)).toBe(true);
    expect(scheduleOverlay.get()).toBeNull();
  });
  it("does not let an old subscription cleanup remove a reopened entry", async () => {
    const api = stubSchedulingApi({
      summaries: vi.fn(async (ids: readonly string[]) =>
        ids.map((taskId) => ({ taskId, version: 1, deadline: null, deadlineAt: null })),
      ),
    });
    const store = new DeadlineStore(api);
    const removeOld = store.subscribe("task", vi.fn());
    store.dispose();
    store.reopen();
    const listener = vi.fn();
    store.subscribe("task", listener);
    removeOld();
    await flush();
    expect(store.get("task")?.version).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
  });
  it("reopens a disposed microtask without issuing the abandoned batch", async () => {
    const api = stubSchedulingApi({
      summaries: vi.fn(async (ids: readonly string[]) =>
        ids.map((taskId) => ({ taskId, version: 1, deadline: null, deadlineAt: null })),
      ),
    });
    const store = new DeadlineStore(api);
    store.subscribe("abandoned", vi.fn());
    store.dispose();
    store.subscribe("visible", vi.fn());
    store.reopen();
    await flush();
    expect(api.summaries).toHaveBeenCalledExactlyOnceWith(["visible"]);
    expect(store.get("visible")?.version).toBe(1);
  });

  it("keeps a reopened queue serialized when its abandoned request settles", async () => {
    type Summaries = Awaited<ReturnType<ReturnType<typeof stubSchedulingApi>["summaries"]>>;
    const completions: Array<(values: Summaries) => void> = [];
    const api = stubSchedulingApi({
      summaries: vi.fn(() => new Promise<Summaries>((resolve) => completions.push(resolve))),
    });
    const store = new DeadlineStore(api);
    store.subscribe("task", vi.fn());
    await flush();
    store.dispose();
    store.reopen();
    const listener = vi.fn();
    store.subscribe("task", listener);
    await flush();
    completions[0]?.([{ taskId: "task", version: 99, deadline: null, deadlineAt: null }]);
    await flush();
    expect(store.get("task")).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    store.refresh();
    await flush();
    expect(api.summaries).toHaveBeenCalledTimes(2);
    completions[1]?.([{ taskId: "task", version: 1, deadline: null, deadlineAt: null }]);
    await flush();
    expect(store.get("task")?.version).toBe(1);
    expect(api.summaries).toHaveBeenCalledTimes(3);
    completions[2]?.([{ taskId: "task", version: 2, deadline: null, deadlineAt: null }]);
    await flush();
    expect(store.get("task")?.version).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("coalesces mounted chips into sequential batches no larger than fifty", async () => {
    let concurrent = 0;
    let maximum = 0;
    const api = stubSchedulingApi({
      summaries: vi.fn(async (ids: readonly string[]) => {
        concurrent++;
        maximum = Math.max(maximum, concurrent);
        await Promise.resolve();
        concurrent--;
        return ids.map((taskId) => ({ taskId, version: 1, deadline: null, deadlineAt: null }));
      }),
    });
    const store = new DeadlineStore(api);
    for (let index = 0; index < 123; index++) store.subscribe(`task-${index}`, vi.fn());
    await flush();
    expect(vi.mocked(api.summaries).mock.calls.map(([ids]) => ids.length)).toEqual([50, 50, 23]);
    expect(maximum).toBe(1);
    expect(store.get("task-122")?.version).toBe(1);
  });
  it("prunes unmounted ids and refreshes only the visible set after reconnect", async () => {
    const api = stubSchedulingApi();
    const store = new DeadlineStore(api);
    const remove = store.subscribe("removed", vi.fn());
    store.subscribe("visible", vi.fn());
    await flush();
    remove();
    vi.mocked(api.summaries).mockClear();
    store.refresh();
    await flush();
    expect(api.summaries).toHaveBeenCalledWith(["visible"]);
    expect(store.get("removed")).toBeNull();
  });
  it("ignores late responses from a disposed account and older summary versions", async () => {
    let finish!: (
      value: Awaited<ReturnType<ReturnType<typeof stubSchedulingApi>["summaries"]>>,
    ) => void;
    const api = stubSchedulingApi({
      summaries: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<ReturnType<typeof stubSchedulingApi>["summaries"]>>>(
            (resolve) => {
              finish = resolve;
            },
          ),
      ),
    });
    const listener = vi.fn();
    const store = new DeadlineStore(api);
    store.subscribe("task", listener);
    await flush();
    store.set({ taskId: "task", version: 2, deadline: null, deadlineAt: null });
    store.set({ taskId: "task", version: 1, deadline: null, deadlineAt: null });
    expect(store.get("task")?.version).toBe(2);
    store.dispose();
    finish([{ taskId: "task", version: 3, deadline: null, deadlineAt: null }]);
    await flush();
    expect(store.get("task")).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  });
});
