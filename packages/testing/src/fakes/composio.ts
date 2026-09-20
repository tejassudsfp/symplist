import { createHmac, timingSafeEqual } from "node:crypto";
import { type Clock, FakeClock } from "./clock.ts";

/**
 * An in-memory stand-in for the `@composio/core` 0.18.1 surface Symplist uses (§14.1-§14.3, research
 * "Composio"): per-user sessions (`sessions.create`/`use`, `session.execute`, `update`, `authorize`,
 * `delete`), the raw client (`getClient().toolkits.list` with cursors, `connectedAccounts.delete`
 * with `revoke_on_delete`, and the no-retry `withOptions({ maxRetries: 0 }).toolRouter.session.execute`),
 * auth configs with the 50-item page cap, Connect Links and connected accounts, and signed webhook
 * parsing. It records every call, including how many times each execution was attempted, so tests
 * can prove a write action was sent exactly once.
 */

export type FakeConnectedAccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

export interface FakeToolkit {
  readonly slug: string;
  readonly name: string;
  readonly type: "native" | "custom";
  readonly auth_schemes: readonly string[];
  readonly composio_managed_auth_schemes: readonly string[];
  readonly no_auth: boolean;
  readonly meta: {
    readonly description: string;
    readonly logo: string;
    readonly categories: readonly string[];
    readonly tools_count: number;
    readonly triggers_count: number;
    readonly version: string;
  };
}

export interface FakeSessionConfig {
  readonly toolkits?:
    | readonly string[]
    | { readonly enable?: readonly string[]; readonly disable?: readonly string[] };
  readonly sandbox?: { readonly enable: boolean };
  readonly manageConnections?: boolean;
  readonly multiAccount?: {
    readonly enable: boolean;
    readonly maxAccountsPerToolkit?: number;
    readonly requireExplicitSelection?: boolean;
  };
  readonly connectedAccounts?: Readonly<Record<string, readonly string[]>>;
  readonly authConfigs?: Readonly<Record<string, string>>;
}

export interface FakeAuthConfig {
  readonly id: string;
  readonly toolkit: { readonly slug: string };
  readonly authScheme: string;
  readonly isComposioManaged: boolean;
  readonly status: "ENABLED" | "DISABLED";
  readonly name: string;
}

export interface FakeConnectedAccount {
  readonly id: string;
  readonly status: FakeConnectedAccountStatus;
  readonly statusReason: string | null;
  readonly isDisabled: boolean;
  readonly alias: string | null;
  readonly toolkit: { readonly slug: string };
  readonly authConfig: { readonly id: string; readonly isComposioManaged: boolean };
  readonly createdAt: string;
}

export interface FakeConnectionRequest {
  readonly id: string;
  readonly status: FakeConnectedAccountStatus;
  readonly redirectUrl: string;
}

/** What a scripted tool returns for one attempt. */
export type FakeToolOutcome =
  | { readonly data: Record<string, unknown>; readonly error?: string | null }
  | { readonly httpError: number; readonly retryAfterSeconds?: number; readonly slug?: string }
  | { readonly timeout: true };

export interface FakeToolCall {
  readonly sessionId: string;
  readonly userId: string;
  readonly slug: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly account: string | undefined;
  readonly attempt: number;
}

export type FakeToolHandler = (call: FakeToolCall) => FakeToolOutcome | Promise<FakeToolOutcome>;

export interface FakeExecutionRecord {
  readonly sessionId: string;
  readonly slug: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly account: string | undefined;
  /** `session` is `session.execute` (SDK default client); `raw` is `getClient().toolRouter.session.execute`. */
  readonly client: "session" | "raw";
  readonly maxRetries: number;
  /** How many times the tool actually ran, retries included. */
  readonly attempts: number;
  readonly outcome: "success" | "tool_error" | "http_error" | "timeout" | "rejected";
}

export interface FakeDeletionRecord {
  readonly connectedAccountId: string;
  readonly revokeOnDelete: boolean;
  readonly via: "sdk" | "raw";
}

export interface FakeLinkRecord {
  readonly userId: string;
  readonly authConfigId: string;
  readonly toolkit: string;
  readonly connectedAccountId: string;
  readonly callbackUrl: string;
  readonly alias: string | null;
  readonly allowMultiple: boolean;
}

/** The raw `@composio/client` `APIError` shape: detected by `status` and `error`, not `instanceof`. */
export class FakeComposioApiError extends Error {
  override readonly name: string = "APIError";
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly error: {
    readonly message: string;
    readonly code: number;
    readonly slug: string;
    readonly status: number;
    readonly request_id: string;
  };

  constructor(status: number, slug: string, message: string, headers: Record<string, string> = {}) {
    super(`${status} ${message}`);
    this.status = status;
    this.headers = headers;
    this.error = { message, code: status * 10, slug, status, request_id: `req_fake_${slug}` };
  }
}

/** The client's connection timeout, which the default client retries. */
export class FakeComposioTimeoutError extends Error {
  override readonly name = "APIConnectionTimeoutError";
}

/** Core `ComposioError` family: carries `code`, `possibleFixes` and, for some errors, `statusCode`. */
export class FakeComposioError extends Error {
  override readonly name: string;
  readonly code: string;
  readonly possibleFixes: readonly string[];
  readonly statusCode: number | undefined;
  constructor(name: string, code: string, message: string, statusCode?: number) {
    super(message);
    this.name = name;
    this.code = code;
    this.possibleFixes = [];
    this.statusCode = statusCode;
  }
}

export interface FakeSessionExecuteResult {
  readonly data: Record<string, unknown>;
  readonly error: string | null;
  readonly logId: string;
}

