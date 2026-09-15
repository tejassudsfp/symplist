import { InvalidCryptoInputError, RateLimitedError } from "./errors.ts";

/** Limits for a {@link Argon2Semaphore}. */
export interface Argon2SemaphoreOptions {
  /** Operations running at once. */
  readonly maxConcurrent: number;
  /** Operations waiting for a slot; one more is refused with `RateLimitedError`. */
  readonly maxQueue: number;
  /** The `retryAfter` seconds reported when refusing. */
  readonly retryAfterSeconds: number;
}

/** §4.3: 2 concurrent, a queue of 16, then `rate.limited`. Retry after 1 second. */
export const ARGON2_SEMAPHORE_LIMITS: Argon2SemaphoreOptions = Object.freeze({
  maxConcurrent: 2,
  maxQueue: 16,
  retryAfterSeconds: 1,
});

function positiveInteger(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new InvalidCryptoInputError(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

/**
 * A counting semaphore with a bounded FIFO queue. When every slot is busy and the queue is full, a new
 * operation is refused immediately with `RateLimitedError` instead of waiting (§4.3, §5.8).
 */
export class Argon2Semaphore {
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly retryAfterSeconds: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(options: Argon2SemaphoreOptions = ARGON2_SEMAPHORE_LIMITS) {
    this.maxConcurrent = positiveInteger("maxConcurrent", options.maxConcurrent, 1);
    this.maxQueue = positiveInteger("maxQueue", options.maxQueue, 0);
    this.retryAfterSeconds = positiveInteger("retryAfterSeconds", options.retryAfterSeconds, 1);
  }

  /** Operations currently holding a slot. */
  get active(): number {
    return this.#active;
  }

  /** Operations waiting for a slot. */
  get queued(): number {
    return this.#waiting.length;
  }

  /** Runs `operation` once a slot is free, or rejects with `RateLimitedError` when saturated. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.maxConcurrent) {
      this.#active += 1;
      return Promise.resolve();
    }
    if (this.#waiting.length >= this.maxQueue) {
      return Promise.reject(new RateLimitedError(this.retryAfterSeconds));
    }
    return new Promise((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) {
      next();
    } else {
      this.#active -= 1;
    }
  }
}

/** The process-wide semaphore every Argon2id operation shares (§4.3). */
export const argon2Semaphore = new Argon2Semaphore();
