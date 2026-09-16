/**
 * When typing becomes a published revision (§9.3): 3 seconds after the last keystroke, on blur, on
 * task switch, on Mod+S, and at most every 60 seconds during continuous typing. Drafts are written
 * separately and far more often, throttled so a fast typist never writes more than one draft every
 * two seconds.
 *
 * The scheduler owns no React state and takes its clock and timers from the caller, so every timing
 * rule is tested without real time passing.
 */

/** Why a publish was requested. `retry` comes from the failed-save Retry control. */
export type SaveTrigger = "idle" | "interval" | "blur" | "task_switch" | "shortcut" | "retry";

export const SAVE_IDLE_MS = 3_000;
export const SAVE_MAX_INTERVAL_MS = 60_000;
export const DRAFT_THROTTLE_MS = 2_000;

export interface SchedulerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const browserSchedulerTimers: SchedulerTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface SaveSchedulerOptions {
  /** Publish the buffer. Called at most once per trigger; the caller serializes overlapping saves. */
  readonly onSave: (trigger: SaveTrigger) => void;
  /** Write the unsaved buffer to the server draft. */
  readonly onDraft: () => void;
  readonly timers?: SchedulerTimers;
  readonly idleMs?: number;
  readonly maxIntervalMs?: number;
  readonly draftThrottleMs?: number;
}

/**
 * Tracks one document's pending changes. `changed()` on every keystroke, `published()` when a save
 * completed, `flush(trigger)` for blur, task switch and Mod+S.
 */
export class SaveScheduler {
  private readonly timers: SchedulerTimers;
  private readonly idleMs: number;
  private readonly maxIntervalMs: number;
  private readonly draftThrottleMs: number;
  private idleTimer: unknown = null;
  private intervalTimer: unknown = null;
  private draftTimer: unknown = null;
  private pending = false;
  private lastDraftAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly options: SaveSchedulerOptions) {
    this.timers = options.timers ?? browserSchedulerTimers;
    this.idleMs = options.idleMs ?? SAVE_IDLE_MS;
    this.maxIntervalMs = options.maxIntervalMs ?? SAVE_MAX_INTERVAL_MS;
    this.draftThrottleMs = options.draftThrottleMs ?? DRAFT_THROTTLE_MS;
  }

  /** Whether a change is waiting to be published. */
  get hasPendingChange(): boolean {
    return this.pending;
  }

  /** The editor buffer changed. Restarts the idle timer and keeps the 60-second cap running. */
  changed(): void {
    if (this.disposed) return;
    const first = !this.pending;
    this.pending = true;
    this.clear(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      this.fire("idle");
    }, this.idleMs);
    if (first && this.intervalTimer === null) {
      this.intervalTimer = this.timers.setTimeout(() => {
        this.intervalTimer = null;
        this.fire("interval");
      }, this.maxIntervalMs);
    }
    this.scheduleDraft();
  }

  /**
   * Publishes now if anything is pending. `blur`, `task_switch` and `shortcut` always ask, so Mod+S
   * on an unchanged document still reports its state truthfully rather than doing nothing silently.
   */
  flush(trigger: SaveTrigger): boolean {
    if (this.disposed) return false;
    const pending = this.pending;
    this.stopTimers();
    this.pending = false;
    if (!pending) return false;
    this.options.onSave(trigger);
    return true;
  }

  /** A publish finished (or the buffer matched the head): timers stop until the next change. */
  published(): void {
    this.stopTimers();
    this.pending = false;
  }

  /** A draft write finished, which restarts the throttle window. */
  draftWritten(at: number = this.timers.now()): void {
    this.lastDraftAt = at;
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
    this.clear(this.draftTimer);
    this.draftTimer = null;
  }

  private fire(trigger: SaveTrigger): void {
    if (this.disposed || !this.pending) return;
    this.stopTimers();
    this.pending = false;
    this.options.onSave(trigger);
  }

  private scheduleDraft(): void {
    if (this.draftTimer !== null) return;
    const elapsed = this.timers.now() - this.lastDraftAt;
    if (elapsed >= this.draftThrottleMs) {
      this.lastDraftAt = this.timers.now();
      this.options.onDraft();
      return;
    }
    this.draftTimer = this.timers.setTimeout(() => {
      this.draftTimer = null;
      if (this.disposed) return;
      this.lastDraftAt = this.timers.now();
      this.options.onDraft();
    }, this.draftThrottleMs - elapsed);
  }

  private stopTimers(): void {
    this.clear(this.idleTimer);
    this.clear(this.intervalTimer);
    this.idleTimer = null;
    this.intervalTimer = null;
  }

  private clear(handle: unknown): void {
    if (handle !== null) this.timers.clearTimeout(handle);
  }
}