export interface FakeRawExecuteResult {
  readonly data: Record<string, unknown>;
  readonly error: string | null;
  readonly log_id: string;
}

export interface FakeComposioSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly config: FakeSessionConfig;
  execute(
    slug: string,
    args: Record<string, unknown>,
    options?: { readonly account?: string },
  ): Promise<FakeSessionExecuteResult>;
  update(patch: FakeSessionConfig): Promise<void>;
  authorize(
    toolkit: string,
    options: { readonly callbackUrl: string; readonly alias?: string },
  ): Promise<FakeConnectionRequest>;
  delete(): Promise<{ readonly sessionId: string; readonly deleted: boolean }>;
}

export interface FakeToolkitsPage {
  readonly items: readonly FakeToolkit[];
  readonly next_cursor: string | null;
  readonly total_pages: number;
  readonly current_page: number;
  readonly total_items: number;
}

export interface FakeComposioRawClient {
  readonly maxRetries: number;
  withOptions(options: { readonly maxRetries?: number }): FakeComposioRawClient;
  readonly toolkits: {
    list(query?: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly managed_by?: "composio" | "all" | "project";
      readonly sort_by?: "usage" | "alphabetically";
    }): Promise<FakeToolkitsPage>;
  };
  readonly connectedAccounts: {
    delete(
      id: string,
      query?: { readonly revoke_on_delete?: boolean },
    ): Promise<{ readonly success: boolean }>;
  };
  readonly toolRouter: {
    readonly session: {
      execute(
        sessionId: string,
        body: {
          readonly tool_slug: string;
          readonly arguments?: Record<string, unknown>;
          readonly account?: string;
        },
      ): Promise<FakeRawExecuteResult>;
      executeMeta(
        sessionId: string,
        body: { readonly slug: string; readonly arguments?: Record<string, unknown> },
      ): Promise<FakeRawExecuteResult>;
    };
  };
}

/**
 * `IncomingTriggerPayload` of `@composio/core` 0.18.1: the normalized webhook payload `triggers.parse`
 * returns for every payload version, mirrored field for field.
 */
export interface FakeIncomingTriggerPayload {
  readonly id: string;
  readonly uuid: string;
  readonly triggerSlug: string;
  readonly toolkitSlug: string;
  readonly userId: string;
  readonly payload?: Record<string, unknown>;
  readonly originalPayload?: Record<string, unknown>;
  readonly metadata: {
    readonly id: string;
    readonly uuid: string;
    readonly toolkitSlug: string;
    readonly triggerSlug: string;
    readonly triggerData?: string;
    readonly triggerConfig: Record<string, unknown>;
    readonly connectedAccount: {
      readonly id: string;
      readonly uuid: string;
      readonly authConfigId: string;
      readonly authConfigUUID: string;
      readonly userId: string;
      readonly status: "ACTIVE" | "INACTIVE";
    };
  };
}

/** `WebhookPayloadV3`: the generic envelope of every `composio.*` event. */
export interface FakeWebhookPayloadV3 {
  readonly id: string;
  readonly timestamp: string;
  readonly type: string;
  readonly metadata: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

/** `WebhookPayloadV2`. */
export interface FakeWebhookPayloadV2 {
  readonly type: string;
  readonly timestamp: string;
  readonly log_id: string;
  readonly data: {
    readonly connection_id: string;
    readonly connection_nano_id: string;
    readonly trigger_nano_id: string;
    readonly trigger_id: string;
    readonly user_id: string;
  } & Readonly<Record<string, unknown>>;
}

/** `WebhookPayloadV1`, the legacy trigger payload. */
export interface FakeWebhookPayloadV1 {
  readonly trigger_name: string;
  readonly connection_id: string;
  readonly trigger_id: string;
  readonly payload: Record<string, unknown>;
  readonly log_id: string;
}

/** `WebhookPayload`: the raw payload after schema parsing, which drops unknown top-level keys. */
export type FakeWebhookPayload = FakeWebhookPayloadV3 | FakeWebhookPayloadV2 | FakeWebhookPayloadV1;

/** `VerifyWebhookResult` of `triggers.parse`. */
export interface FakeWebhookParseResult {
  readonly version: "V1" | "V2" | "V3";
  readonly payload: FakeIncomingTriggerPayload;
  readonly rawPayload: FakeWebhookPayload;
}

/** The V3 event type Composio sends when a connected account's credentials expire (§14.3). */
export const composioConnectedAccountExpiredType = "composio.connected_account.expired";

export interface ConnectedAccountExpiredEventOptions {
  /** The event id (`msg_…`), which equals the `webhook-id` header and is stable across retries. */
  readonly id: string;
  readonly connectedAccountId: string;
  /** The Composio user id, which equals the Symplist user id (§14.1). */
  readonly userId: string;
  readonly toolkit: string;
  readonly authConfigId: string;
  /** ISO 8601 event time. */
  readonly timestamp: string;
  readonly alias?: string | null;
  readonly isComposioManaged?: boolean;
  readonly statusReason?: string | null;
}

/**
 * A `composio.connected_account.expired` event body in the documented V3 shape
 * (docs.composio.dev webhook event reference): project and org ids in `metadata`, and the connected
 * account record, with status `EXPIRED`, in `data`.
 */
export function composioConnectedAccountExpiredEvent(
  options: ConnectedAccountExpiredEventOptions,
): FakeWebhookPayloadV3 {
  return {
    id: options.id,
    type: composioConnectedAccountExpiredType,
    timestamp: options.timestamp,
    metadata: { project_id: "proj_fake", org_id: "org_fake" },
    data: {
      id: options.connectedAccountId,
      toolkit: { slug: options.toolkit },
      auth_config: {
        id: options.authConfigId,
        auth_scheme: "OAUTH2",
        is_composio_managed: options.isComposioManaged ?? true,
        is_disabled: false,
      },
      word_id: null,
      alias: options.alias ?? null,
      user_id: options.userId,
      status: "EXPIRED",
      created_at: options.timestamp,
      updated_at: options.timestamp,
      state: { authScheme: "OAUTH2", val: { status: "EXPIRED" } },
      data: {},
      params: {},
      status_reason: options.statusReason ?? "Connected account authentication expired.",
      is_disabled: false,
    },
  };
}

interface SessionState {
  readonly sessionId: string;
  readonly userId: string;
  config: FakeSessionConfig;
  deleted: boolean;
}

interface AccountState {
  readonly id: string;
  readonly userId: string;
  readonly toolkit: string;
  readonly authConfigId: string;
  readonly alias: string | null;
  readonly callbackUrl: string;
  readonly createdAt: number;
  status: FakeConnectedAccountStatus;
  deleted: boolean;
}

const retryableStatuses = new Set([408, 409, 429]);
const sandboxTools = new Set(["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"]);
const metaToolPrefix = "COMPOSIO_";
/** The default `@composio/client` retry budget (`maxRetries: 2`). */
export const composioDefaultMaxRetries = 2;

function toolkitOfSlug(slug: string): string {
  return (slug.split("_")[0] ?? slug).toLowerCase();
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    if (
      typeof parsed.offset === "number" &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return parsed.offset;
    }
  } catch {
    // Fall through to the error below.
  }
  throw new FakeComposioApiError(400, "Pagination_InvalidCursor", "Invalid cursor");
}

