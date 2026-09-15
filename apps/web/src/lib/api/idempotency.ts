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

/**
 * Keeps one key per logical operation so retries of the same intent reuse it (an exact retry returns
 * the recorded outcome), while a new intent gets a new key. Release the scope once the outcome is
 * known: after success, or after a definitive failure the user will change and resubmit.
 */
export class IdempotencyKeys {
  private readonly keys = new Map<string, string>();

  /** The key for `scope`, created on first use. */
  acquire(scope: string): string {
    const existing = this.keys.get(scope);
    if (existing) return existing;
    const key = randomId();
    this.keys.set(scope, key);
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
