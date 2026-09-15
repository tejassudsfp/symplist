import { errorCode, type OperationalLog, type RuntimeTimers } from "./runtime.ts";

/** The executor generation reader the scheduler guards every run with (§8.1). */
export interface SchedulerStateReader {
  readFresh(): Promise<{ readonly mode: "local" | "durable" | null; readonly generation: number }>;
}

/** What a scheduled job receives. Jobs fold `generation` into their batches as a guard. */
export interface ScheduledJobContext {
  readonly name: string;
  readonly generation: number;
  /** The UTC epoch milliseconds the run was due. */
  readonly scheduledFor: number;
  /** Aborted when the api shuts down. */
  readonly signal: AbortSignal;
}

export interface ScheduledJobRegistration {
  readonly name: string;
  run(context: ScheduledJobContext): Promise<void>;
}

export interface HourlyJobRegistration extends ScheduledJobRegistration {
  /** Minute past each UTC hour; defaults to 5, like the durable `cleanup-hourly` cron (§8.8). */
  readonly minute?: number;
}

/** The scanner wakes at :00, :15 and :30 past each UTC hour (§12.2, decision D3). */
export const SCAN_MINUTES: readonly number[] = Object.freeze([0, 15, 30]);

const MINUTE_MS = 60_000;

/** The first instant at or after `now` whose UTC minute-of-hour is in `minutes`, on a minute boundary. */
export function nextMinuteOf(now: number, minutes: readonly number[]): number {
  if (minutes.length === 0) throw new RangeError("At least one minute is required");
  let candidate = Math.ceil(now / MINUTE_MS) * MINUTE_MS;
  for (let step = 0; step <= 60; step += 1) {
    const minute = ((Math.floor(candidate / MINUTE_MS) % 60) + 60) % 60;
    if (minutes.includes(minute)) return candidate;
    candidate += MINUTE_MS;
  }
  throw new RangeError("Minutes must be within 0 to 59");
}

interface Slot {
  readonly kind: "scan" | "hourly";
  readonly minutes: readonly number[];
  readonly jobs: Map<string, ScheduledJobRegistration>;
  timer: unknown;
}

export interface LocalSchedulerOptions {
  /** `DURABLE`: when true the scheduler never starts and Trigger schedules own the work. */
  readonly durable: boolean;
  readonly state: SchedulerStateReader;
  readonly timers: RuntimeTimers;
  readonly log: OperationalLog;
  /** How long `stop` waits for aborted jobs to settle; defaults to 5 seconds. */
  readonly shutdownGraceMs?: number;
}

/**
 * The local scheduler shell (§8.8, §12.2): when `DURABLE=false` it runs registered scanners at minutes
 * 0, 15 and 30 UTC and hourly cleanup jobs at their minute, the same service functions the Trigger
 * schedules call. Each firing reads `executor_state` fresh and runs only while the recorded mode is
 * `local`, passing the generation to the job; a job still running from its previous firing is skipped.
 */
export class LocalScheduler {
  private readonly scan: Slot = {
    kind: "scan",
    minutes: SCAN_MINUTES,
    jobs: new Map(),
    timer: undefined,
  };
  private readonly hourly = new Map<number, Slot>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  private started = false;
  private stopped = false;

  constructor(private readonly options: LocalSchedulerOptions) {}

  /** Registers a scanner such as the reminder scan. Returns a function that unregisters it. */
  registerScanner(registration: ScheduledJobRegistration): () => void {
    return this.add(this.scan, registration);
  }