/** Reads a header case-insensitively from `Headers` or a Node-style record, as the SDK does. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof headers !== "object" || headers === null) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.find((item) => typeof item === "string");
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function webhookPayloadError(message: string): FakeComposioError {
  return new FakeComposioError(
    "ComposioWebhookPayloadError",
    "TS-SDK::WEBHOOK_PAYLOAD_INVALID",
    message,
    400,
  );
}

function webhookSignatureError(message: string): FakeComposioError {
  return new FakeComposioError(
    "ComposioWebhookSignatureVerificationError",
    "TS-SDK::WEBHOOK_SIGNATURE_VERIFICATION_FAILED",
    message,
    401,
  );
}

/** Verifies `v1,<base64 HMAC-SHA256(id.timestamp.body)>` entries of `webhook-signature`. */
function verifyWebhookSignature(input: {
  readonly id: string;
  readonly timestamp: string;
  readonly body: string;
  readonly signature: string;
  readonly secret: string;
}): void {
  if (input.body.length === 0) throw webhookSignatureError("No webhook payload was provided.");
  const provided = input.signature
    .split(" ")
    .map((entry) => entry.split(","))
    .flatMap(([version, value]) => (version === "v1" && value ? [value] : []));
  if (provided.length === 0) {
    throw webhookSignatureError("No valid v1 signature found in the webhook-signature header.");
  }
  const expected = Buffer.from(
    createHmac("sha256", input.secret)
      .update(`${input.id}.${input.timestamp}.${input.body}`)
      .digest("base64"),
  );
  const valid = provided.some((value) => {
    const candidate = Buffer.from(value);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!valid) throw webhookSignatureError("The signature provided is invalid.");
}

/** A JSON object, which is what the SDK's Zod `record` and `object` schemas accept. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFields<const Name extends string>(
  record: Record<string, unknown>,
  names: readonly Name[],
): Record<Name, string> | undefined {
  const fields = {} as Record<Name, string>;
  for (const name of names) {
    const value = record[name];
    if (typeof value !== "string") return undefined;
    fields[name] = value;
  }
  return fields;
}

const emptyConnectedAccount = {
  id: "",
  uuid: "",
  authConfigId: "",
  authConfigUUID: "",
  userId: "",
  status: "ACTIVE",
} as const;

function normalizedPayload(input: {
  readonly id: string;
  readonly uuid: string;
  readonly triggerSlug: string;
  readonly toolkitSlug: string;
  readonly userId: string;
  readonly payload: Record<string, unknown>;
  readonly originalPayload: Record<string, unknown>;
  readonly connectedAccount: FakeIncomingTriggerPayload["metadata"]["connectedAccount"];
}): FakeIncomingTriggerPayload {
  return {
    id: input.id,
    uuid: input.uuid,
    triggerSlug: input.triggerSlug,
    toolkitSlug: input.toolkitSlug,
    userId: input.userId,
    payload: input.payload,
    originalPayload: input.originalPayload,
    metadata: {
      id: input.id,
      uuid: input.uuid,
      toolkitSlug: input.toolkitSlug,
      triggerSlug: input.triggerSlug,
      triggerConfig: {},
      connectedAccount: input.connectedAccount,
    },
  };
}

/** The upper-cased first `_` segment of a trigger slug, or `UNKNOWN`. */
function toolkitOfTriggerSlug(slug: string): string {
  return slug.split("_")[0]?.toUpperCase() || "UNKNOWN";
}

function parseV3(record: Record<string, unknown>): FakeWebhookParseResult | undefined {
  const fields = stringFields(record, ["id", "timestamp", "type"]);
  if (!fields?.type.startsWith("composio.")) return undefined;
  if (!isJsonObject(record.metadata) || !isJsonObject(record.data)) return undefined;
  const rawPayload: FakeWebhookPayloadV3 = {
    id: fields.id,
    timestamp: fields.timestamp,
    type: fields.type,
    metadata: { ...record.metadata },
    data: { ...record.data },
  };
  const trigger = stringFields(rawPayload.metadata, [
    "log_id",
    "trigger_slug",
    "trigger_id",
    "connected_account_id",
    "auth_config_id",
    "user_id",
  ]);
  if (trigger) {
    return {
      version: "V3",
      rawPayload,
      payload: normalizedPayload({
        id: trigger.trigger_id,
        uuid: trigger.trigger_id,
        triggerSlug: trigger.trigger_slug,
        toolkitSlug: toolkitOfTriggerSlug(trigger.trigger_slug),
        userId: trigger.user_id,
        payload: rawPayload.data,
        originalPayload: rawPayload.data,
        connectedAccount: {
          id: trigger.connected_account_id,
          uuid: trigger.connected_account_id,
          authConfigId: trigger.auth_config_id,
          authConfigUUID: trigger.auth_config_id,
          userId: trigger.user_id,
          status: "ACTIVE",
        },
      }),
    };
  }
  // Lifecycle events such as composio.connected_account.expired carry no trigger metadata.
  return {
    version: "V3",
    rawPayload,
    payload: normalizedPayload({
      id: rawPayload.id,
      uuid: rawPayload.id,
      triggerSlug: rawPayload.type,
      toolkitSlug: "COMPOSIO",
      userId: "",
      payload: rawPayload.data,
      originalPayload: { ...rawPayload },
      connectedAccount: emptyConnectedAccount,
    }),
  };
}

function parseV2(record: Record<string, unknown>): FakeWebhookParseResult | undefined {
  const fields = stringFields(record, ["type", "timestamp", "log_id"]);
  if (!fields || !isJsonObject(record.data)) return undefined;
  const ids = stringFields(record.data, [
    "connection_id",
    "connection_nano_id",
    "trigger_nano_id",
    "trigger_id",
    "user_id",
  ]);
  if (!ids) return undefined;
  const rawPayload: FakeWebhookPayloadV2 = { ...fields, data: { ...record.data, ...ids } };
  const {
    connection_id: _connectionId,
    connection_nano_id: _connectionNanoId,
    trigger_nano_id: _triggerNanoId,
    trigger_id: _triggerId,
    user_id: _userId,
    ...rest
  } = rawPayload.data;
  const triggerSlug = fields.type.toUpperCase();
  return {
    version: "V2",
    rawPayload,
    payload: normalizedPayload({
      id: ids.trigger_nano_id,
      uuid: ids.trigger_id,
      triggerSlug,
      toolkitSlug: triggerSlug.split("_")[0] || "UNKNOWN",
      userId: ids.user_id,
      payload: rest,
      originalPayload: rest,
      connectedAccount: {
        id: ids.connection_nano_id,
        uuid: ids.connection_id,
        authConfigId: "",
        authConfigUUID: "",
        userId: ids.user_id,
        status: "ACTIVE",
      },
    }),
  };
}

function parseV1(record: Record<string, unknown>): FakeWebhookParseResult | undefined {
  const fields = stringFields(record, ["trigger_name", "connection_id", "trigger_id", "log_id"]);
  if (!fields || !isJsonObject(record.payload)) return undefined;
  const rawPayload: FakeWebhookPayloadV1 = { ...fields, payload: { ...record.payload } };
  return {
    version: "V1",
    rawPayload,
    payload: normalizedPayload({
      id: fields.trigger_id,
      uuid: fields.trigger_id,
      triggerSlug: fields.trigger_name,
      toolkitSlug: toolkitOfTriggerSlug(fields.trigger_name),
      userId: "",
      payload: rawPayload.payload,
      originalPayload: rawPayload.payload,
      connectedAccount: {
        ...emptyConnectedAccount,
        id: fields.connection_id,
        uuid: fields.connection_id,
      },
    }),
  };
}

/** Detects the payload version (V3, then V2, then V1) and normalizes it as the SDK does. */
function parseWebhookPayload(raw: string): FakeWebhookParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw webhookPayloadError("Failed to parse webhook payload as JSON");
  }
  const result = isJsonObject(parsed)
    ? (parseV3(parsed) ?? parseV2(parsed) ?? parseV1(parsed))
    : undefined;
  if (!result) {
    throw webhookPayloadError(
      "Webhook payload does not match any known version (V1, V2, or V3). Please ensure you are using a supported webhook payload format.",
    );
  }
  return result;
}

