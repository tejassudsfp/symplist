import { describe, expect, it } from "vitest";
import { expectCryptoError, expectCryptoRejection } from "../test/support.ts";
import { InvalidCryptoInputError, RateLimitedError } from "./errors.ts";
import { ARGON2_SEMAPHORE_LIMITS, Argon2Semaphore, argon2Semaphore } from "./semaphore.ts";

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
  fail(error: Error): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Argon2Semaphore", () => {
  it("uses the §4.3 limits for the process-wide instance", () => {
    expect(ARGON2_SEMAPHORE_LIMITS).toEqual({
      maxConcurrent: 2,
      maxQueue: 16,
      retryAfterSeconds: 1,
    });
    expect(argon2Semaphore.maxConcurrent).toBe(2);
    expect(argon2Semaphore.maxQueue).toBe(16);
    expect(argon2Semaphore.retryAfterSeconds).toBe(1);
  });

  it("runs two at once, queues sixteen and refuses the next with rate.limited", async () => {
    const semaphore = new Argon2Semaphore();
    const gates = Array.from({ length: 18 }, gate);
    const started: number[] = [];
    const runs = gates.map((entry, index) =>
      semaphore.run(async () => {
        started.push(index);
        await entry.promise;
        return index;
      }),
    );
    await flush();
    expect(semaphore.active).toBe(2);
    expect(semaphore.queued).toBe(16);
    expect(started).toEqual([0, 1]);

    const refused = await expectCryptoRejection(
      () => semaphore.run(async () => 99),
      RateLimitedError,
    );
    expect(refused.code).toBe("rate.limited");
    expect((refused as RateLimitedError).retryAfter).toBe(1);
    expect(semaphore.queued).toBe(16);

    for (const entry of gates) {
      entry.open();
      await flush();
      expect(semaphore.active).toBeLessThanOrEqual(2);
    }
    expect(await Promise.all(runs)).toEqual(gates.map((_entry, index) => index));
    expect(started).toEqual(gates.map((_entry, index) => index));
    expect(semaphore.active).toBe(0);
    expect(semaphore.queued).toBe(0);
  });

  it("releases the slot when an operation fails", async () => {
    const semaphore = new Argon2Semaphore({ maxConcurrent: 1, maxQueue: 1, retryAfterSeconds: 3 });
    const first = gate();
    const failing = semaphore.run(() => first.promise);
    const second = semaphore.run(async () => "second");
    await expectCryptoRejection(() => semaphore.run(async () => "third"), RateLimitedError).then(
      (error) => expect((error as RateLimitedError).retryAfter).toBe(3),
    );
    first.fail(new Error("boom"));
    await expect(failing).rejects.toThrow("boom");
    await expect(second).resolves.toBe("second");
    expect(semaphore.active).toBe(0);
    await expect(semaphore.run(async () => "fourth")).resolves.toBe("fourth");
  });

  it("refuses immediately when the queue size is zero and the slots are busy", async () => {
    const semaphore = new Argon2Semaphore({ maxConcurrent: 1, maxQueue: 0, retryAfterSeconds: 1 });
    const held = gate();
    const running = semaphore.run(() => held.promise);
    await expectCryptoRejection(() => semaphore.run(async () => 1), RateLimitedError);
    held.open();
    await running;
  });

  it("validates its limits", () => {
    for (const options of [
      { maxConcurrent: 0, maxQueue: 1, retryAfterSeconds: 1 },
      { maxConcurrent: 1, maxQueue: -1, retryAfterSeconds: 1 },
      { maxConcurrent: 1, maxQueue: 1, retryAfterSeconds: 0 },
      { maxConcurrent: 1.5, maxQueue: 1, retryAfterSeconds: 1 },
    ]) {
      expectCryptoError(() => new Argon2Semaphore(options), InvalidCryptoInputError);
    }
  });
});
