import { z } from "zod";
import type { ComposioExecutionClient, ComposioSession } from "./client.ts";
import { IntegrationError, normalizeIntegrationError } from "./errors.ts";

export interface ExternalConnection {
  readonly id: string;
  readonly ownerId: string;
  readonly toolkit: string;
  readonly connectedAccountId: string;
  readonly generation: number;
}

export interface ExternalToolSchema {
  readonly slug: string;
  readonly toolkit: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
  readonly tags: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean };
}

export interface ResolvedExternalAction {
  readonly tool: ExternalToolSchema;
  readonly connection: ExternalConnection;
  readonly arguments: Record<string, unknown>;
}

export interface ConnectionToolAuthority {
  readonly ownerId: string;
  /** Fresh owner/access/run/generation check before every upstream operation. */
  check(): Promise<boolean>;
  /** Fresh, active, confirmed records only. Never upstream-inferred ownership. */
  connections(): Promise<readonly ExternalConnection[]>;
  /** One provider-free D1 batch for resolving several actions in the same tool call. */
  snapshot?(): Promise<{
    readonly authorized: boolean;
    readonly connections: readonly ExternalConnection[];
  }>;
  /** One exact fresh authority read immediately before a provider effect. */
  authorize?(expected: ExternalConnection): Promise<ExternalConnection | null>;
  /** SDK tool metadata, not a model-supplied schema or guessed toolkit prefix. */
  schema(slug: string): Promise<ExternalToolSchema>;
}

const vaultHandleSchema = {
  type: "object",
  properties: { $vault: { type: "string", minLength: 1, maxLength: 128 } },
  required: ["$vault"],
  additionalProperties: false,
} as const;

/**
 * A Vault handle is a placeholder, not an alternate provider value. We allow it while reviewing a
 * proposal, then validate the resolved plaintext against the original provider schema immediately
 * before execution. Object shape is deliberately exact so `$vault` cannot smuggle sibling input.
 */
export function hasVaultHandles(value: unknown, depth = 0): boolean {
  if (depth > 30) throw new IntegrationError("integration.invalid_arguments");
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, "$vault")) {
    const object = value as Record<string, unknown>;
    if (
      Object.keys(object).length !== 1 ||
      typeof object.$vault !== "string" ||
      object.$vault.length < 1 ||
      object.$vault.length > 128
    )
      throw new IntegrationError("integration.invalid_arguments");
    return true;
  }
  return Object.values(value).some((child) => hasVaultHandles(child, depth + 1));
}

export function maskVaultHandles(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new IntegrationError("integration.invalid_arguments");
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "$vault")) {
    hasVaultHandles(value, depth);
    return "[Vault value]";
  }
  if (Array.isArray(value)) return value.map((child) => maskVaultHandles(child, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, maskVaultHandles(child, depth + 1)]),
  );
}

function schemaAllowingVaultHandles(value: unknown, allowHandle: boolean, depth = 0): unknown {
  if (depth > 30 || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...schema };
  for (const key of ["properties", "patternProperties", "$defs", "definitions"] as const) {
    const entries = schema[key];
    if (entries && typeof entries === "object" && !Array.isArray(entries))
      copy[key] = Object.fromEntries(
        Object.entries(entries).map(([name, child]) => [
          name,
          schemaAllowingVaultHandles(child, key !== "$defs" && key !== "definitions", depth + 1),
        ]),
      );
  }
  for (const key of ["items", "contains", "additionalProperties"] as const) {
    if (schema[key] && typeof schema[key] === "object")
      copy[key] = schemaAllowingVaultHandles(schema[key], true, depth + 1);
  }
  for (const key of ["prefixItems", "allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key]))
      copy[key] = schema[key].map((child) => schemaAllowingVaultHandles(child, true, depth + 1));
  }
  for (const key of ["not", "if", "then", "else"] as const) {
    if (schema[key] && typeof schema[key] === "object")
      copy[key] = schemaAllowingVaultHandles(schema[key], false, depth + 1);
  }
  return allowHandle ? { anyOf: [copy, vaultHandleSchema] } : copy;
}

export function validateExternalArguments(
  schema: Record<string, unknown>,
  value: unknown,
  options: { allowVaultHandles: boolean },
): Record<string, unknown> {
  const args = cleanToolArguments(value);
  try {
    if (options.allowVaultHandles) hasVaultHandles(args);
    const reviewedSchema = options.allowVaultHandles
      ? schemaAllowingVaultHandles(schema, false)
      : schema;
    if (
      !z.fromJSONSchema(reviewedSchema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(args)
        .success
    )
      throw new Error("invalid");
  } catch {
    throw new IntegrationError("integration.invalid_arguments");
  }
  return args;
}

const reserved = new Set([
  "session_id",
  "session",
  "user_id",
  "account",
  "connected_account_id",
  "__proto__",
  "constructor",
  "prototype",
]);
const actionSlug = /^[A-Z][A-Z0-9_]{1,127}$/;

function assertAction(slug: string): void {
  if (!actionSlug.test(slug) || slug.startsWith("COMPOSIO_")) {
    throw new IntegrationError("integration.tool_unavailable");
  }
}

/** Clone untrusted input, stripping identity selectors at every depth without modifying the caller. */
export function cleanToolArguments(value: unknown): Record<string, unknown> {
  const clone = (item: unknown, depth: number): unknown => {
    if (depth > 16) throw new IntegrationError("integration.invalid_arguments");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => clone(child, depth + 1));
    if (typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new IntegrationError("integration.invalid_arguments");
    }
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !reserved.has(key))
        .map(([key, child]) => [key, clone(child, depth + 1)]),
    );
  };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new IntegrationError("integration.invalid_arguments");
  const result = clone(value, 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(result)) > 64_000)
    throw new IntegrationError("integration.invalid_arguments");
  return result;
}

