/**
 * REST request and response schemas owned by the vault feature (§11).
 * Export Zod schemas with a `vault`-specific name so the contracts index stays collision free.
 */
import { idSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";

export const vaultPassphraseSchema = z.string().min(1).max(1024);
export const vaultUnlockRequestSchema = z.strictObject({ passphrase: vaultPassphraseSchema });
export const vaultSetupRequestSchema = z
  .strictObject({
    passphrase: vaultPassphraseSchema,
    confirmation: vaultPassphraseSchema,
  })
  .refine((value) => value.passphrase === value.confirmation, {
    message: "The keys do not match",
    path: ["confirmation"],
  });
export const vaultStatusSchema = z.strictObject({
  state: z.enum(["not_created", "locked", "unlocked"]),
  minimumKeyLength: z.number().int().min(8),
  idleExpiresAt: z.number().int().nullable(),
});
export const vaultItemContentSchema = z.strictObject({
  type: z.enum(["secret", "note"]),
  title: z.string().trim().min(1).max(200),
  value: z.string().max(64000),
});
export const vaultItemSchema = vaultItemContentSchema.extend({
  id: idSchema,
  version: z.number().int().positive(),
  updatedAt: z.number().int(),
});
export const vaultItemSummarySchema = vaultItemSchema.omit({ value: true });
export const vaultItemsResponseSchema = z.strictObject({
  items: z.array(vaultItemSummarySchema).max(100),
  nextCursor: idSchema.nullable(),
  idleExpiresAt: z.number().int(),
});
export const vaultListQuerySchema = z.strictObject({ cursor: idSchema.optional() });
export const vaultItemUpdateSchema = vaultItemContentSchema.extend({
  version: z.number().int().positive(),
});
export const vaultVersionSchema = z.strictObject({ version: z.number().int().positive() });
export const vaultResetAuthorizationSchema = z.strictObject({
  authorizationId: idSchema,
  expiresAt: z.number().int(),
});
export const vaultResetRequestSchema = z
  .strictObject({
    authorizationId: idSchema,
    passphrase: vaultPassphraseSchema,
    confirmation: vaultPassphraseSchema,
  })
  .refine((value) => value.passphrase === value.confirmation, {
    message: "The keys do not match",
    path: ["confirmation"],
  });
/** JSON Pointer; no prototype keys and no ambiguous dot-path interpretation. */
export const vaultArgumentPathSchema = z
  .string()
  .min(2)
  .max(500)
  .regex(/^(\/(?:[^~/]|~[01])*)+$/)
  .refine(
    (path) =>
      !path.split("/").some((part) => ["__proto__", "constructor", "prototype"].includes(part)),
  );
export const vaultGrantRequestSchema = z.strictObject({
  itemId: idSchema,
  itemVersion: z.number().int().positive(),
  taskId: idSchema,
  conversationId: idSchema,
  toolSlug: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/),
  argumentPath: vaultArgumentPathSchema,
  expiresAt: z.number().int().positive(),
});
export const vaultGrantResponseSchema = z.strictObject({
  id: idSchema,
  handle: z.strictObject({ $vault: idSchema }),
  expiresAt: z.number().int(),
});
export type VaultStatus = z.infer<typeof vaultStatusSchema>;
export type VaultItem = z.infer<typeof vaultItemSchema>;
export type VaultItemContent = z.infer<typeof vaultItemContentSchema>;
export type VaultItemsResponse = z.infer<typeof vaultItemsResponseSchema>;
export type VaultGrantRequest = z.infer<typeof vaultGrantRequestSchema>;
