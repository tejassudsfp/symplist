/** The request header carrying a mutation's idempotency key (§6.1). */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID !== "function") {
    throw new Error("A cryptographically secure random source is required for idempotency keys");
  }
  return cryptoApi.randomUUID();
}

/** A fresh idempotency key for one user intent. */
export function createIdempotencyKey(): string {
  return randomId();
}

/** Scopes held before the least recently used one is dropped. */
const DEFAULT_MAX_KEYS = 500;

/**
 * Keeps one key per logical operation so retries of the same intent reuse it (an exact retry returns
 * the recorded outcome), while a new intent gets a new key. Release the scope once the outcome is
 * known: after success, or after a definitive failure the user will change and resubmit.
 *
 * A retryable failure whose Try again is never taken leaves its scope held, so the map is bounded as
 * a least-recently-used cache rather than trusting every path to release. Dropping the oldest scope
 * only costs a retry of an offer the person has long since walked away from a new key.
 */
export class IdempotencyKeys {
  private readonly keys = new Map<string, string>();

  constructor(private readonly maxKeys: number = DEFAULT_MAX_KEYS) {}

  /** The key for `scope`, created on first use. */
  acquire(scope: string): string {
    const existing = this.keys.get(scope);
    if (existing !== undefined) {
      // Re-insert so a scope being actively retried is never the one evicted.
      this.keys.delete(scope);
      this.keys.set(scope, existing);
      return existing;
    }
    const key = randomId();
    this.keys.set(scope, key);
    while (this.keys.size > this.maxKeys) {
      const oldest = this.keys.keys().next();
      if (oldest.done) break;
      this.keys.delete(oldest.value);
    }
    return key;
  }

  /** Forgets the key so the next `acquire(scope)` starts a new operation. */
  release(scope: string): void {
    this.keys.delete(scope);
  }

  has(scope: string): boolean {
    return this.keys.has(scope);
  }
}
