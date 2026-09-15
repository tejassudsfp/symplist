import type { Statement } from "@symplist/db";
import type { CoreDomain } from "../../domains.ts";

export interface PurgeInput {
  /** The deleted account; its data key is already shredded, so only plaintext ids are available. */
  readonly userId: string;
  /** Upper bound on rows deleted per statement, keeping batches within the D1 lane budget. */
  readonly batchLimit: number;
}

/**
 * A domain's owner-row deletions for the account purge (§5.6 step 4). Statements are idempotent and
 * return an empty list once the domain holds no rows for the user.
 */
export interface PurgeContributor {
  readonly domain: CoreDomain;
  statements(input: PurgeInput): readonly Statement[];
}
