import { accessPurgeContributor } from "./access.ts";
import { accountPurgeContributor } from "./account.ts";
import { connectionsPurgeContributor } from "./connections.ts";
import { documentsPurgeContributor } from "./documents.ts";
import { idempotencyPurgeContributor } from "./idempotency.ts";
import { mcpPurgeContributor } from "./mcp.ts";
import { preferencesPurgeContributor } from "./preferences.ts";
import { schedulingPurgeContributor } from "./scheduling.ts";
import { searchPurgeContributor } from "./search.ts";
import { sharingPurgeContributor } from "./sharing.ts";
import { simonPurgeContributor } from "./simon.ts";
import { tasksPurgeContributor } from "./tasks.ts";
import type { PurgeContributor } from "./types.ts";
import { vaultPurgeContributor } from "./vault.ts";

export type {
  PurgeContributor,
  PurgeInput,
  PurgeProviderDependencies,
  PurgeProviderInput,
} from "./types.ts";

/** Every domain's purge contribution, children before parents (§5.6 step 4). */
export const purgeContributors: readonly PurgeContributor[] = [
  simonPurgeContributor,
  schedulingPurgeContributor,
  vaultPurgeContributor,
  sharingPurgeContributor,
  mcpPurgeContributor,
  connectionsPurgeContributor,
  documentsPurgeContributor,
  searchPurgeContributor,
  preferencesPurgeContributor,
  idempotencyPurgeContributor,
  tasksPurgeContributor,
  accessPurgeContributor,
  accountPurgeContributor,
];
