/**
 * REST request and response schemas owned by the simon feature (§8).
 * Export Zod schemas with a `simon`-specific name so the contracts index stays collision free.
 */
import { idSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";

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
});
