import { z } from "./zod.ts";

/**
 * The canonical text form of a UUIDv7: lowercase hexadecimal with hyphens, version nibble 7 and an
 * RFC 9562 variant. Only this form is accepted, so one id never has two spellings in D1 rows, R2
 * keys (`u/<ownerId>/…`) or cache keys.
 */
export const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Entity identifiers are UUIDv7 strings (§3.4). They identify rows and objects but are never used
 * for ordering correctness; lists order by fractional `position` strings instead.
 */
export const idSchema = z
  .string({ error: "Expected a lowercase UUIDv7" })
  .regex(uuidV7Pattern, { error: "Expected a lowercase UUIDv7" });

/** A UUIDv7 identifier string. */
export type Id = z.infer<typeof idSchema>;

/**
 * A UUIDv7 schema branded with the entity it identifies, so a `TaskId` can never be passed where a
 * `RunId` is expected. Features declare their own ids with this helper.
 */
export function brandedIdSchema<const Brand extends string>(
  brand: Brand,
): z.core.$ZodBranded<typeof idSchema, Brand> {
  const schema = idSchema.describe(`${brand} (UUIDv7)`);
  // Zod's `brand<T>()` return type is conditional on `T`, which TypeScript cannot resolve for a
  // generic parameter; branding only changes the static type, so the concrete type is stated here.
  return schema.brand<Brand>() as unknown as z.core.$ZodBranded<typeof idSchema, Brand>;
}

/** Owner of every account-scoped row and the Composio user id (§14.1). */
export const userIdSchema = brandedIdSchema("UserId");
export type UserId = z.infer<typeof userIdSchema>;

/** A login session (`auth_sessions`); Vault sessions, OAuth requests and connect attempts bind to it. */
export const authSessionIdSchema = brandedIdSchema("AuthSessionId");
export type AuthSessionId = z.infer<typeof authSessionIdSchema>;

export const taskIdSchema = brandedIdSchema("TaskId");
export type TaskId = z.infer<typeof taskIdSchema>;

export const conversationIdSchema = brandedIdSchema("ConversationId");
export type ConversationId = z.infer<typeof conversationIdSchema>;

export const messageIdSchema = brandedIdSchema("MessageId");
export type MessageId = z.infer<typeof messageIdSchema>;

export const runIdSchema = brandedIdSchema("RunId");
export type RunId = z.infer<typeof runIdSchema>;

export const approvalIdSchema = brandedIdSchema("ApprovalId");
export type ApprovalId = z.infer<typeof approvalIdSchema>;

export const userAskIdSchema = brandedIdSchema("UserAskId");
export type UserAskId = z.infer<typeof userAskIdSchema>;

export const notificationIdSchema = brandedIdSchema("NotificationId");
export type NotificationId = z.infer<typeof notificationIdSchema>;

export const reminderIdSchema = brandedIdSchema("ReminderId");
export type ReminderId = z.infer<typeof reminderIdSchema>;

export const artifactIdSchema = brandedIdSchema("ArtifactId");
export type ArtifactId = z.infer<typeof artifactIdSchema>;

export const shareGrantIdSchema = brandedIdSchema("ShareGrantId");
export type ShareGrantId = z.infer<typeof shareGrantIdSchema>;

export const vaultItemIdSchema = brandedIdSchema("VaultItemId");
export type VaultItemId = z.infer<typeof vaultItemIdSchema>;

export const vaultGrantIdSchema = brandedIdSchema("VaultGrantId");
export type VaultGrantId = z.infer<typeof vaultGrantIdSchema>;

export const connectionIdSchema = brandedIdSchema("ConnectionId");
export type ConnectionId = z.infer<typeof connectionIdSchema>;

/** An API key or OAuth grant (`mcp_grants`, §14.4). */
export const mcpGrantIdSchema = brandedIdSchema("McpGrantId");
export type McpGrantId = z.infer<typeof mcpGrantIdSchema>;

export const inviteIdSchema = brandedIdSchema("InviteId");
export type InviteId = z.infer<typeof inviteIdSchema>;

/** The id of one WebSocket event frame (§7). */
export const eventIdSchema = brandedIdSchema("EventId");
export type EventId = z.infer<typeof eventIdSchema>;
