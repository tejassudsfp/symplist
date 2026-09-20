/**
 * REST request and response schemas owned by the simon feature (§8).
 * Export Zod schemas with a `simon`-specific name so the contracts index stays collision free.
 */
import { idSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";
import { taskCollectionSchema, taskTitleInputSchema } from "../workspace/dto.ts";

export const simonTierSchema = z.enum(["fast", "smart"]);
export const simonRunStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_user",
  "completed",
  "stopped",
  "interrupted",
  "failed",
]);
export const simonMessageInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(32_000),
  tier: simonTierSchema.default("fast"),
});
export const simonConversationInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), taskId: idSchema }),
  z.strictObject({ kind: z.literal("quick") }),
]);
export const simonApprovalDecisionSchema = z.strictObject({
  decision: z.enum(["approve", "deny", "dismiss"]),
  argDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  editedArguments: z.record(z.string(), z.unknown()).optional(),
});
export const simonAnswerSchema = z.strictObject({ text: z.string().trim().min(1).max(32_000) });
export const simonRunPayloadSchema = z.strictObject({ runId: idSchema });
export const simonQuickSaveInputSchema = z.strictObject({
  title: taskTitleInputSchema,
  collection: taskCollectionSchema.default("now"),
});
export const simonQuickSavedSchema = z.strictObject({
  conversationId: idSchema,
  taskId: idSchema,
  collection: taskCollectionSchema,
});
export const simonQuickClosedSchema = z.strictObject({
  conversationId: idSchema,
  runId: idSchema.nullable(),
});

export const simonConversationCreatedSchema = z.strictObject({ conversationId: idSchema });
export const simonMessageAcceptedSchema = z.strictObject({
  messageId: idSchema,
  runId: idSchema.nullable(),
  status: z.enum(["accepted", "queued"]),
});
export const simonRunViewSchema = z.strictObject({
  runId: idSchema,
  conversationId: idSchema,
  taskId: idSchema.nullable(),
  status: simonRunStatusSchema,
  tier: simonTierSchema,
  stopRequested: z.boolean(),
  outcomeCode: z.enum(["ai.unavailable", "ai.provider_failed"]).nullable().default(null),
});

export const simonHistoryQuerySchema = z.strictObject({
  beforeSeq: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const simonVisiblePartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("data-approval-result"),
    data: z.strictObject({
      status: z.enum(["succeeded", "failed", "uncertain", "denied", "dismissed", "expired"]),
      result: z.unknown().optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("data-user-answer"),
    data: z.strictObject({
      status: z.enum(["answered", "dismissed", "expired"]),
      text: z.string().optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("tool"),
    toolCallId: z.string(),
    toolName: z.string(),
    state: z.enum(["input-available", "output-available", "output-error"]),
    output: z.unknown().optional(),
    errorCode: z.string().optional(),
  }),
]);
export const simonHistoryMessageSchema = z.strictObject({
  id: idSchema,
  seq: z.number().int().positive(),
  role: z.enum(["user", "assistant", "tool"]),
  status: z.enum(["queued", "accepted", "completed", "cancelled"]),
  runId: idSchema.nullable(),
  text: z.string(),
  parts: z.array(simonVisiblePartSchema),
});
export const simonConversationViewSchema = z.strictObject({
  conversationId: idSchema,
  kind: z.enum(["task", "quick"]),
  taskId: idSchema.nullable(),
  activeRun: simonRunViewSchema.nullable(),
  latestRun: simonRunViewSchema.nullable().default(null),
  pendingApprovalId: idSchema.nullable(),
  pendingAskId: idSchema.nullable(),
  messages: z.array(simonHistoryMessageSchema),
  nextBeforeSeq: z.number().int().positive().nullable(),
});

export const simonApprovalViewSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  toolCallId: z.string(),
  toolSlug: z.string(),
  connectionId: idSchema,
  connectedAccountId: z.string(),
  connectionGeneration: z.number().int(),
  status: z.enum(["pending", "approved", "denied", "dismissed", "expired", "superseded"]),
  argDigest: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  expiresAt: z.number(),
  policyVersion: z.string(),
});
export const simonAskViewSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  toolCallId: z.string(),
  status: z.enum(["pending", "answered", "dismissed", "expired"]),
  expiresAt: z.number(),
  question: z.string(),
  answer: z.string().nullable(),
});
export const simonRunCommandResultSchema = z.strictObject({ runId: idSchema });
