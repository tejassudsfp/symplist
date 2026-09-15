import { SetMetadata } from "@nestjs/common";

/** Metadata key of {@link Idempotent} and {@link OneTimeSecret}. */
export const IDEMPOTENT_METADATA = "symplist:idempotent";

export interface IdempotentRequirement {
  /** Fields of the success body that carry a one-time secret; null for ordinary mutations. */
  readonly secretFields: readonly string[] | null;
}

/**
 * Requires an `Idempotency-Key` header on a mutation with side effects (§6.1). The first request
 * with a key runs; an exact retry replays the recorded response; the same key with another input
 * returns `idempotency.mismatch`. Requires `@Access`, because records belong to a user.
 */
export const Idempotent = (): MethodDecorator =>
  SetMetadata(IDEMPOTENT_METADATA, Object.freeze({ secretFields: null }));

/**
 * Marks an idempotent endpoint that mints a one-time secret (§6.1, decision R11). The minting
 * response carries `secretFields` and `secretUnavailable: false`; only the redacted outcome is
 * recorded, so an exact retry receives the non-secret fields with `secretUnavailable: true` and
 * `notice: "secret.already_issued"`.
 */
export const OneTimeSecret = (secretFields: readonly [string, ...string[]]): MethodDecorator =>
  SetMetadata(
    IDEMPOTENT_METADATA,
    Object.freeze({ secretFields: Object.freeze([...secretFields]) }),
  );
