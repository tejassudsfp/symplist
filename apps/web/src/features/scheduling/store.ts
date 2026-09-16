import type { SchedulingDeadline } from "@symplist/contracts";
import type { SchedulingApi } from "./api.ts";

export interface DeadlineSummary {
  readonly taskId: string;
  readonly version: number;
  readonly deadline: SchedulingDeadline | null;
  readonly deadlineAt: number | null;
}
/** Only mounted chips are retained. A reconnect batches visible ids; it never fans out one request per task. */
export class DeadlineStore {
  private readonly entries = new Map<
    string,
    { value: DeadlineSummary | null; listeners: Set<() => void> }
  >();
  private readonly pending = new Set<string>();
  private queued = false;
  private generation = 0;
  constructor(readonly api: SchedulingApi) {}
  get(id: string) {
    return this.entries.get(id)?.value ?? null;
  }
  subscribe(id: string, listener: () => void) {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { value: null, listeners: new Set() };
      this.entries.set(id, entry);
      this.pending.add(id);
      this.schedule();
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        this.entries.delete(id);
        this.pending.delete(id);
      }
    };
  }
  set(value: DeadlineSummary) {
    const entry = this.entries.get(value.taskId);
    if (!entry) return;
    if (entry.value && entry.value.version > value.version) return;
    entry.value = value;
    for (const listener of entry.listeners) listener();
  }
  refresh(ids?: readonly string[]) {
    for (const id of ids ?? this.entries.keys()) if (this.entries.has(id)) this.pending.add(id);
    this.schedule();
  }
  dispose() {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
  }
  private schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      void this.flush();
    });
  }
  private async flush() {
    const generation = this.generation;
    while (this.pending.size && generation === this.generation) {
      const ids = [...this.pending].slice(0, 50);
      for (const id of ids) this.pending.delete(id);
      try {
        const values = await this.api.summaries(ids);
        if (generation !== this.generation) return;
        for (const value of values) this.set(value);
      } catch {
        /* The editor exposes a retry/error state; a failed optional chip must not block the task list. */
      }
    }
    this.queued = false;
  }
}
type Overlay = { taskId: string; addReminder: boolean } | null;
export function openNotifications() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("symplist:notifications"));
}
let overlay: Overlay = null;
const listeners = new Set<() => void>();
export const scheduleOverlay = {
  get: () => overlay,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  open: (taskId: string, addReminder = false) => {
    overlay = { taskId, addReminder };
    for (const listener of listeners) listener();
  },
  close: () => {
    overlay = null;
    for (const listener of listeners) listener();
  },
};
