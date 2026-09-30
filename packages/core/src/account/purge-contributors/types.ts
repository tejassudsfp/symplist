import type { DbClient, Statement } from "@symplist/db";
import type { CoreDomain } from "../../domains.ts";

export interface PurgeInput {
  /** The deleted account; its data key is already shredded, so only plaintext ids are available. */
  readonly userId: string;
  /** Upper bound on rows deleted per statement, keeping batches within the D1 lane budget. */
  readonly batchLimit: number;
}

/**
 * The account a provider-side purge removes (§5.6 step 2): plaintext ids from `account_deletions`.
 *
 * No contributor implements `purgeProvider` any more. It existed for one: the connections domain
 * revoked the account's connected accounts at Composio and deleted its session there before the local
 * rows went, and connectors left with the server-side agent (note 18). The seam stays because the step
 * is part of the purge's recorded shape and a domain that keeps state at a provider may want it again.
 */
export interface PurgeProviderInput {
  readonly userId: string;
}

/** What a runtime gives provider-side purge work, for a domain that keeps state at a provider. */
export interface PurgeProviderDependencies {
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
 * 2). It must be idempotent and return `incomplete` (or throw) while work is left, so the step is
 * recorded only once every provider reported done. Nothing implements it today — see
 * `PurgeProviderInput`.
 */
export interface PurgeContributor {
  /**
   * A core domain, or one of the two retired features: the tables cloud chat and the Composio
   * connectors left behind have no domain left to belong to, and the expand-only rule keeps their rows
   * purgeable long after the code that wrote them is gone. Nothing else may take that escape hatch — a
   * live domain gets a folder.
   */
  readonly domain: CoreDomain | "retired-chat" | "retired-connections";
  statements(input: PurgeInput): readonly Statement[];
  remaining?(input: PurgeInput): readonly Statement[];
  purgeProvider?(
    input: PurgeProviderInput,
    dependencies: PurgeProviderDependencies,
  ): Promise<"done" | "incomplete">;
}
