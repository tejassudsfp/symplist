import type { Statement } from "@symplist/db";
import type { CoreDomain } from "../../domains.ts";

export interface PurgeInput {
  /** The deleted account; its data key is already shredded, so only plaintext ids are available. */
  readonly userId: string;
  /** Upper bound on rows deleted per statement, keeping batches within the D1 lane budget. */
  readonly batchLimit: number;
}

/**
 * A domain's owner-row deletions for the account purge (§5.6 step 4). `statements` deletes at most
 * `batchLimit` rows per statement, children before parents, and is idempotent. A domain with
 * statements also provides `remaining`: read-only statements that each return one row with a
 * `remaining` column (1 while rows of the user are left, otherwise 0), which the runner appends to
 * the same batch to decide whether to run the domain again.
 */
export interface PurgeContributor {
  readonly domain: CoreDomain;
  statements(input: PurgeInput): readonly Statement[];
  remaining?(input: PurgeInput): readonly Statement[];
}
