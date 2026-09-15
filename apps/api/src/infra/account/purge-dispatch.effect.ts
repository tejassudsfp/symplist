import type { AccountDeletionEffect } from "@symplist/core/account";
import type { ExecutionDispatcher } from "../executors/dispatcher.ts";

/**
 * After the deletion batch commits (§5.6 step 6), dispatches the `account_purge` intent it inserted
 * at once instead of at the reconciler's next pass: the local executor runs the purge in process when
 * `DURABLE=false`, and the `account-purge` Trigger task runs it otherwise.
 */
export class PurgeDispatchEffect implements AccountDeletionEffect {
  readonly name = "account_purge_dispatch";

  constructor(private readonly dispatcher: Pick<ExecutionDispatcher, "kick">) {}

  async afterCommit(): Promise<void> {
    this.dispatcher.kick();
  }
}
