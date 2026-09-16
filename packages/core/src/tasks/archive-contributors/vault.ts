import { sql } from "@symplist/db";
import { archiveGuard } from "../archive-runner.ts";
import type { ArchiveContributor } from "./types.ts";

/** Vault task-archive statements (§2.1). Revoke the tasks' Vault grants and clear `value_enc` (§11.3). */
export const vaultArchiveContributor: ArchiveContributor = {
  domain: "vault",
  statements: (input) => {
    const guard = archiveGuard(input);
    return [
      sql(
        `UPDATE vault_grants SET status='revoked',value_enc=NULL,write_id=:w WHERE owner_id=:owner AND task_id IN (${input.archivedTaskIds.sql}) AND status='active' AND ${guard.exists}`,
        {
          ...guard.params,
          ...input.archivedTaskIds.params,
          owner: input.ownerId,
          w: input.writeId,
        },
      ),
    ];
  },
};
