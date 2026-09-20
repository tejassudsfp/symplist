import { oneTimeSecretResponseSchema } from "../common/idempotency.ts";
import { idSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";
import { documentRevisionSchema, documentSectionIdSchema } from "../documents/dto.ts";

export const shareModeSchema = z.enum(["link", "password", "public"]);
export const sharingSnapshotRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  revision: documentRevisionSchema,
  sectionIds: z.array(documentSectionIdSchema).max(100).default([]),
});
export type SharingSnapshotRequest = z.infer<typeof sharingSnapshotRequestSchema>;
export const sharingGrantRequestSchema = z
  .strictObject({
    mode: shareModeSchema.default("link"),
    expiresAt: z.number().int().positive().nullable(),
    expectedHead: documentRevisionSchema,
    password: z.string().min(8).max(256).optional(),
    publicConfirmed: z.boolean().default(false),
    proposalId: idSchema.optional(),
    replaceGrantId: idSchema.optional(),
    revokeReplaced: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if ((value.mode === "password") !== (value.password !== undefined))
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "Password is required only for a password link",
      });
    if (value.mode !== "public" && value.expiresAt === null)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Private links must expire",
      });
    if (value.mode === "public" && !value.publicConfirmed)
      context.addIssue({
        code: "custom",
        path: ["publicConfirmed"],
        message: "Confirm public access",
      });
    if (value.revokeReplaced && !value.replaceGrantId)
      context.addIssue({
        code: "custom",
        path: ["replaceGrantId"],
        message: "Choose a grant to replace",
      });
  });
export type SharingGrantRequest = z.infer<typeof sharingGrantRequestSchema>;
export const sharingArtifactSchema = z.strictObject({
  id: idSchema,
  taskId: idSchema,
  title: z.string(),
  sourceRevision: documentRevisionSchema,
  currentHead: documentRevisionSchema.nullable(),
  sectionIds: z.array(documentSectionIdSchema),
  bytes: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  kind: z.enum(["document", "handoff"]),
});
export type SharingArtifact = z.infer<typeof sharingArtifactSchema>;
export const sharingGrantSchema = z.strictObject({
  id: idSchema,
  artifactId: idSchema,
  mode: shareModeSchema,
  status: z.enum(["active", "expired", "revoked", "disabled"]),
  disabledReason: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  generation: z.number().int().positive(),
});
export type SharingGrant = z.infer<typeof sharingGrantSchema>;
export const sharingListSchema = z.strictObject({
  artifacts: z.array(sharingArtifactSchema),
  grants: z.array(sharingGrantSchema),
  hasMore: z.boolean(),
  nextArtifact: idSchema.nullable().default(null),
  nextGrant: idSchema.nullable().default(null),
});
export type SharingList = z.infer<typeof sharingListSchema>;
export const sharingListQuerySchema = z.strictObject({
  beforeArtifact: z.union([idSchema, z.literal("end")]).optional(),
  beforeGrant: z.union([idSchema, z.literal("end")]).optional(),
});
export type SharingListQuery = z.infer<typeof sharingListQuerySchema>;
export const sharingPreviewSchema = z.strictObject({
  artifact: sharingArtifactSchema,
  markdown: z.string(),
  hasPublicCopy: z.boolean(),
});
export type SharingPreview = z.infer<typeof sharingPreviewSchema>;
export const sharingReleaseSchema = oneTimeSecretResponseSchema(
  { grant: sharingGrantSchema },
  { url: z.string().url() },
);
export type SharingRelease = z.infer<typeof sharingReleaseSchema>;
export const sharingProposalRequestSchema = z.strictObject({
  artifactId: idSchema,
  expectedHead: documentRevisionSchema,
  mode: shareModeSchema,
  expiresAt: z.number().int().positive().nullable(),
});
export type SharingProposalRequest = z.infer<typeof sharingProposalRequestSchema>;
export const sharingProposalSchema = sharingProposalRequestSchema.extend({
  id: idSchema,
  taskId: idSchema,
  status: z.enum(["pending", "released", "expired", "dismissed"]),
  expiresAt: z.number().int().positive().nullable(),
  proposalExpiresAt: z.number().int(),
  sourceChanged: z.boolean(),
});
export type SharingProposal = z.infer<typeof sharingProposalSchema>;
export const handoffRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  revision: documentRevisionSchema,
  target: z.enum(["coding_assistant", "general_assistant", "other"]),
  prompt: z.string().trim().min(1).max(32000),
  artifactIds: z.array(idSchema).max(20),
});
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;
export const sharingPasswordRequestSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nonce: z.string().max(256),
  password: z.string().min(1).max(256),
});