function boundedResult(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 128_000)
    throw new IntegrationError("integration.invalid_response");
  return JSON.parse(encoded) as Record<string, unknown>;
}

/**
 * Owner-bound discovery/execution. This is not an approval engine: the caller must record its
 * approval/exemption and invocation before executeResolved. That method rechecks exact authority.
 */
export class ConnectionTools {
  private readonly discovered = new Set<string>();
  private readonly resolved = new WeakMap<ResolvedExternalAction, ResolvedExternalAction>();
  constructor(
    private readonly client: ComposioExecutionClient,
    private readonly session: ComposioSession,
    private readonly authority: ConnectionToolAuthority,
  ) {}

  async searchTools(query: string): Promise<Record<string, unknown>> {
    if (!query.trim() || query.length > 2000)
      throw new IntegrationError("integration.invalid_arguments");
    const result = await this.meta("COMPOSIO_SEARCH_TOOLS", {
      queries: [{ use_case: query }],
      session: { id: this.session.sessionId },
    });
    // Only explicit provider action references enter the allowlist. Arbitrary prose never does.
    const results = Array.isArray(result.results) ? result.results : [];
    for (const entry of results) {
      if (!entry || typeof entry !== "object") continue;
      for (const key of ["primary_tool_slugs", "related_tool_slugs"] as const) {
        const slugs: unknown = (entry as Record<string, unknown>)[key];
        if (!Array.isArray(slugs)) continue;
        for (const slug of slugs) {
          if (
            typeof slug === "string" &&
            actionSlug.test(slug) &&
            !slug.startsWith("COMPOSIO_") &&
            this.discovered.size < 200
          )
            this.discovered.add(slug);
        }
      }
    }
    return result;
  }

  async getToolSchemas(slugs: readonly string[]): Promise<readonly ExternalToolSchema[]> {
    if (slugs.length < 1 || slugs.length > 20)
      throw new IntegrationError("integration.invalid_arguments");
    for (const slug of slugs) this.requireDiscovered(slug);
    await this.meta("COMPOSIO_GET_TOOL_SCHEMAS", {
      tool_slugs: [...slugs],
      session_id: this.session.sessionId,
    });
    const output: ExternalToolSchema[] = [];
    for (const slug of slugs) {
      const tool = await this.authority.schema(slug);
      if (tool.slug !== slug) throw new IntegrationError("integration.invalid_response");
      output.push(tool);
    }
    // Provider metadata may be slow. Recheck once after the bounded batch, not once per slug.
    await this.check();
    return output;
  }

  async resolveActions(
    inputs: readonly {
      readonly slug: string;
      readonly arguments: unknown;
      readonly connection?: string;
    }[],
  ): Promise<readonly ResolvedExternalAction[]> {
    if (inputs.length < 1 || inputs.length > 10)
      throw new IntegrationError("integration.invalid_arguments");
    for (const input of inputs) this.requireDiscovered(input.slug);
    const snapshot = this.authority.snapshot
      ? await this.authority.snapshot()
      : {
          authorized: await this.authority.check(),
          connections: await this.authority.connections(),
        };
    if (!snapshot.authorized) throw new IntegrationError("integration.unauthorized");
    const actions: ResolvedExternalAction[] = [];
    for (const input of inputs)
      actions.push(await this.prepareFrom(input, true, snapshot.connections));
    return actions;
  }

  async resolveAction(input: {
    slug: string;
    arguments: unknown;
    connection?: string;
  }): Promise<ResolvedExternalAction> {
    this.requireDiscovered(input.slug);
    return this.prepare(input, true);
  }

  /** Only the continuation/edited-approval adapter calls this with arguments loaded from D1. */
  async prepareStoredAction(input: {
    slug: string;
    arguments: unknown;
    connection: string;
  }): Promise<ResolvedExternalAction> {
    assertAction(input.slug);
    return this.prepare(input, true);
  }

  /**
   * Replace reviewed Vault handles with their just-resolved values without another upstream
   * metadata or D1 call. The original live schema and exact connection are retained; the
   * plaintext then exists only across local validation and executeResolved's final native
   * authority check/provider invocation.
   */
  async prepareResolvedAction(
    reviewed: ResolvedExternalAction,
    argumentsValue: unknown,
  ): Promise<ResolvedExternalAction> {
    const stored = this.resolved.get(reviewed);
    if (!stored) throw new IntegrationError("integration.tool_unavailable");
    const action = Object.freeze({
      tool: stored.tool,
      connection: Object.freeze({ ...stored.connection }),
      arguments: structuredClone(
        validateExternalArguments(stored.tool.schema, argumentsValue, {
          allowVaultHandles: false,
        }),
      ),
    });
    this.resolved.set(action, structuredClone(action));
    return action;
  }