/** Signs a webhook body the way Composio does: `v1,<base64 HMAC-SHA256(id.timestamp.body)>`. */
export function signComposioWebhook(options: {
  readonly secret: string;
  readonly body: string;
  readonly id: string;
  readonly timestamp: number;
}): Record<string, string> {
  const signature = createHmac("sha256", options.secret)
    .update(`${options.id}.${options.timestamp}.${options.body}`)
    .digest("base64");
  return {
    "webhook-id": options.id,
    "webhook-timestamp": String(options.timestamp),
    "webhook-signature": `v1,${signature}`,
    "x-composio-webhook-version": "V3",
  };
}

/** A small default catalogue covering managed OAuth, user API keys and no-auth toolkits. */
export const defaultFakeToolkits: readonly FakeToolkit[] = [
  ["gmail", "Gmail", ["OAUTH2"], ["OAUTH2"], false],
  ["github", "GitHub", ["OAUTH2"], ["OAUTH2"], false],
  ["googlecalendar", "Google Calendar", ["OAUTH2"], ["OAUTH2"], false],
  ["notion", "Notion", ["OAUTH2"], ["OAUTH2"], false],
  ["slack", "Slack", ["OAUTH2"], ["OAUTH2"], false],
  ["perplexityai", "Perplexity AI", ["API_KEY"], [], false],
  ["salesforce", "Salesforce", ["OAUTH2"], [], false],
  ["hackernews", "Hacker News", [], [], true],
].map(([slug, name, schemes, managed, noAuth]) => ({
  slug: slug as string,
  name: name as string,
  type: "native" as const,
  auth_schemes: schemes as string[],
  composio_managed_auth_schemes: managed as string[],
  no_auth: noAuth as boolean,
  meta: {
    description: `${name as string} toolkit`,
    logo: `https://logos.composio.example/${slug as string}.png`,
    categories: [],
    tools_count: 10,
    triggers_count: 0,
    version: "20260901_00",
  },
}));

