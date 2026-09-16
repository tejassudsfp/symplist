import { describe, expect, it, vi } from "vitest";
import { DeadlineStore } from "./store.ts";
import { stubSchedulingApi } from "./test-support.ts";

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
describe("bounded visible deadline summaries", () => {
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
