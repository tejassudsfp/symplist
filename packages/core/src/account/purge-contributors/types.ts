import type { DbClient, Statement } from "@symplist/db";
import type { ConnectionPurgeProvider } from "@symplist/integrations";
import type { CoreDomain } from "../../domains.ts";

export interface PurgeInput {
  /** The deleted account; its data key is already shredded, so only plaintext ids are available. */
  readonly userId: string;
  /** Upper bound on rows deleted per statement, keeping batches within the D1 lane budget. */
  readonly batchLimit: number;
}

/** The account a provider-side purge removes (§5.6 step 2): plaintext ids from `account_deletions`. */
export interface PurgeProviderInput {
  readonly userId: string;
  /** Equals the Symplist user id (§14.1). */
  readonly composioUserId: string;
}

/**
 * What a runtime gives provider-side purge work. A domain whose purge needs a provider client (the
 * connections domain's Composio client) adds it here when it registers that work.
 */
export interface PurgeProviderDependencies {
  readonly connections?: ConnectionPurgeProvider;
  readonly db: DbClient;
  readonly now: () => number;
}

/**
 * A domain's owner-row deletions for the account purge (§5.6 step 4). `statements` deletes at most
 * `batchLimit` rows per statement, children before parents, and is idempotent. A domain with
 * statements also provides `remaining`: read-only statements that each return one row with a
 * `remaining` column (1 while rows of the user are left, otherwise 0), which the runner appends to
 * the same batch to decide whether to run the domain again.
 *
 * A domain that keeps account state at an external provider also provides `purgeProvider` (§5.6 step
 * 2: the connections domain deletes Composio connected accounts with `revoke_on_delete: true` and
 * the user's Composio session). It must be idempotent and return `incomplete` (or throw) while work
 * is left, so the step is recorded only once every provider reported done.
 */
export interface PurgeContributor {
  readonly domain: CoreDomain;
  statements(input: PurgeInput): readonly Statement[];
  remaining?(input: PurgeInput): readonly Statement[];
  purgeProvider?(
    input: PurgeProviderInput,
    dependencies: PurgeProviderDependencies,
  ): Promise<"done" | "incomplete">;
}
