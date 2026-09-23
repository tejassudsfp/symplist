/**
 * REST request and response schemas for bring-your-own-key model access (§8.6).
 *
 * Model credentials belong to the account that spends them. Every schema here exists to move a key
 * in exactly one direction — the browser can set one and clear one, and nothing ever sends one back
 * — so there is deliberately no response shape that carries a key or any part of one.
 */
import { z } from "../common/zod.ts";

/**
 * The providers an account can bring a key for.
 *
 * Narrow on purpose: each value is a code path in the agent's registry that knows the provider's
 * endpoint, its model ids and its privacy options, not a name passed through to a generic client.
 */
export const aiProviderSchema = z.enum(["openai", "anthropic"]);
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const aiTierSchema = z.enum(["fast", "smart"]);
export type AiTier = z.infer<typeof aiTierSchema>;

/**
 * A provider key on its way in.
 *
 * The shape is checked, not the account: a typo caught here saves a confusing failure on the first
 * turn, but only the provider can say whether a key is live, so `verifiedAt` is set by a real call
 * rather than by this passing.
 */
export const aiProviderKeySchema = z.strictObject({
  provider: aiProviderSchema,
  // Wide enough for both providers' formats and any future length, narrow enough to reject a pasted
  // sentence. Printable ASCII only: a key with whitespace in it is a paste accident.
  key: z
    .string()
    .min(20)
    .max(512)
    .regex(/^[A-Za-z0-9_\-.]+$/u, "must be an API key, with no spaces or quotes"),
});
export type AiProviderKeyInput = z.infer<typeof aiProviderKeySchema>;

export const aiProviderParamsSchema = z.strictObject({ provider: aiProviderSchema });
export type AiProviderParams = z.infer<typeof aiProviderParamsSchema>;

/** What the settings screen is told about a stored key: that it exists, never what it is. */
export const aiProviderKeyStatusSchema = z.strictObject({
  provider: aiProviderSchema,
  configured: z.boolean(),
  createdAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative().nullable(),
  /** When a real provider call last succeeded with this key, or null if none has yet. */
  verifiedAt: z.number().int().nonnegative().nullable(),
});
export type AiProviderKeyStatus = z.infer<typeof aiProviderKeyStatusSchema>;

/** One tier's resolved choice, and whether it can actually run. */
export const aiTierChoiceSchema = z.strictObject({
  tier: aiTierSchema,
  provider: aiProviderSchema,
  model: z.string().min(1).max(128),
  /** False when this tier names a provider the account has not given a key for. */
  ready: z.boolean(),
  /** True when the account chose this, false when it is the deployment's default. */
  chosen: z.boolean(),
});
export type AiTierChoice = z.infer<typeof aiTierChoiceSchema>;

export const aiSettingsSchema = z.strictObject({
  keys: z.array(aiProviderKeyStatusSchema),
  tiers: z.array(aiTierChoiceSchema),
  /** False when no tier can run, which is what gates Simon behind adding a key. */
  usable: z.boolean(),
  /** Model ids known to work for each provider, to offer without pretending it is exhaustive. */
  suggestions: z.array(
    z.strictObject({ provider: aiProviderSchema, models: z.array(z.string().min(1).max(128)) }),
  ),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

/** Choosing what answers a tier. Omitting a field leaves it as it was; null returns it to default. */
export const aiTierChoiceInputSchema = z.strictObject({
  provider: aiProviderSchema.nullable().optional(),
  model: z.string().min(1).max(128).nullable().optional(),
});
export const aiModelChoicesSchema = z.strictObject({
  fast: aiTierChoiceInputSchema.optional(),
  smart: aiTierChoiceInputSchema.optional(),
});
export type AiModelChoicesInput = z.infer<typeof aiModelChoicesSchema>;