  private async prepare(
    input: {
      slug: string;
      arguments: unknown;
      connection?: string;
    },
    allowVaultHandles: boolean,
  ): Promise<ResolvedExternalAction> {
    await this.check();
    return this.prepareFrom(input, allowVaultHandles, await this.authority.connections());
  }

  private async prepareFrom(
    input: {
      slug: string;
      arguments: unknown;
      connection?: string;
    },
    allowVaultHandles: boolean,
    available: readonly ExternalConnection[],
  ): Promise<ResolvedExternalAction> {
    const tool = await this.authority.schema(input.slug);
    if (tool.slug !== input.slug) throw new IntegrationError("integration.invalid_response");
    const args = validateExternalArguments(tool.schema, input.arguments, { allowVaultHandles });
    const choices = available.filter(
      (connection) =>
        connection.ownerId === this.authority.ownerId && connection.toolkit === tool.toolkit,
    );
    const connection = input.connection
      ? choices.find((entry) => entry.id === input.connection)
      : choices.length === 1
        ? choices[0]
        : undefined;
    if (!connection)
      throw new IntegrationError(
        choices.length > 1 && !input.connection
          ? "integration.account_selection_required"
          : "integration.connection_required",
        choices.length > 1 && !input.connection
          ? { choices: choices.map(({ id, toolkit }) => ({ id, toolkit })) }
          : {},
      );
    const action = Object.freeze({
      tool,
      connection: Object.freeze({ ...connection }),
      arguments: structuredClone(args),
    });
    this.resolved.set(action, structuredClone(action));
    return action;
  }

  async executeResolved(
    action: ResolvedExternalAction,
    options: { sideEffect: boolean },
  ): Promise<Record<string, unknown>> {
    const stored = this.resolved.get(action);
    if (!stored) throw new IntegrationError("integration.tool_unavailable");
    action = stored;
    const current = this.authority.authorize
      ? await this.authority.authorize(action.connection)
      : await (async () => {
          await this.check();
          return (await this.authority.connections()).find(
            (entry) => entry.id === action.connection.id,
          );
        })();
    if (
      !current ||
      current.ownerId !== this.authority.ownerId ||
      current.generation !== action.connection.generation ||
      current.connectedAccountId !== action.connection.connectedAccountId ||
      current.toolkit !== action.tool.toolkit
    )
      throw new IntegrationError("integration.connection_required");
    // Direct session execution carries a documented explicit account selector. A multi-execute
    // meta call cannot guarantee its nested actions honor the top-level selector (§14.1).
    try {
      const result = options.sideEffect
        ? await this.client
            .getClient()
            .withOptions({ maxRetries: 0 })
            .toolRouter.session.execute(this.session.sessionId, {
              tool_slug: action.tool.slug,
              arguments: action.arguments,
              account: current.connectedAccountId,
            })
        : await this.session.execute(action.tool.slug, action.arguments, {
            account: current.connectedAccountId,
          });
      if (result.error)
        throw new IntegrationError(
          options.sideEffect ? "integration.uncertain" : "integration.provider_failed",
        );
      return boundedResult(result.data);
    } catch (error) {
      if (
        options.sideEffect &&
        error instanceof IntegrationError &&
        error.code === "integration.invalid_response"
      )
        throw new IntegrationError("integration.uncertain");
      throw normalizeIntegrationError(error, options.sideEffect);
    }
  }

  async manageConnections(toolkit?: string) {
    await this.check();
    const connections = (await this.authority.connections()).filter(
      (entry) =>
        entry.ownerId === this.authority.ownerId && (!toolkit || entry.toolkit === toolkit),
    );
    return {
      status: connections.length ? ("connected" as const) : ("connect_required" as const),
      connections: connections.map(({ id, toolkit: slug }) => ({ id, toolkit: slug })),
      settingsPath: "/settings/connections",
    };
  }

  private requireDiscovered(slug: string): void {
    assertAction(slug);
    if (!this.discovered.has(slug)) throw new IntegrationError("integration.tool_unavailable");
  }

  private async check(): Promise<void> {
    if (!(await this.authority.check())) throw new IntegrationError("integration.unauthorized");
  }

  private async meta(
    slug: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.check();
    try {
      const result = await this.session.execute(slug, args);
      if (result.error) throw new IntegrationError("integration.provider_failed");
      // Some provider versions nest the documented meta envelope under session data.
      const nested = result.data;
      if (nested.successful === false || nested.error)
        throw new IntegrationError("integration.provider_failed");
      return boundedResult(
        nested.successful === true &&
          nested.data &&
          typeof nested.data === "object" &&
          !Array.isArray(nested.data)
          ? (nested.data as Record<string, unknown>)
          : nested,
      );
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }
}
