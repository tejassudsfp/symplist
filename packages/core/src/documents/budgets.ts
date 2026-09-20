import { DocumentError } from "@symplist/docs";

/** Bytes of document-derived text one Simon turn may retrieve (§9.4); runs store the running total. */
export const DOCUMENT_TURN_RETRIEVAL_BYTES = 96_000;

/** Bytes one MCP grant may retrieve per window (§14.6: budgets keyed by grant id). */
export const DOCUMENT_GRANT_RETRIEVAL_BYTES = 256_000;
export const DOCUMENT_GRANT_RETRIEVAL_WINDOW_MS = 10 * 60 * 1000;

/**
 * A retrieval budget (§9.4, note 06 "per-turn context budgets"): tools clamp every read to what is
 * left and refuse with `document.budget_exhausted` when not even a minimal chunk fits. Caller-supplied
 * limits can only reduce a read, never raise it past the budget.
 */
export interface RetrievalBudget {
  /** Bytes still available. */
  remaining(): number;
  /** Records delivered bytes. */
  consume(bytes: number): void;
  /** Bytes consumed through this budget so far. */
  readonly consumedBytes: number;
}

/** Clamps a requested size to the budget, or refuses when less than `minimum` bytes remain. */
export function clampToBudget(
  budget: RetrievalBudget | undefined,
  requested: number,
  minimum: number,
): number {
  if (!budget) return requested;
  const remaining = budget.remaining();
  if (remaining < minimum) {
    throw new DocumentError("document.budget_exhausted", {
      details: { remainingBytes: remaining },
    });
  }
  return Math.min(requested, remaining);
}

/**
 * One Simon turn's budget: `usedBytes` is `runs.retrieved_bytes` as read in the step's batch, and the
 * step persists `usedBytes + consumedBytes` with its checkpoint.
 */
export class TurnRetrievalBudget implements RetrievalBudget {
  private consumed = 0;

  constructor(
    private readonly capBytes: number = DOCUMENT_TURN_RETRIEVAL_BYTES,
    private readonly usedBytes: number = 0,
  ) {
    if (
      !Number.isSafeInteger(capBytes) ||
      capBytes < 0 ||
      !Number.isSafeInteger(usedBytes) ||
      usedBytes < 0
    ) {
      throw new RangeError("Retrieval budgets are non-negative whole bytes");
    }
  }

  remaining(): number {
    return Math.max(0, this.capBytes - this.usedBytes - this.consumed);
  }

  consume(bytes: number): void {
    this.consumed += Math.max(0, Math.trunc(bytes));
  }

  get consumedBytes(): number {
    return this.consumed;
  }

  /** The running total to persist in `runs.retrieved_bytes`. */
  get totalBytes(): number {
    return this.usedBytes + this.consumed;
  }
}

/**
 * Per-grant budgets for MCP (§9.4, §14.6), in api memory over a rolling window. A budget protects the
 * caller's context, not a secret, so per-instance memory is sufficient; the window resets on deploy.
 */
export class GrantRetrievalBudgets {
  private readonly windows = new Map<string, { start: number; used: number }>();

  constructor(
    private readonly options: {
      readonly now: () => number;
      readonly capBytes?: number;
      readonly windowMs?: number;
      readonly maxGrants?: number;
    },
  ) {}

  forGrant(grantId: string): RetrievalBudget {
    const cap = this.options.capBytes ?? DOCUMENT_GRANT_RETRIEVAL_BYTES;
    const windowMs = this.options.windowMs ?? DOCUMENT_GRANT_RETRIEVAL_WINDOW_MS;
    const now = this.options.now();
    let window = this.windows.get(grantId);
    if (!window || now - window.start >= windowMs) {
      window = { start: now, used: 0 };
      this.windows.delete(grantId);
      this.windows.set(grantId, window);
      const maxGrants = this.options.maxGrants ?? 10_000;
      for (const [id, entry] of this.windows) {
        if (this.windows.size <= maxGrants) break;
        if (entry !== window) this.windows.delete(id);
      }
    }
    const state = window;
    let consumed = 0;
    return {
      remaining: () => Math.max(0, cap - state.used),
      consume: (bytes) => {
        const amount = Math.max(0, Math.trunc(bytes));
        // Concurrent reads can both clamp before either finishes. Refuse the later delivery,
        // not merely the next request, so a grant cannot overdraw its shared window.
        if (amount > cap - state.used) throw new DocumentError("document.budget_exhausted");
        state.used += amount;
        consumed += amount;
      },
      get consumedBytes() {
        return consumed;
      },
    };
  }
}
