import type {
  AnalyticsEventProperties,
  ServerAnalyticsEventName,
} from "@symplist/analytics/server";
import type { ErrorCode } from "@symplist/contracts";
import type { AccountDataKey, KeyProvider } from "@symplist/crypto";
import type { DbClient, Statement, StatementResult } from "@symplist/db";
import type { SqlGuard } from "@symplist/docs";
import type { ObjectStore } from "@symplist/storage";
import type { AccessPolicy } from "../access/index.ts";

export class SharingError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "SharingError";
  }
}

/** HTTP owns the claim and response redaction; core folds both into the deciding batch. */
export interface SharingFold {
  readonly prefix: readonly Statement[];
  readonly guard: SqlGuard;
  complete(body: unknown, key: AccountDataKey, effect: SqlGuard): readonly Statement[];
  decide(
    results: readonly StatementResult[],
    key: AccountDataKey,
  ): { readonly replay: unknown } | null;
}

export interface SharingOptions {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  readonly artifactOrigin: string;
  readonly privateOrigins?: readonly string[];
  readonly maxBytes?: number;
  readonly onGrantChanged?: (owner: string, taskId: string, artifactId: string) => Promise<void>;
  readonly onConfirmed?: <Name extends ServerAnalyticsEventName>(
    owner: string,
    event: Name,
    properties: AnalyticsEventProperties<Name>,
    eventId: string,
  ) => Promise<void>;
}
