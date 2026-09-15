import { FakeClock } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import {
  LocalScheduler,
  nextMinuteOf,
  SCAN_MINUTES,
  type ScheduledJobContext,
  type SchedulerStateReader,
} from "./local-scheduler.ts";
import type { OperationalLog, OperationalLogFields, RuntimeTimers } from "./runtime.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** 2026-09-15T09:07:30Z. */
const start = Date.UTC(2026, 8, 15, 9, 7, 30);

class Log implements OperationalLog {
  readonly events: { event: string; fields: OperationalLogFields | undefined }[] = [];
  info(event: string, fields?: OperationalLogFields) {
    this.events.push({ event, fields });
  }
  warn(event: string, fields?: OperationalLogFields) {
    this.events.push({ event, fields });
  }
  error(event: string, fields?: OperationalLogFields) {
    this.events.push({ event, fields });
  }
}

function state(initial: { mode: "local" | "durable" | null; generation: number }) {
  const current = { ...initial };
  let reads = 0;
  const reader: SchedulerStateReader = {
    readFresh: async () => {
      reads += 1;
      return { ...current };
    },
  };
  return { reader, current, reads: () => reads };
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

describe("nextMinuteOf", () => {
  it("finds the next :00, :15 or :30 UTC minute boundary", () => {
    expect(utc(nextMinuteOf(Date.UTC(2026, 8, 15, 9, 7, 30), SCAN_MINUTES))).toBe("09:15");
    expect(utc(nextMinuteOf(Date.UTC(2026, 8, 15, 9, 15, 0), SCAN_MINUTES))).toBe("09:15");
    expect(utc(nextMinuteOf(Date.UTC(2026, 8, 15, 9, 15, 0, 1), SCAN_MINUTES))).toBe("09:30");
    expect(utc(nextMinuteOf(Date.UTC(2026, 8, 15, 9, 31, 0), SCAN_MINUTES))).toBe("10:00");
    expect(utc(nextMinuteOf(Date.UTC(2026, 8, 15, 23, 59, 59), [5]))).toBe("00:05");
  });
});

describe("LocalScheduler (§12.2)", () => {
  it("runs scanners at :00, :15 and :30 UTC and hourly jobs at their minute, with the generation", async () => {
    const clock = new FakeClock(start);
    const guard = state({ mode: "local", generation: 3 });
    const scheduler = new LocalScheduler({
      durable: false,
      state: guard.reader,
      timers: clock,
      log: new Log(),
    });
    const scans: ScheduledJobContext[] = [];
    const cleanups: ScheduledJobContext[] = [];
    scheduler.registerScanner({
      name: "reminder-scan",
      run: async (context) => void scans.push(context),
    });
    scheduler.registerHourlyJob({
      name: "cleanup-hourly",
      run: async (context) => void cleanups.push(context),
    });
    scheduler.start();

    await clock.advance(2 * HOUR);
    expect(scans.map((context) => utc(context.scheduledFor))).toEqual([
      "09:15",
      "09:30",
      "10:00",
      "10:15",
      "10:30",
      "11:00",
    ]);
    expect(cleanups.map((context) => utc(context.scheduledFor))).toEqual(["10:05", "11:05"]);
    expect(scans.every((context) => context.generation === 3)).toBe(true);
    await scheduler.stop();
  });

  it("never starts when DURABLE=true", async () => {
    const clock = new FakeClock(start);
    const guard = state({ mode: "durable", generation: 1 });
    const scheduler = new LocalScheduler({
      durable: true,
      state: guard.reader,
      timers: clock,
      log: new Log(),
    });
    let runs = 0;
    scheduler.registerScanner({
      name: "reminder-scan",
      run: async () => {
        runs += 1;
      },
    });
    scheduler.start();
    await clock.advance(HOUR);
    expect(runs).toBe(0);
    expect(guard.reads()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("skips firings while executor_state records durable mode and resumes after a switch back", async () => {
    const clock = new FakeClock(start);
    const guard = state({ mode: "durable", generation: 2 });
    const log = new Log();
    const scheduler = new LocalScheduler({
      durable: false,
      state: guard.reader,
      timers: clock,
      log,
    });
    const generations: number[] = [];
    scheduler.registerScanner({
      name: "reminder-scan",
      run: async (context) => void generations.push(context.generation),
    });
    scheduler.start();
    await clock.set(Date.UTC(2026, 8, 15, 9, 31));
    expect(generations).toEqual([]);
    expect(
      log.events.filter((entry) => entry.event === "scheduler.skipped_generation"),
    ).toHaveLength(2);
    guard.current.mode = "local";
    guard.current.generation = 3;
    await clock.set(Date.UTC(2026, 8, 15, 10, 1));
    expect(generations).toEqual([3]);
    await scheduler.stop();
  });

  it("skips a scanner whose previous run is still going and aborts running jobs on stop", async () => {
    const clock = new FakeClock(start);
    const guard = state({ mode: "local", generation: 1 });
    const log = new Log();
    const scheduler = new LocalScheduler({
      durable: false,
      state: guard.reader,
      timers: clock,
      log,
    });
    let started = 0;
    let signal: AbortSignal | undefined;
    scheduler.registerScanner({
      name: "reminder-scan",
      run: (context) => {
        started += 1;
        signal = context.signal;
        return new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve()),
        );
      },
    });
    scheduler.start();
    await clock.advance(30 * MINUTE);
    expect(started).toBe(1);
    expect(log.events.some((entry) => entry.event === "scheduler.overlap_skipped")).toBe(true);
    await scheduler.stop();
    expect(signal?.aborted).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("logs a failing job by code only and keeps scheduling", async () => {
    const clock = new FakeClock(start);
    const log = new Log();
    const scheduler = new LocalScheduler({
      durable: false,
      state: state({ mode: "local", generation: 1 }).reader,
      timers: clock,
      log,
    });
    let calls = 0;
    scheduler.registerScanner({
      name: "reminder-scan",
      run: async () => {
        calls += 1;
        throw Object.assign(new Error("reminder for maya@example.com failed"), {
          code: "email.rejected",
        });
      },
    });
    scheduler.start();
    await clock.advance(30 * MINUTE);
    expect(calls).toBe(2);
    const failures = log.events.filter((entry) => entry.event === "scheduler.job_failed");
    expect(failures[0]?.fields).toMatchObject({ job: "reminder-scan", code: "email.rejected" });
    expect(JSON.stringify(log.events)).not.toContain("maya@example.com");
    await scheduler.stop();
  });

  it("validates registrations", () => {
    const clock = new FakeClock(start);
    const scheduler = new LocalScheduler({
      durable: false,
      state: state({ mode: "local", generation: 1 }).reader,
      timers: clock,
      log: new Log(),
    });
    scheduler.registerScanner({ name: "reminder-scan", run: async () => undefined });
    expect(() =>
      scheduler.registerHourlyJob({ name: "reminder-scan", run: async () => undefined }),
    ).toThrow(/already registered/);
    expect(() =>
      scheduler.registerHourlyJob({ name: "cleanup", minute: 60, run: async () => undefined }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.registerScanner({ name: "Bad Name", run: async () => undefined }),
    ).toThrow();
  });
  it("fires each slot once when a timer runs slightly before its wall-clock due instant", async () => {
    let now = start;
    const pending: { callback: () => void; at: number }[] = [];
    const timers: RuntimeTimers = {
      now: () => now,
      setTimeout: (callback, delayMs) => {
        const entry = { callback, at: now + delayMs };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        const index = pending.indexOf(handle as (typeof pending)[number]);
        if (index >= 0) pending.splice(index, 1);
      },
      setInterval: () => undefined,
      clearInterval: () => undefined,
    };
    const guard = state({ mode: "local", generation: 1 });
    const scheduler = new LocalScheduler({
      durable: false,
      state: guard.reader,
      timers,
      log: new Log(),
    });
    const scans: number[] = [];
    scheduler.registerScanner({
      name: "reminder-scan",
      run: async (context) => void scans.push(context.scheduledFor),
    });
    scheduler.start();
    const first = pending.shift();
    expect(first && utc(first.at)).toBe("09:15");
    // The wall clock lags the monotonic timer by 2 ms when the callback runs.
    now = (first?.at ?? 0) - 2;
    first?.callback();
    await new Promise((resolve) => setImmediate(resolve));
    expect(scans.map(utc)).toEqual(["09:15"]);
    expect(pending.map((entry) => utc(entry.at))).toEqual(["09:30"]);
    await scheduler.stop();
  });
  it("stops within the grace period even when a job ignores its abort signal", async () => {
    const clock = new FakeClock(start);
    const log = new Log();
    const scheduler = new LocalScheduler({
      durable: false,
      state: state({ mode: "local", generation: 1 }).reader,
      timers: clock,
      log,
      shutdownGraceMs: 1_000,
    });
    let started = false;
    scheduler.registerScanner({
      name: "reminder-scan",
      run: () => {
        started = true;
        return new Promise<void>(() => undefined);
      },
    });
    scheduler.start();
    await clock.advance(8 * MINUTE);
    expect(started).toBe(true);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await clock.advance(999);
    expect(stopped).toBe(false);
    await clock.advance(1);
    await stopping;
    expect(stopped).toBe(true);
    expect(log.events.map((entry) => entry.event)).toContain("scheduler.stop_grace_elapsed");
  });
});
