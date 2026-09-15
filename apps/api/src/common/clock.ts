/** A UTC epoch-milliseconds time source. Tests inject a fake clock through `CLOCK`. */
export interface Clock {
  now(): number;
}

/** Injection token for the {@link Clock} every platform service reads time from. */
export const CLOCK = "symplist:CLOCK";

export const systemClock: Clock = Object.freeze({ now: () => Date.now() });