  /** Registers an hourly job such as quick-chat expiry or Vault grant expiry. */
  registerHourlyJob(registration: HourlyJobRegistration): () => void {
    const minute = registration.minute ?? 5;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new RangeError("Hourly job minutes must be whole minutes from 0 to 59");
    }
    let slot = this.hourly.get(minute);
    if (!slot) {
      slot = { kind: "hourly", minutes: [minute], jobs: new Map(), timer: undefined };
      this.hourly.set(minute, slot);
    }
    return this.add(slot, registration);
  }

  get active(): boolean {
    return this.started && !this.stopped;
  }

  /** Starts the timers unless `DURABLE=true`. Idempotent. */
  start(): void {
    if (this.options.durable || this.started || this.stopped) return;
    this.started = true;
    this.arm(this.scan);
    for (const slot of this.hourly.values()) this.arm(slot);
  }

  /**
   * Stops the timers, aborts running jobs and waits up to the grace period for them to settle, so a job
   * that ignores its signal can never hold api shutdown (and the HTTP drain after it) open.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const slot of [this.scan, ...this.hourly.values()]) {
      if (slot.timer !== undefined) this.options.timers.clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    this.controller.abort();
    const running = [...this.running.values()];
    if (running.length === 0) return;
    let timer: unknown;
    const settled = await Promise.race([
      Promise.allSettled(running).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = this.options.timers.setTimeout(
          () => resolve(false),
          this.options.shutdownGraceMs ?? 5_000,
        );
      }),
    ]);
    this.options.timers.clearTimeout(timer);
    if (!settled) {
      this.options.log.warn("scheduler.stop_grace_elapsed", { count: this.running.size });
    }
  }

  private add(slot: Slot, registration: ScheduledJobRegistration): () => void {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(registration.name)) {
      throw new Error("Scheduled job names are lower-case identifiers");
    }
    if (
      this.scan.jobs.has(registration.name) ||
      [...this.hourly.values()].some((s) => s.jobs.has(registration.name))
    ) {
      throw new Error(`A scheduled job named "${registration.name}" is already registered`);
    }
    slot.jobs.set(registration.name, registration);
    if (this.active && slot.timer === undefined) this.arm(slot);
    return () => {
      slot.jobs.delete(registration.name);
    };
  }

  /**
   * Arms the slot's next firing after `after` (the firing that just ran, when re-arming). Timers run on
   * a monotonic clock while `now()` is wall-clock time, so a callback can run a little before its due
   * instant; arming from `now` alone would then schedule the same minute again and fire it twice.
   */
  private arm(slot: Slot, after?: number): void {
    if (!this.active || slot.jobs.size === 0) return;
    const now = this.options.timers.now();
    const due = nextMinuteOf(Math.max(now, after ?? now) + 1, slot.minutes);
    slot.timer = this.options.timers.setTimeout(() => {
      slot.timer = undefined;
      void this.fire(slot, due);
    }, due - now);
  }

  private async fire(slot: Slot, due: number): Promise<void> {
    if (!this.active) return;
    // Re-arm first, so a slow guard read never delays the next firing.
    this.arm(slot, due);
    let state: Awaited<ReturnType<SchedulerStateReader["readFresh"]>>;
    try {
      state = await this.options.state.readFresh();
    } catch (error) {
      this.options.log.warn("scheduler.state_unavailable", {
        slot: slot.kind,
        code: errorCode(error),
      });
      return;
    }
    if (state.mode !== "local") {
      this.options.log.warn("scheduler.skipped_generation", {
        slot: slot.kind,
        recordedMode: state.mode,
        generation: state.generation,
      });
      return;
    }
    for (const job of slot.jobs.values()) {
      if (this.running.has(job.name)) {
        this.options.log.warn("scheduler.overlap_skipped", { job: job.name, scheduledFor: due });
        continue;
      }
      const started = this.options.timers.now();
      const run = Promise.resolve()
        .then(() =>
          job.run({
            name: job.name,
            generation: state.generation,
            scheduledFor: due,
            signal: this.controller.signal,
          }),
        )
        .then(
          () =>
            this.options.log.info("scheduler.job_completed", {
              job: job.name,
              generation: state.generation,
              durationMs: Math.max(0, this.options.timers.now() - started),
            }),
          (error: unknown) =>
            this.options.log.error("scheduler.job_failed", {
              job: job.name,
              generation: state.generation,
              code: errorCode(error),
            }),
        )
        .finally(() => {
          this.running.delete(job.name);
        });
      this.running.set(job.name, run);
    }
  }
}
