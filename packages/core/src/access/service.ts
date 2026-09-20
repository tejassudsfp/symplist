import type { Statement } from "@symplist/db";
import type { AccessLevel, AccessState, RestrictionReason } from "./types.ts";

export interface RestrictInput {
  readonly userId: string;
  readonly reason: RestrictionReason;
  /** The users-row write id that guards every contributed statement (§5.5). */
  readonly writeId: string;
  readonly now: number;
  /** Set for `campaign_revoked`: only grants from this campaign are revoked. */
  readonly campaignId?: string;
}

/** The result of one restriction batch. */
export interface RestrictOutcome {
  readonly userId: string;
  /** False when the deciding statement did not match (already relocked or suspended, or deleting). */
  readonly applied: boolean;
  /** The user's `access_generation` after the batch when it applied, otherwise null. */
  readonly accessGeneration: number | null;
}

/** Access checks and the restriction routine shared by api and worker (§5.4, §5.5). */
export interface AccessService {
  /** Reads the user's access fields fresh from D1; null when the user does not exist. */
  load(userId: string): Promise<AccessState | null>;
  /** Whether the state satisfies a guard level, honoring `BETA_ACCESS_REQUIRED`. */
  satisfies(state: AccessState, level: AccessLevel): boolean;
  /**
   * Runs the restriction and every domain contribution in one D1 batch, then the post-commit effects
   * (close sockets, cancel runs, evict caches) when it applied.
   */
  restrict(input: RestrictInput): Promise<RestrictOutcome>;
  /** The contributed statements alone, for callers that fold them into their own batch (§5.6). */
  restrictStatements(input: RestrictInput): readonly Statement[];
}