export interface FakeComposioClientOptions {
  readonly clock?: Clock;
  readonly toolkits?: readonly FakeToolkit[];
}

export class FakeComposioClient {
  readonly clock: Clock;
  readonly sessionsCreated: Array<{
    readonly userId: string;
    readonly sessionId: string;
    readonly config: FakeSessionConfig;
  }> = [];
  readonly sessionUpdates: Array<{
    readonly sessionId: string;
    readonly patch: FakeSessionConfig;
  }> = [];
  readonly executions: FakeExecutionRecord[] = [];
  readonly deletions: FakeDeletionRecord[] = [];
  readonly links: FakeLinkRecord[] = [];
  readonly authConfigsCreated: FakeAuthConfig[] = [];
  readonly toolkitListCalls: Array<{
    readonly limit: number;
    readonly cursor: string | undefined;
    readonly managed_by: string;
  }> = [];

  private readonly catalogue: FakeToolkit[];
  private readonly sessionStates = new Map<string, SessionState>();
  private readonly accounts = new Map<string, AccountState>();
  private readonly authConfigStates: FakeAuthConfig[] = [];
  private readonly toolHandlers = new Map<string, FakeToolHandler>();
  private sequence = 0;

  constructor(options: FakeComposioClientOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.catalogue = [...(options.toolkits ?? defaultFakeToolkits)];
  }

  /** Scripts a tool. Unscripted tools fail with 404 `Tool_ToolNotFound`. */
  setToolHandler(slug: string, handler: FakeToolHandler): void {
    this.toolHandlers.set(slug, handler);
  }

  /**
   * Simulates the user finishing (or failing) Composio's hosted auth. Returns the callback URL
   * Composio redirects to, with `status` and `connected_account_id` appended to existing parameters.
   */
  completeConnection(connectedAccountId: string, outcome: "ACTIVE" | "FAILED" = "ACTIVE"): string {
    const account = this.requireAccount(connectedAccountId);
    account.status = outcome;
    const url = new URL(account.callbackUrl);
    url.searchParams.set("status", outcome === "ACTIVE" ? "success" : "failed");
    url.searchParams.set("connected_account_id", account.id);
    return url.toString();
  }

  /** Changes an account's status, for expiry and reconcile tests. */
  setAccountStatus(connectedAccountId: string, status: FakeConnectedAccountStatus): void {
    this.requireAccount(connectedAccountId).status = status;
  }

  /** The user a connected account belongs to; Composio no longer returns it, so Symplist stores it. */
  accountOwner(connectedAccountId: string): string {
    return this.requireAccount(connectedAccountId).userId;
  }

  /** Whether an account was deleted upstream, and whether its tokens were revoked. */
  deletionOf(connectedAccountId: string): FakeDeletionRecord | undefined {
    return this.deletions.findLast((record) => record.connectedAccountId === connectedAccountId);
  }

  readonly sessions = {
    create: async (
      userId: string,
      config: FakeSessionConfig = {},
    ): Promise<FakeComposioSession> => {
      if (userId.trim() === "")
        throw new FakeComposioApiError(400, "Session_InvalidUser", "user_id is required");
      const maxAccounts = config.multiAccount?.maxAccountsPerToolkit;
      if (maxAccounts !== undefined && (maxAccounts < 2 || maxAccounts > 10)) {
        throw new FakeComposioApiError(
          400,
          "Session_InvalidConfig",
          "maxAccountsPerToolkit must be 2-10",
        );
      }
      const sessionId = this.nextId("trs");
      const state: SessionState = {
        sessionId,
        userId,
        config: structuredClone(config),
        deleted: false,
      };
      this.sessionStates.set(sessionId, state);
      this.sessionsCreated.push({ userId, sessionId, config: structuredClone(config) });
      return this.sessionHandle(state);
    },
    use: async (sessionId: string): Promise<FakeComposioSession> =>
      this.sessionHandle(this.requireSession(sessionId)),
  };

