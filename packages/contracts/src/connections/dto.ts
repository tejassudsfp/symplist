/**
 * REST request and response schemas owned by the connections feature (§14).
 * Export Zod schemas with a `connections`-specific name so the contracts index stays collision free.
 */
import { idSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";

export const connectionToolkitSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/);
export const connectionStartSchema = z.strictObject({
  toolkit: connectionToolkitSchema,
  alias: z.string().trim().min(1).max(120).optional(),
  replacesConnectionId: idSchema.optional(),
});
export type ConnectionStart = z.infer<typeof connectionStartSchema>;
export const connectionParamsSchema = z.strictObject({ id: idSchema });
export type ConnectionParams = z.infer<typeof connectionParamsSchema>;
export const connectionCallbackSchema = z.object({
  attempt: idSchema,
  n: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  session_uri: z.string().min(1).max(4096).optional(),
});
export type ConnectionCallback = z.infer<typeof connectionCallbackSchema>;
export const connectionViewSchema = z.strictObject({
  id: idSchema,
  toolkit: connectionToolkitSchema,
  alias: z.string().nullable(),
  status: z.enum(["active", "needs_attention", "disconnected"]),
  createdAt: z.number().int().nonnegative(),
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;
export const connectionsListSchema = z.strictObject({
  enabled: z.boolean(),
  connections: z.array(connectionViewSchema),
});
export const connectionCatalogueSchema = z.strictObject({
  enabled: z.boolean(),
  items: z.array(
    z.strictObject({
      slug: connectionToolkitSchema,
      name: z.string(),
      description: z.string(),
      auth: z.enum(["managed", "api_key", "none"]),
    }),
  ),
});
export type ConnectionCatalogue = z.infer<typeof connectionCatalogueSchema>;
export const connectionStartResultSchema = z.strictObject({
  attemptId: idSchema,
  expiresAt: z.number().int().nonnegative(),
  url: z.string().url().optional(),
  secretUnavailable: z.boolean(),
  notice: z.literal("secret.already_issued").optional(),
});
