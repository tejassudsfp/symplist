/**
 * Pure policy for the Symplist MCP relay: who may call the loopback listener, and what the cloud's
 * answer means. No `electron`, no `node:http`, no I/O — the decisions that are worth being certain
 * about live here so they can be tested as functions, the way `navigation.ts` sits beside `window.ts`.
 *
 * Three cloud failures are kept distinct, deliberately, the way the removed AI outcomes were:
 *
 *   - `invalid_token` — the grant was revoked or has expired. The user has to reconnect; the model
 *     cannot do anything about it, and telling it so would only waste a turn.
 *   - `forbidden` — this call is outside the grant's scopes or its task narrowing. That *is* the
 *     model's problem, so it travels to the model unchanged and it can adapt.
 *   - `throttled` — the D1 lane shed the request, or the grant's document retrieval budget is spent.
 *     Transient, and the user is told so in a sentence rather than watching the agent stall silently.
 *
 * Collapsing these into one "MCP error" is the failure mode this module exists to prevent: a revoked
 * grant would then read to the model as a tool that is merely broken, and it would retry forever.
 */

/** What the relay does with an inbound request from the harness. */
export type RelayAdmission =
  | { readonly kind: "forward" }
  /** `reason` is a stable code for the log; it is never sent to the caller, which gets only a status. */
  | { readonly kind: "refuse"; readonly status: number; readonly reason: string };

/** The header carrying the per-launch capability token. Never the bearer key — see `relay.ts`. */
export const relayCapabilityHeader = "x-symplist-relay";

/** The one path the relay serves. Anything else is not an MCP request and is refused. */
export const relayPath = "/mcp";

export interface InboundRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  /** Lowercased header names, as `node:http` delivers them. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

function single(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value[0];
}

/**
 * Admission for the loopback listener. It is deliberately stricter than "is the token right":
 *
 *   - A request carrying `Origin` or `Sec-Fetch-Site` came from a page, and no page may reach this
 *     listener — not the renderer, and not a remote document that found the port by DNS rebinding.
 *     The renderer has no business here: the UI talks to `/v1/` through the main process, and MCP is
 *     the agent's path alone.
 *   - The capability token is compared at full length rather than by prefix, and a missing token is
 *     refused before anything else is read.
 *
 * `POST` only, because a Streamable HTTP client's `GET` is an SSE subscription and its `DELETE` ends a
 * session — neither of which the stateless cloud endpoint implements. It answers both with 405 and the
 * harness's client tolerates that (proven against the real endpoint), so the relay answers 405 too
 * rather than forwarding a request that can only be refused one hop later.
 */
export function relayAdmission(request: InboundRequest, capability: string): RelayAdmission {
  const token = single(request.headers[relayCapabilityHeader]);
  if (token === undefined) return { kind: "refuse", status: 401, reason: "capability_missing" };
  if (token.length !== capability.length || token !== capability) {
    return { kind: "refuse", status: 401, reason: "capability_mismatch" };
  }
  if (single(request.headers.origin) !== undefined) {
    return { kind: "refuse", status: 403, reason: "origin_present" };
  }
  if (single(request.headers["sec-fetch-site"]) !== undefined) {
    return { kind: "refuse", status: 403, reason: "fetch_metadata_present" };
  }
  const path = (request.url ?? "").split("?")[0];
  if (path !== relayPath) return { kind: "refuse", status: 404, reason: "path_unknown" };
  if (request.method !== "POST")
    return { kind: "refuse", status: 405, reason: "method_unsupported" };
  return { kind: "forward" };
}

/** A cloud failure the relay recognises, or `null` when nothing went wrong at this layer. */
export type RelayFailure = "invalid_token" | "forbidden" | "throttled" | null;

/**
 * The failure an HTTP status from `/mcp` represents. Only the transport-level answers are read here; a
 * tool that failed comes back 200 and is classified by `toolResultFailure`.
 */
export function statusFailure(status: number): RelayFailure {
  if (status === 401) return "invalid_token";
  if (status === 403) return "forbidden";
  if (status === 429 || status === 503) return "throttled";
  return null;
}

/**
 * The failure inside a tool result. `safe()` in `apps/api/src/modules/mcp/mcp-tools.ts` answers HTTP
 * 200 with `isError: true` and a single text block holding `{"error":{"code":"…"}}`, so the code is one
 * shallow parse away — and only one. This is read-only and best-effort by contract: an unparseable or
 * unfamiliar result classifies as `null` and the body still reaches the model byte for byte. The relay
 * never rewrites a tool result, because the model's view of what its own tool said must be the truth.
 */
export function toolResultFailure(body: string): RelayFailure {
  const code = mcpErrorCode(body);
  if (code === null) return null;
  if (code === "mcp.invalid_token") return "invalid_token";
  if (code === "mcp.forbidden") return "forbidden";
  if (code === "rate.limited" || code === "document.budget_exhausted") return "throttled";
  return null;
}

/**
 * The error code inside a JSON-RPC response body, whether the body is a bare JSON object or an SSE
 * `data:` framing (`responseMode` decides which, so both have to be handled). Returns `null` for
 * anything that is not one recognisable `{"error":{"code":"…"}}`, which is the common case.
 */
function mcpErrorCode(body: string): string | null {
  for (const candidate of jsonCandidates(body)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const code = errorCodeOf(parsed);
    if (code !== null) return code;
  }
  return null;
}

/** The JSON documents an answer may contain: the whole body, plus each SSE `data:` line. */
function jsonCandidates(body: string): string[] {
  const candidates = [body.trim()];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) candidates.push(trimmed.slice(5).trim());
  }
  return candidates.filter((candidate) => candidate.startsWith("{") || candidate.startsWith("["));
}

/** Walks a parsed JSON-RPC answer far enough to find a tool result's error code, and no further. */
function errorCodeOf(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = errorCodeOf(item);
      if (code !== null) return code;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const result = record.result;
  if (typeof result === "object" && result !== null) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const text = (block as { text?: unknown }).text;
        if (typeof text !== "string") continue;
        const code = directErrorCode(text);
        if (code !== null) return code;
      }
    }
  }
  return directErrorCode(record);
}

/** `{"error":{"code":"…"}}`, from a record or from a string holding one. */
function directErrorCode(value: string | Record<string, unknown>): string | null {
  let record: Record<string, unknown>;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    record = value;
  }
  const error = record.error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * What a `throttled` failure says in the app, for the human. It is surfaced beside the conversation and
 * never injected into the response: the relay forwards every cloud answer byte for byte, so the model
 * reads the cloud's own `rate.limited` or `document.budget_exhausted` code and can adapt to it without
 * the relay putting words in the tool's mouth.
 */
export const throttledNotice =
  "Symplist is pacing requests, or this connection's document read quota is spent. It will recover on its own in a few minutes.";

/** What an `invalid_token` failure says in the app. The affordance beside it re-mints the grant. */
export const revokedNotice =
  "Symplist access was revoked — reconnect to let the assistant work again.";
