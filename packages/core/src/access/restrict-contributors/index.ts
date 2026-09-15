import { accessRestrictContributor } from "./access.ts";
import { connectionsRestrictContributor } from "./connections.ts";
import { mcpRestrictContributor } from "./mcp.ts";
import { schedulingRestrictContributor } from "./scheduling.ts";
import { sharingRestrictContributor } from "./sharing.ts";
import { simonRestrictContributor } from "./simon.ts";
import type { RestrictContributor } from "./types.ts";
import { vaultRestrictContributor } from "./vault.ts";

export type { RestrictContributor } from "./types.ts";

/** Every domain's restriction contribution, in batch order (§5.5). */
export const restrictContributors: readonly RestrictContributor[] = [
  accessRestrictContributor,
  vaultRestrictContributor,
  simonRestrictContributor,
  schedulingRestrictContributor,
  sharingRestrictContributor,
  mcpRestrictContributor,
  connectionsRestrictContributor,
];
