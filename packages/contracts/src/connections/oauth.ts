import { idSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";
import { mcpScopesSchema, mcpTaskScopeSchema } from "./mcp.ts";

export const oauthConsentViewSchema = z.strictObject({
  id: idSchema,
  clientName: z.string().min(1).max(200),
  unverified: z.boolean(),
  metadataHost: z.string().nullable(),
  redirectHost: z.string(),
  loopbackOnly: z.boolean(),
  scopes: mcpScopesSchema,
  offlineAccess: z.boolean(),
  expiresAt: z.number().int(),
});
export type OAuthConsentView = z.infer<typeof oauthConsentViewSchema>;
export const oauthDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("allow"), taskIds: mcpTaskScopeSchema }),
  z.strictObject({ decision: z.literal("deny") }),
]);
export type OAuthDecision = z.infer<typeof oauthDecisionSchema>;
export const oauthDecisionResultSchema = z.strictObject({
  requestId: idSchema,
  redirectUrl: z.string().url().optional(),
  secretUnavailable: z.boolean(),
  notice: z.literal("secret.already_issued").optional(),
});
export const oauthAuthorizeSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  resource: z.string().min(1).max(2048),
  scope: z.string().min(1).max(128).default("tasks:read"),
  state: z.string().max(1024).optional(),
});
export type OAuthAuthorize = z.infer<typeof oauthAuthorizeSchema>;
export const oauthRegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(200),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
  application_type: z.enum(["native", "web"]),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .min(1)
    .max(2)
    .optional(),
  response_types: z.array(z.literal("code")).length(1).optional(),
});
export type OAuthRegistration = z.infer<typeof oauthRegistrationSchema>;
