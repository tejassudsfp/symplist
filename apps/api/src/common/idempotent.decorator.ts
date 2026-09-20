import { SetMetadata } from "@nestjs/common";

/** Metadata key of {@link Idempotent} and {@link OneTimeSecret}. */
export const IDEMPOTENT_METADATA = "symplist:idempotent";

export interface IdempotentRequirement {
  /** Fields of the success body that carry a one-time secret; null for ordinary mutations. */
  readonly secretFields: readonly string[] | null;
  /**
   * Whether the handler claims the key inside its own deciding D1 batch through
   * `foldedIdempotencyOf(req)`, so the claim, the effect and the recorded response commit together
   * (§3.1, §6.1). The interceptor then sends no D1 request of its own.
   */
  readonly folded: boolean;
}

export interface IdempotentOptions {
  /** Fold the claim and the completion into the handler's batch; see {@link IdempotentRequirement}. */
  readonly folded?: boolean;
}

/**
 * Requires an `Idempotency-Key` header on a mutation with side effects (§6.1). The first request
 * with a key runs; an exact retry replays the recorded response; the same key with another input
 * returns `idempotency.mismatch`. Requires `@Access`, because records belong to a user. With
 * `{ folded: true }` the handler folds the claim into its deciding batch (exactly once, one request).
 */
export const Idempotent = (options: IdempotentOptions = {}): MethodDecorator =>
  SetMetadata(
    IDEMPOTENT_METADATA,
    Object.freeze({ secretFields: null, folded: options.folded ?? false }),
  );

/**
 * Marks an idempotent endpoint that mints a one-time secret (§6.1, decision R11). The minting
 * response carries `secretFields` and `secretUnavailable: false`; only the redacted outcome is
 * recorded, so an exact retry receives the non-secret fields with `secretUnavailable: true` and
 * `notice: "secret.already_issued"`.
 */
export const OneTimeSecret = (
  secretFields: readonly [string, ...string[]],
  options: IdempotentOptions = {},
): MethodDecorator =>
  SetMetadata(
    IDEMPOTENT_METADATA,
    Object.freeze({
      secretFields: Object.freeze([...secretFields]),
      folded: options.folded ?? false,
    }),
  );
