import { z } from "../common/zod.ts";

/**
 * The slice of the Agent Client Protocol wire the desktop chat UI reads, as zod schemas.
 *
 * Symplist drives the DeepSeek Harness over ACP (note 18), and the renderer projects the session's
 * `session/update` notifications into a transcript. Mirroring the shapes here rather than importing
 * `@agentclientprotocol/sdk` keeps that dependency in the Electron main process, where the JSON-RPC
 * connection lives: the web bundle ships to the browser too, and a protocol SDK has no business in it.
 *
 * Only what the UI renders is modelled. Everything else on an update — `_meta`, annotations, audio,
 * embedded resources — is carried through as unknown or dropped, and an update whose `sessionUpdate`
 * this file does not know is **ignored rather than rejected** (`parseAcpUpdate` returns null). A dsh
 * upgrade that adds an update kind must not be able to blank the chat pane.
 *
 * What `dsh-acp` actually emits was read off its build rather than assumed, and two of its choices
 * shape everything downstream:
 *
 * - `tool_call` carries `title: <the tool's programmatic name>` and a hardcoded `kind: "other"`. The
 *   ACP `kind` therefore says nothing, and both the human label and the icon have to come from the
 *   tool name — see `apps/web/src/features/simon/tool-labels.ts`.
 * - `session/request_permission` sends `toolCall: { toolCallId }` and nothing else. The card that asks
 *   the person has to join that id against the tool call already in the projection, or it would be
 *   asking them to approve a bare identifier.
 */

/** ACP content blocks. The harness only ever sends text; the rest are named so they can be skipped. */
export const acpContentBlockSchema = z.union([
  z.looseObject({ type: z.literal("text"), text: z.string() }),
  z.looseObject({ type: z.literal("image") }),
  z.looseObject({ type: z.literal("audio") }),
  z.looseObject({ type: z.literal("resource_link"), uri: z.string(), name: z.string().optional() }),
  z.looseObject({ type: z.literal("resource") }),
]);
export type AcpContentBlock = z.infer<typeof acpContentBlockSchema>;

/** The plain text of a content block, or "" for a block that carries none. */
export function acpBlockText(block: AcpContentBlock): string {
  return block.type === "text" ? block.text : "";
}

export const acpToolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type AcpToolCallStatus = z.infer<typeof acpToolCallStatusSchema>;

export const acpToolKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
export type AcpToolKind = z.infer<typeof acpToolKindSchema>;

/**
 * A tool call's output. `dsh-acp` only ever produces `content`, but `diff` is cheap to model and a
 * client that drops an unknown content entry silently is worse than one that carries it.
 */
export const acpToolCallContentSchema = z.union([
  z.looseObject({ type: z.literal("content"), content: acpContentBlockSchema }),
  z.looseObject({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().nullish(),
    newText: z.string(),
  }),
  z.looseObject({ type: z.literal("terminal"), terminalId: z.string() }),
]);
export type AcpToolCallContent = z.infer<typeof acpToolCallContentSchema>;

export const acpToolCallLocationSchema = z.looseObject({
  path: z.string(),
  line: z.number().int().nullish(),
});
export type AcpToolCallLocation = z.infer<typeof acpToolCallLocationSchema>;

const contentChunkFields = {
  content: acpContentBlockSchema,
  messageId: z.string().nullish(),
};

/**
 * A session configuration option. The harness advertises the model route as a `select`, which is how
 * the chat pane offers a model without knowing anything about providers.
 */
export const acpConfigOptionSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  category: z.string().nullish(),
  type: z.enum(["select", "boolean"]),
  currentValue: z.union([z.string(), z.boolean()]),
  options: z
    .array(
      z.looseObject({
        value: z.string(),
        name: z.string(),
        description: z.string().nullish(),
      }),
    )
    .optional(),
});
export type AcpConfigOption = z.infer<typeof acpConfigOptionSchema>;

