/** Time for worker clients; `FakeClock` from `@symplist/testing` satisfies it. */
export interface WorkerTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemWorkerTimers: WorkerTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, Math.max(0, delayMs)),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
};

export function sleep(timers: WorkerTimers, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}
