import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";

/**
 * What the connections domain needs from the account, and nothing more.
 *
 * These services used to reach for `SimonRepository`, which carried the same database, key store
 * and access predicate alongside the conversation and run machinery. That machinery is gone with
 * chat: the cloud stores which accounts a person has linked, and the desktop routes every connector
 * call itself. Depending on the repository would have meant keeping Simon's tables alive to answer
 * "may this owner act", which is a question about the account, not about a run.
 */
export interface ConnectionContextOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
}

export class ConnectionContext {
  readonly accountKeys: AccountKeyStore;

  constructor(readonly options: ConnectionContextOptions) {
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
  }

  /** The SQL predicate for "this owner may act", bound to `:owner`. */
  access(): string {
    return accessCondition({ level: "admitted", policy: this.options.policy, userParam: "owner" });
  }
}