/**
 * The six updates `dsh-acp` emits, plus the kinds ACP defines that it does not. Modelling the ones it
 * never sends would be pretending to a richness the wire does not have, so they are absent and
 * `parseAcpUpdate` drops them; a later harness that starts sending plans can add them here.
 */
export const acpSessionUpdateSchema = z.union([
  z.looseObject({ sessionUpdate: z.literal("agent_message_chunk"), ...contentChunkFields }),
  z.looseObject({ sessionUpdate: z.literal("agent_thought_chunk"), ...contentChunkFields }),
  z.looseObject({ sessionUpdate: z.literal("user_message_chunk"), ...contentChunkFields }),
  z.looseObject({
    sessionUpdate: z.literal("tool_call"),
    toolCallId: z.string(),
    title: z.string(),
    name: z.string().nullish(),
    kind: acpToolKindSchema.optional(),
    status: acpToolCallStatusSchema.optional(),
    content: z.array(acpToolCallContentSchema).optional(),
    locations: z.array(acpToolCallLocationSchema).optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
  }),
  z.looseObject({
    sessionUpdate: z.literal("tool_call_update"),
    toolCallId: z.string(),
    title: z.string().nullish(),
    name: z.string().nullish(),
    kind: acpToolKindSchema.nullish(),
    status: acpToolCallStatusSchema.nullish(),
    content: z.array(acpToolCallContentSchema).nullish(),
    locations: z.array(acpToolCallLocationSchema).nullish(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
  }),
  z.looseObject({
    sessionUpdate: z.literal("usage_update"),
    used: z.number(),
    size: z.number(),
  }),
  z.looseObject({
    sessionUpdate: z.literal("config_option_update"),
    configOptions: z.array(acpConfigOptionSchema),
  }),
]);
export type AcpSessionUpdate = z.infer<typeof acpSessionUpdateSchema>;

/**
 * One update, or null when it is not one this UI renders. Malformed and unknown are the same answer on
 * purpose: the caller's only sensible response to either is to store the row and draw nothing.
 */
export function parseAcpUpdate(value: unknown): AcpSessionUpdate | null {
  const parsed = acpSessionUpdateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const acpPermissionOptionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
export type AcpPermissionOptionKind = z.infer<typeof acpPermissionOptionKindSchema>;

export const acpPermissionOptionSchema = z.looseObject({
  optionId: z.string(),
  name: z.string(),
  kind: acpPermissionOptionKindSchema,
});
export type AcpPermissionOption = z.infer<typeof acpPermissionOptionSchema>;

/**
 * A `session/request_permission` the main process is waiting on, with the id the answer must quote.
 *
 * `toolCall` is modelled as a `tool_call_update` because that is what ACP says it is, but the harness
 * fills in only `toolCallId`: the options and the tool call the projection already holds are what make
 * the card readable. The options are rendered in the order they arrive and labelled by `name` — the
 * harness offers exactly allow-once and reject-once, and inventing an "always" it does not honour
 * would be lying to the person about what they just agreed to.
 */
export const acpPermissionRequestSchema = z.looseObject({
  requestId: z.string(),
  sessionId: z.string(),
  toolCall: z.looseObject({
    toolCallId: z.string(),
    title: z.string().nullish(),
    kind: acpToolKindSchema.nullish(),
    rawInput: z.unknown().optional(),
    locations: z.array(acpToolCallLocationSchema).nullish(),
  }),
  options: z.array(acpPermissionOptionSchema),
});
export type AcpPermissionRequest = z.infer<typeof acpPermissionRequestSchema>;

/**
 * Why a turn ended.
 *
 * Read this narrowly. `dsh-acp`'s codec maps the harness's `completed`, `aborted`, `blocked` and
 * `error` endings all onto `end_turn`, so a turn that failed and a turn that finished are the same
 * value here. The UI must not claim to know which happened; a genuine failure reaches us as a
 * rejected `session/prompt` instead.
 */
export const acpStopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);
export type AcpStopReason = z.infer<typeof acpStopReasonSchema>;
