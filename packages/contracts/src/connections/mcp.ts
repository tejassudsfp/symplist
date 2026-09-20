import { idSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";

export const mcpScopeSchema = z.enum(["tasks:read", "tasks:write", "ai:run"]);
export type McpScope = z.infer<typeof mcpScopeSchema>;
export const mcpScopesSchema = z
  .array(mcpScopeSchema)
  .min(1)
  .max(3)
  .refine((scopes) => new Set(scopes).size === scopes.length, "Permissions must be unique");
export const mcpTaskScopeSchema = z
  .array(idSchema)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "Tasks must be unique")
  .nullable();
export const mcpCreateKeySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  scopes: mcpScopesSchema,
  taskIds: mcpTaskScopeSchema,
});
export type McpCreateKey = z.infer<typeof mcpCreateKeySchema>;
export const mcpGrantViewSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["api_key", "oauth"]),
  name: z.string(),
  scopes: mcpScopesSchema,
  taskIds: mcpTaskScopeSchema,
  createdAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
  expiresAt: z.number().int(),
  revokedAt: z.number().int().nullable(),
});
export type McpGrantView = z.infer<typeof mcpGrantViewSchema>;
export const mcpGrantListSchema = z.strictObject({
  server: z.string().url(),
  grants: z.array(mcpGrantViewSchema),
});
export const mcpKeyResultSchema = z.strictObject({
  id: idSchema,
  key: z.string().optional(),
  expiresAt: z.number().int(),
  secretUnavailable: z.boolean(),
  notice: z.literal("secret.already_issued").optional(),
});