  readonly authConfigs = {
    list: async (
      query: {
        readonly toolkit?: string;
        readonly isComposioManaged?: boolean;
        readonly limit?: number;
        readonly cursor?: string;
      } = {},
    ): Promise<{
      readonly items: readonly FakeAuthConfig[];
      readonly nextCursor: string | null;
      readonly totalPages: number;
    }> => {
      const matching = this.authConfigStates.filter(
        (config) =>
          (query.toolkit === undefined || config.toolkit.slug === query.toolkit) &&
          (query.isComposioManaged === undefined ||
            config.isComposioManaged === query.isComposioManaged),
      );
      // Composio clamps auth config pages to 50 items.
      const limit = Math.max(1, Math.min(query.limit ?? 50, 50));
      const offset = decodeCursor(query.cursor);
      const items = matching.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < matching.length ? encodeCursor(nextOffset) : null,
        totalPages: Math.max(1, Math.ceil(matching.length / limit)),
      };
    },
    create: async (
      toolkit: string,
      options:
        | { readonly type: "use_composio_managed_auth"; readonly name?: string }
        | {
            readonly type: "use_custom_auth";
            readonly authScheme: string;
            readonly name?: string;
            readonly credentials?: Record<string, unknown>;
          },
    ): Promise<FakeAuthConfig> => {
      const entry = this.catalogue.find((item) => item.slug === toolkit);
      if (!entry) throw new FakeComposioApiError(404, "Toolkit_NotFound", "Toolkit not found");
      let authScheme: string;
      if (options.type === "use_composio_managed_auth") {
        const managed = entry.composio_managed_auth_schemes[0];
        if (managed === undefined) {
          throw new FakeComposioApiError(
            400,
            "AuthConfig_NoManagedAuth",
            "No Composio-managed auth for this toolkit",
          );
        }
        authScheme = managed;
      } else {
        if (!entry.auth_schemes.includes(options.authScheme)) {
          throw new FakeComposioApiError(
            400,
            "AuthConfig_InvalidScheme",
            "Unsupported auth scheme",
          );
        }
        authScheme = options.authScheme;
      }
      const config: FakeAuthConfig = {
        id: this.nextId("ac"),
        toolkit: { slug: toolkit },
        authScheme,
        isComposioManaged: options.type === "use_composio_managed_auth",
        status: "ENABLED",
        name: options.name ?? `${entry.name} auth`,
      };
      this.authConfigStates.push(config);
      this.authConfigsCreated.push(config);
      return config;
    },
  };

  readonly connectedAccounts = {
    link: async (
      userId: string,
      authConfigId: string,
      options: {
        readonly callbackUrl: string;
        readonly alias?: string;
        readonly allowMultiple?: boolean;
      },
    ): Promise<FakeConnectionRequest> => {
      const authConfig = this.authConfigStates.find((config) => config.id === authConfigId);
      if (!authConfig)
        throw new FakeComposioApiError(404, "AuthConfig_NotFound", "Auth config not found");
      return this.startLink(userId, authConfig, options);
    },
    get: async (id: string): Promise<FakeConnectedAccount> =>
      this.publicAccount(this.requireAccount(id)),
    list: async (
      query: {
        readonly userIds?: readonly string[];
        readonly toolkitSlugs?: readonly string[];
        readonly statuses?: readonly FakeConnectedAccountStatus[];
        readonly limit?: number;
        readonly cursor?: string;
      } = {},
    ): Promise<{
      readonly items: readonly FakeConnectedAccount[];
      readonly nextCursor: string | null;
    }> => {
      const matching = [...this.accounts.values()].filter(
        (account) =>
          !account.deleted &&
          (query.userIds === undefined || query.userIds.includes(account.userId)) &&
          (query.toolkitSlugs === undefined || query.toolkitSlugs.includes(account.toolkit)) &&
          (query.statuses === undefined || query.statuses.includes(account.status)),
      );
      const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
      const offset = decodeCursor(query.cursor);
      const items = matching.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        items: items.map((account) => this.publicAccount(account)),
        nextCursor: nextOffset < matching.length ? encodeCursor(nextOffset) : null,
      };
    },
    /** The SDK delete is a soft delete that never revokes upstream tokens (research §5). */
    delete: async (id: string): Promise<{ readonly success: boolean }> => {
      const account = this.requireAccount(id);
      account.deleted = true;
      this.deletions.push({ connectedAccountId: id, revokeOnDelete: false, via: "sdk" });
      return { success: true };
    },
  };

  readonly triggers = {
    /**
     * Mirrors `composio.triggers.parse` in `@composio/core` 0.18.1 (§14.3, research "Composio" §8):
     * with a `verifySecret` option it checks the `webhook-id`, `webhook-timestamp` and
     * `webhook-signature` headers, the timestamp tolerance (on this client's clock) and the
     * HMAC-SHA256 signature over the raw body; then it detects the V3, V2 or V1 payload in that order
     * and returns the SDK's `IncomingTriggerPayload` normalization with the schema-stripped raw payload.
     * A `composio.connected_account.expired` event is a V3 payload without trigger metadata, so its
     * normalized form carries the event id, `triggerSlug` = the event type, `toolkitSlug`
     * `COMPOSIO`, the account record as `payload` and the whole event as `originalPayload`; handlers
     * read the account from `rawPayload.data` after narrowing on `type`. Unlike the SDK, a request
     * whose body was already parsed into an object is refused even without verification, because
     * signature checks need the raw bytes (§6.2).
     */
    parse: async (
      request: Request | { readonly body: unknown; readonly headers: unknown },
      options?: { readonly verifySecret?: string; readonly tolerance?: number },
    ): Promise<FakeWebhookParseResult> => {
      const body = request instanceof Request ? await request.text() : request.body;
      const raw =
        typeof body === "string"
          ? body
          : body instanceof Uint8Array
            ? new TextDecoder().decode(body)
            : undefined;
      if (raw === undefined) {
        throw new FakeComposioError(
          "ValidationError",
          "TS-SDK::VALIDATION_ERROR",
          "Pass the raw, unparsed request body to triggers.parse()",
        );
      }
      if (options === undefined || !("verifySecret" in options)) return parseWebhookPayload(raw);
      const secret = options.verifySecret;
      if (!secret) {
        throw new FakeComposioError(
          "ValidationError",
          "TS-SDK::VALIDATION_ERROR",
          "Cannot verify webhook: 'verifySecret' was provided but is empty",
        );
      }
      const id = headerValue(request.headers, "webhook-id");
      const timestamp = headerValue(request.headers, "webhook-timestamp");
      const signature = headerValue(request.headers, "webhook-signature");
      if (!id || !timestamp || !signature) {
        throw new FakeComposioError(
          "ValidationError",
          "TS-SDK::VALIDATION_ERROR",
          "Cannot verify webhook: missing signature header(s)",
        );
      }
      const tolerance = options.tolerance ?? 300;
      if (tolerance > 0) {
        const seconds = Number.parseInt(timestamp, 10);
        if (Number.isNaN(seconds)) {
          throw webhookPayloadError(`Invalid webhook timestamp: ${timestamp}`);
        }
        if (Math.abs(this.clock.now() - seconds * 1000) > tolerance * 1000) {
          throw webhookSignatureError("The webhook timestamp is outside the allowed tolerance");
        }
      }
      verifyWebhookSignature({ id, timestamp, body: raw, signature, secret });
      return parseWebhookPayload(raw);
    },
  };

  /** The raw `@composio/client` with the default retry budget. */
  getClient(): FakeComposioRawClient {
    return this.rawClient(composioDefaultMaxRetries);
  }

  private rawClient(maxRetries: number): FakeComposioRawClient {
    return {
      maxRetries,
      withOptions: (options) => this.rawClient(options.maxRetries ?? maxRetries),
      toolkits: {
        list: async (query = {}) => {
          const limit = Math.max(1, Math.min(query.limit ?? 20, 1000));
          const managedBy = query.managed_by ?? "composio";
          this.toolkitListCalls.push({ limit, cursor: query.cursor, managed_by: managedBy });
          let items = this.catalogue.filter((toolkit) => {
            if (managedBy === "all") return true;
            if (managedBy === "composio") return toolkit.composio_managed_auth_schemes.length > 0;
            return this.authConfigStates.some((config) => config.toolkit.slug === toolkit.slug);
          });
          if (query.sort_by === "alphabetically") {
            items = [...items].sort((a, b) => a.name.localeCompare(b.name));
          }
          const offset = decodeCursor(query.cursor);
          const page = items.slice(offset, offset + limit);
          const nextOffset = offset + page.length;
          return {
            items: page,
            next_cursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
            total_pages: Math.max(1, Math.ceil(items.length / limit)),
            current_page: Math.floor(offset / limit) + 1,
            total_items: items.length,
          };
        },
      },
      connectedAccounts: {
        delete: async (id, query = {}) => {
          const account = this.requireAccount(id);
          account.deleted = true;
          const revokeOnDelete = query.revoke_on_delete === true;
          if (revokeOnDelete) account.status = "REVOKED";
          this.deletions.push({ connectedAccountId: id, revokeOnDelete, via: "raw" });
          return { success: true };
        },
      },
      toolRouter: {
        session: {
          execute: async (sessionId, body) => {
            const result = await this.execute(
              sessionId,
              body.tool_slug,
              body.arguments ?? {},
              body.account,
              "raw",
              maxRetries,
            );
            return { data: result.data, error: result.error, log_id: result.logId };
          },
          executeMeta: async (sessionId, body) => {
            if (!body.slug.startsWith(metaToolPrefix)) {
              throw new FakeComposioApiError(
                400,
                "ToolRouter_NotAMetaTool",
                "executeMeta only runs meta tools",
              );
            }
            const result = await this.execute(
              sessionId,
              body.slug,
              body.arguments ?? {},
              undefined,
              "raw",
              maxRetries,
            );
            return { data: result.data, error: result.error, log_id: result.logId };
          },
        },
      },
    };
  }

  private sessionHandle(state: SessionState): FakeComposioSession {
    return {
      sessionId: state.sessionId,
      userId: state.userId,
      config: state.config,
      execute: (slug, args, options = {}) =>
        this.execute(
          state.sessionId,
          slug,
          args,
          options.account,
          "session",
          composioDefaultMaxRetries,
        ),
      update: async (patch) => {
        const current = this.requireSession(state.sessionId);
        current.config = { ...current.config, ...structuredClone(patch) };
        this.sessionUpdates.push({ sessionId: state.sessionId, patch: structuredClone(patch) });
      },
      authorize: async (toolkit, options) => {
        const current = this.requireSession(state.sessionId);
        const pinned = current.config.authConfigs?.[toolkit];
        let authConfig =
          pinned === undefined
            ? undefined
            : this.authConfigStates.find((config) => config.id === pinned);
        authConfig ??= this.authConfigStates.find(
          (config) => config.toolkit.slug === toolkit && config.status === "ENABLED",
        );
        authConfig ??= await this.authConfigs.create(toolkit, {
          type: "use_composio_managed_auth",
        });
        return this.startLink(current.userId, authConfig, { ...options, allowMultiple: true });
      },
      delete: async () => {
        const current = this.requireSession(state.sessionId);
        current.deleted = true;
        return { sessionId: state.sessionId, deleted: true };
      },
    };
  }

  private startLink(
    userId: string,
    authConfig: FakeAuthConfig,
    options: {
      readonly callbackUrl: string;
      readonly alias?: string;
      readonly allowMultiple?: boolean;
    },
  ): FakeConnectionRequest {
    let callback: URL;
    try {
      callback = new URL(options.callbackUrl);
    } catch {
      throw new FakeComposioApiError(
        400,
        "ConnectedAccount_InvalidCallback",
        "callbackUrl must be absolute",
      );
    }
    const toolkit = authConfig.toolkit.slug;
    const existing = [...this.accounts.values()].filter(
      (account) => !account.deleted && account.userId === userId && account.toolkit === toolkit,
    );
    if (!options.allowMultiple && existing.some((account) => account.status === "ACTIVE")) {
      throw new FakeComposioApiError(
        400,
        "ConnectedAccount_MultipleAccountsNotAllowed",
        "An active account already exists; pass allowMultiple",
      );
    }
    const alias = options.alias ?? null;
    if (alias !== null && existing.some((account) => account.alias === alias)) {
      throw new FakeComposioApiError(
        409,
        "ConnectedAccount_AliasTaken",
        "Alias already used for this toolkit",
      );
    }
    const id = this.nextId("ca");
    this.accounts.set(id, {
      id,
      userId,
      toolkit,
      authConfigId: authConfig.id,
      alias,
      callbackUrl: callback.toString(),
      createdAt: this.clock.now(),
      status: "INITIATED",
      deleted: false,
    });
    this.links.push({
      userId,
      authConfigId: authConfig.id,
      toolkit,
      connectedAccountId: id,
      callbackUrl: callback.toString(),
      alias,
      allowMultiple: options.allowMultiple === true,
    });
    return {
      id,
      status: "INITIATED",
      redirectUrl: `https://connect.composio.dev/link/ln_${id.slice(3)}`,
    };
  }

  private async execute(
    sessionId: string,
    slug: string,
    args: Record<string, unknown>,
    account: string | undefined,
    client: "session" | "raw",
    maxRetries: number,
  ): Promise<FakeSessionExecuteResult> {
    const recordedArgs = structuredClone(args);
    const record = (attempts: number, outcome: FakeExecutionRecord["outcome"]) => {
      this.executions.push({
        sessionId,
        slug,
        arguments: recordedArgs,
        account,
        client,
        maxRetries,
        attempts,
        outcome,
      });
    };
    let state: SessionState;
    try {
      state = this.requireSession(sessionId);
      this.assertAllowed(state, slug, args, account);
    } catch (error) {
      record(0, "rejected");
      throw error;
    }
    const handler = this.toolHandlers.get(slug);
    if (!handler) {
      record(0, "rejected");
      throw new FakeComposioApiError(404, "Tool_ToolNotFound", `Tool ${slug} not found`);
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const outcome = await handler({
        sessionId,
        userId: state.userId,
        slug,
        arguments: structuredClone(args),
        account,
        attempt,
      });
      if ("data" in outcome) {
        const error = outcome.error ?? null;
        record(attempt, error === null ? "success" : "tool_error");
        return { data: outcome.data, error, logId: `log_fake_${this.nextId("log").slice(4)}` };
      }
      const retryable =
        "timeout" in outcome ||
        retryableStatuses.has(outcome.httpError) ||
        outcome.httpError >= 500;
      if (retryable && attempt <= maxRetries) continue;
      if ("timeout" in outcome) {
        record(attempt, "timeout");
        throw new FakeComposioTimeoutError("Request timed out.");
      }
      record(attempt, "http_error");
      throw new FakeComposioApiError(
        outcome.httpError,
        outcome.slug ?? "Tool_ExecutionFailed",
        "Tool execution failed",
        outcome.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(outcome.retryAfterSeconds) },
      );
    }
  }

  private assertAllowed(
    state: SessionState,
    slug: string,
    args: Record<string, unknown>,
    account: string | undefined,
  ): void {
    const { config } = state;
    if (sandboxTools.has(slug) && config.sandbox?.enable === false) {
      throw new FakeComposioApiError(
        400,
        "ToolRouter_SandboxDisabled",
        "The sandbox is disabled for this session",
      );
    }
    if (slug === "COMPOSIO_MANAGE_CONNECTIONS" && config.manageConnections === false) {
      throw new FakeComposioApiError(
        400,
        "ToolRouter_ManageConnectionsDisabled",
        "Connection management is disabled",
      );
    }
    if (
      slug === "COMPOSIO_MULTI_EXECUTE_TOOL" &&
      typeof args.sync_response_to_workbench !== "boolean"
    ) {
      throw new FakeComposioApiError(
        400,
        "ToolRouter_InvalidArguments",
        "sync_response_to_workbench is required",
      );
    }
    if (slug.startsWith(metaToolPrefix)) return;

    const toolkit = toolkitOfSlug(slug);
    const pins = config.connectedAccounts?.[toolkit];
    const candidates = [...this.accounts.values()].filter(
      (entry) =>
        !entry.deleted &&
        entry.userId === state.userId &&
        entry.toolkit === toolkit &&
        entry.status === "ACTIVE" &&
        (pins === undefined || pins.includes(entry.id)),
    );
    if (account !== undefined) {
      const selected = candidates.find((entry) => entry.id === account || entry.alias === account);
      if (!selected) {
        throw new FakeComposioApiError(
          400,
          "ToolRouter_AccountNotAvailable",
          "The selected account is not available",
        );
      }
      return;
    }
    if (candidates.length === 0) {
      throw new FakeComposioApiError(
        400,
        "ToolRouter_NoActiveConnection",
        `No active connection for ${toolkit}`,
      );
    }
    if (candidates.length > 1 && config.multiAccount?.requireExplicitSelection) {
      throw new FakeComposioError(
        "ComposioMultipleConnectedAccountsError",
        "TS-SDK::MULTIPLE_CONNECTED_ACCOUNTS",
        `Several ${toolkit} accounts are connected; select one`,
      );
    }
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessionStates.get(sessionId);
    if (!state || state.deleted)
      throw new FakeComposioApiError(404, "ToolRouter_SessionNotFound", "Session not found");
    return state;
  }

  private requireAccount(id: string): AccountState {
    const account = this.accounts.get(id);
    if (!account || account.deleted) {
      throw new FakeComposioApiError(
        404,
        "ConnectedAccount_NotFound",
        "Connected account not found",
      );
    }
    return account;
  }

  private publicAccount(account: AccountState): FakeConnectedAccount {
    const authConfig = this.authConfigStates.find((config) => config.id === account.authConfigId);
    return {
      id: account.id,
      status: account.status,
      statusReason: null,
      isDisabled: account.status === "INACTIVE",
      alias: account.alias,
      toolkit: { slug: account.toolkit },
      authConfig: {
        id: account.authConfigId,
        isComposioManaged: authConfig?.isComposioManaged ?? false,
      },
      createdAt: new Date(account.createdAt).toISOString(),
    };
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_fake${String(this.sequence).padStart(6, "0")}`;
  }
}
