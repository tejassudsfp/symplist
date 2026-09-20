import { idSchema, taskIdSchema } from "../common/ids.ts";
import { defineTools } from "../common/tools.ts";
import { z } from "../common/zod.ts";
import {
  handoffRequestSchema,
  sharingArtifactSchema,
  sharingGrantSchema,
  sharingListQuerySchema,
  sharingListSchema,
  sharingProposalRequestSchema,
  sharingSnapshotRequestSchema,
} from "./dto.ts";

/** Simon and MCP tool contracts owned by the sharing feature (§13, §8.7, §14.6). */
export const sharingTools = defineTools({
  artifact_snapshot: {
    input: sharingSnapshotRequestSchema.extend({ taskId: taskIdSchema }),
    output: sharingArtifactSchema,
  },
  artifact_share_create: {
    input: sharingProposalRequestSchema,
    output: z.strictObject({
      proposalId: idSchema,
      status: z.enum(["pending", "released", "expired", "dismissed"]),
    }),
  },
  artifact_share_list: {
    input: sharingListQuerySchema.extend({ taskId: taskIdSchema }),
    output: sharingListSchema,
  },
  artifact_share_revoke: {
    input: z.strictObject({ artifactId: idSchema, grantId: idSchema }),
    output: sharingGrantSchema,
  },
  handoff_prepare: {
    input: handoffRequestSchema.extend({ taskId: taskIdSchema }),
    output: sharingArtifactSchema,
  },
});
