import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_THROTTLE_MS,
  SAVE_IDLE_MS,
  SAVE_MAX_INTERVAL_MS,
  SaveScheduler,
  type SaveTrigger,
  type SchedulerTimers,
} from "./save-scheduler.ts";

/** A clock and timer queue the test advances by hand, so no real time passes (§9.3). */
class FakeTimers implements SchedulerTimers {
  private time = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; run: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.pending.set(handle, { at: this.time + ms, run: callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.pending.delete(handle);
      this.time = timer.at;
      timer.run();
    }
    this.time = target;
  }
}

let timers: FakeTimers;
let saves: SaveTrigger[];
let drafts: number;

function scheduler(options: { idleMs?: number; maxIntervalMs?: number } = {}): SaveScheduler {
  return new SaveScheduler({
    timers,
    onSave: (trigger) => saves.push(trigger),
    onDraft: () => {
      drafts += 1;
    },
    ...options,
  });
}

beforeEach(() => {
  timers = new FakeTimers();
  saves = [];
  drafts = 0;
});

describe("publishing on idle", () => {
  it("publishes 3 seconds after the last keystroke", () => {
    const save = scheduler();
    save.changed();
    timers.advance(SAVE_IDLE_MS - 1);
    expect(saves).toEqual([]);
    timers.advance(1);
    expect(saves).toEqual(["idle"]);
  });

  it("restarts the idle timer on every keystroke", () => {
    const save = scheduler();
    for (let keystroke = 0; keystroke < 5; keystroke += 1) {
      save.changed();
      timers.advance(2_000);
    }
    expect(saves).toEqual([]);
    timers.advance(SAVE_IDLE_MS);
    expect(saves).toEqual(["idle"]);
  });

  it("stops asking once nothing is pending", () => {
    const save = scheduler();
    save.changed();
    timers.advance(SAVE_IDLE_MS);
    timers.advance(SAVE_MAX_INTERVAL_MS * 2);
    expect(saves).toEqual(["idle"]);
  });
});

describe("the 60-second cap during continuous typing", () => {
  it("publishes at most once a minute while typing never pauses", () => {
    const save = scheduler();
    for (let second = 0; second < 60; second += 1) {
      save.changed();
      timers.advance(1_000);
    }
    expect(saves).toEqual(["interval"]);
  });

  it("does not restart the cap on each keystroke", () => {
    const save = scheduler();
    // Keystrokes closer together than the idle window, so only the cap can fire.
    for (let elapsed = 0; elapsed < SAVE_MAX_INTERVAL_MS; elapsed += 2_500) {
      save.changed();
      expect(saves).toEqual([]);
      timers.advance(2_500);
    }
    // The cap fired exactly one minute after the first change, not one minute after the last.
    expect(saves).toEqual(["interval"]);
    expect(timers.now()).toBe(SAVE_MAX_INTERVAL_MS);
  });

  it("starts a fresh cap for the next run of typing", () => {
    const save = scheduler();
    save.changed();
    timers.advance(SAVE_IDLE_MS);
    expect(saves).toEqual(["idle"]);
    save.changed();
    for (let second = 0; second < 60; second += 1) {
      save.changed();
      timers.advance(1_000);
    }
    expect(saves).toEqual(["idle", "interval"]);
  });
});

describe("flush", () => {
  it("publishes immediately for blur, task switch and Mod+S", () => {
    for (const trigger of ["blur", "task_switch", "shortcut"] as const) {
      saves = [];
      const save = scheduler();
      save.changed();
      expect(save.flush(trigger)).toBe(true);
      expect(saves).toEqual([trigger]);
    }
  });

  it("reports that nothing was pending rather than saving an unchanged document", () => {
    const save = scheduler();
    expect(save.flush("shortcut")).toBe(false);
    expect(saves).toEqual([]);
  });

  it("cancels the pending timers so a flushed change is not published twice", () => {
    const save = scheduler();
    save.changed();
    save.flush("blur");
    timers.advance(SAVE_MAX_INTERVAL_MS * 2);
    expect(saves).toEqual(["blur"]);
  });

  it("does nothing after dispose", () => {
    const save = scheduler();
    save.changed();
    save.dispose();
    expect(save.flush("shortcut")).toBe(false);
    timers.advance(SAVE_MAX_INTERVAL_MS * 2);
    expect(saves).toEqual([]);
  });
});

describe("pending state", () => {
  it("tracks whether a change is waiting to be published", () => {
    const save = scheduler();
    expect(save.hasPendingChange).toBe(false);
    save.changed();
    expect(save.hasPendingChange).toBe(true);
    save.published();
    expect(save.hasPendingChange).toBe(false);
  });

  it("stops the timers when a publish completed elsewhere", () => {
    const save = scheduler();
    save.changed();
    save.published();
    timers.advance(SAVE_MAX_INTERVAL_MS * 2);
    expect(saves).toEqual([]);
  });

  it("ignores changes after dispose", () => {
    const save = scheduler();
    save.dispose();
    save.changed();
    expect(save.hasPendingChange).toBe(false);
    timers.advance(SAVE_MAX_INTERVAL_MS);
    expect(saves).toEqual([]);
  });
});

describe("draft throttling", () => {
  it("writes the first draft straight away", () => {
    const save = scheduler();
    save.changed();
    expect(drafts).toBe(1);
  });

  it("writes at most one draft every two seconds for a fast typist", () => {
    const save = scheduler();
    for (let keystroke = 0; keystroke < 40; keystroke += 1) {
      save.changed();
      timers.advance(100);
    }
    // 4 seconds of typing: the immediate write plus one per throttle window.
    expect(drafts).toBe(1 + Math.floor(4_000 / DRAFT_THROTTLE_MS));
  });

  it("writes the throttled draft once the window passes, even if typing stopped", () => {
    const save = scheduler();
    save.changed();
    save.changed();
    expect(drafts).toBe(1);
    timers.advance(DRAFT_THROTTLE_MS);
    expect(drafts).toBe(2);
  });

  it("restarts the window when the caller reports a draft written elsewhere", () => {
    const save = scheduler();
    save.draftWritten(0);
    save.changed();
    expect(drafts).toBe(0);
    timers.advance(DRAFT_THROTTLE_MS);
    expect(drafts).toBe(1);
  });

  it("drops a queued draft write after dispose", () => {
    const save = scheduler();
    save.changed();
    save.changed();
    save.dispose();
    timers.advance(DRAFT_THROTTLE_MS * 2);
    expect(drafts).toBe(1);
  });

  it("leaves no timer behind after dispose", () => {
    const save = scheduler();
    save.changed();
    save.changed();
    save.dispose();
    expect(timers.pendingCount).toBe(0);
  });
});

describe("the default timers", () => {
  it("use the browser clock and timer functions", () => {
    vi.useFakeTimers();
    try {
      const save = new SaveScheduler({
        onSave: (trigger) => saves.push(trigger),
        onDraft: () => {
          drafts += 1;
        },
      });
      save.changed();
      expect(drafts).toBe(1);
      vi.advanceTimersByTime(SAVE_IDLE_MS);
      expect(saves).toEqual(["idle"]);
      save.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
