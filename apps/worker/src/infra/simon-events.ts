import { onTaskTreeCommitted, TASK_TREE_CHANGED_EVENT } from "@symplist/core/tasks";
import type { WorkerRuntime } from "./runtime.ts";

interface SimonEventRuntime {
  readonly db: WorkerRuntime["db"];
  readonly events: Pick<WorkerRuntime["events"], "announce">;
  readonly logger: Pick<WorkerRuntime["logger"], "warn">;
}
const registered = new WeakMap<SimonEventRuntime, Set<Promise<unknown>>>();

/** One subscriber per process runtime, even when several runs reuse it. IDs and counts only. */
export function simonTaskAnnouncements(runtime: SimonEventRuntime): () => Promise<void> {
  let pending = registered.get(runtime);
  if (!pending) {
    pending = new Set();
    registered.set(runtime, pending);
    const work = pending;
    onTaskTreeCommitted(runtime.db, (event) => {
      const delivery = runtime.events
        .announce({
          type: TASK_TREE_CHANGED_EVENT,
          ownerId: event.ownerId,
          payload: { taskTreeVersion: event.taskTreeVersion, taskIds: event.taskIds.slice(0, 100) },
        })
        .catch(() => {
          runtime.logger.warn("simon.announce_failed");
        })
        .finally(() => work.delete(delivery));
      work.add(delivery);
    });
  }
  const work = pending;
  return async () => {
    await Promise.all([...work]);
  };
}
