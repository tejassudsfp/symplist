/**
 * `McpAccess`: the main-process service that hands the DeepSeek Harness Symplist's tools and gives the
 * user an honest account of whether they work.
 *
 * It owns the loopback relay (`relay.ts`), the ACP entry that mounts it (`acp.ts`), and the state machine
 * that turns the cloud's three failure modes into something a person can act on (`policy.ts`). The grant
 * itself belongs to the cloud-session lane; this service reaches it through the narrow
 * `DeviceGrantSource` seam and never touches the keychain directly.
 *
 * What the renderer learns is a state, a grant id and a sentence. Never the key, which does not leave this
 * process. Never the relay's port, which the renderer has no reason to know and no way to use — the relay
 * refuses any request carrying `Origin` or `Sec-Fetch-Site`, so a page inside the app cannot reach it.
 *
 * **The UI does not use MCP**, and that is a decision rather than an omission. The task list, documents,
 * Vault, connections, calendar and search in the desktop window go through `/v1/` with the session, exactly
 * as they do in the browser. MCP is the agent's path alone, which keeps the grant's 256 KB / 10 minute
 * document retrieval budget for the agent and keeps the workspace screens off the 2 req/s D1 lane.
 */
import type { MainLog } from "../log.ts";
import { type AcpHttpMcpServer, symplistMcpServer } from "./acp.ts";
import type { DeviceGrantSource } from "./grant-source.ts";
import { revokedNotice, throttledNotice } from "./policy.ts";
import { grantVerdict, parseGrantRows } from "./reconcile.ts";
import { type McpRelay, startMcpRelay } from "./relay.ts";

/** One `/v1/` call as the signed-in account: the cloud lane's `CloudHttp`, narrowed to what this needs. */
export type GrantListFetch = (request: {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string | null;
}) => Promise<{ readonly status: number; readonly body: string }>;

/**
 * What the renderer is told. `connected` means the agent's tools work; `reconnect` means the grant was
 * revoked or has expired and one click repairs it; `signed_out` means there is no account to grant
 * anything. Throttling is not a state — it is a notice over a connection that still works.
 */
export interface McpAccessState {
  readonly state: "connected" | "reconnect" | "signed_out";
  /** The same id Settings → Agent connections shows, so the user can match this row to that one. */
  readonly grantId: string | null;
  readonly expiresAt: number | null;
  readonly notice: string | null;
}

export interface McpAccessOptions {
  readonly grants: DeviceGrantSource;
  readonly http: GrantListFetch;
  /** `${API_ORIGIN}/mcp`: the one upstream the relay ever talks to. */
  readonly target: string;
  readonly log: MainLog;
  readonly onChange?: (state: McpAccessState) => void;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

/** How long a transient throttling notice stays up before the app stops mentioning it. */
const THROTTLE_NOTICE_MS = 60_000;

export class McpAccess {
  private readonly now: () => number;
  private relay: McpRelay | null = null;
  /** Set by a 401 or by a focus poll that found the grant gone. Cleared by a successful re-mint. */
  private invalidated = false;
  private throttledUntil = 0;

  constructor(private readonly options: McpAccessOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Starts the relay. Called once, from `start()` in `index.ts`, after `app.whenReady()`. */
  async start(): Promise<void> {
    this.relay = await startMcpRelay({
      target: this.options.target,
      bearer: () => this.bearer(),
      onFailure: (failure) => this.record(failure),
      log: this.options.log,
      fetchImpl: this.options.fetchImpl,
    });
  }

  async stop(): Promise<void> {
    const relay = this.relay;
    this.relay = null;
    if (relay) await relay.stop();
  }

  state(): McpAccessState {
    const grant = this.options.grants.current();
    /*
     * No grant means `signed_out` even after an invalidation, and that ordering is deliberate: there is
     * nothing to reconnect when there is nothing to reconnect to, and the sign-in the user then does mints
     * a grant on its own. `reconnect` is reserved for the case a person can actually fix from here — a
     * grant this device still holds that the cloud no longer honours.
     */
    const state: McpAccessState["state"] =
      grant === null ? "signed_out" : this.invalidated ? "reconnect" : "connected";
    return {
      state,
      grantId: grant?.grantId ?? null,
      expiresAt: grant?.expiresAt ?? null,
      notice:
        state === "reconnect"
          ? revokedNotice
          : this.throttledUntil > this.now()
            ? throttledNotice
            : null,
    };
  }

  /**
   * The `mcpServers` entry for `session/new` **and** for `session/resume`. Resume re-mounts MCP configs
   * from scratch rather than restoring the previous ones, so a resume built from a stale port would produce
   * a session whose every tool fails.
   *
   * It throws when the relay is not running, because `dsh-acp` hardcodes `failOnStartupError: true`: a
   * session mounted against a dead MCP server refuses to start outright. Refusing here, where the app can
   * say which state it is in, beats letting ACP refuse with a config error.
   */
  mcpServer(): AcpHttpMcpServer {
    if (!this.relay) throw new Error("symplist mcp: the relay is not running");
    return symplistMcpServer(this.relay);
  }

  /**
   * Reconciles against `GET /v1/mcp/grants`. Called on window focus. A cloud that cannot be reached is not
   * a revocation: the stored key may well still work, and only a real 401 from `/mcp` moves the app into
   * `reconnect` on its own.
   */
  async reconcile(): Promise<McpAccessState> {
    const grant = this.options.grants.current();
    if (grant === null) return this.state();
    let response: { status: number; body: string };
    try {
      response = await this.options.http({
        method: "GET",
        path: "/v1/mcp/grants",
        headers: [["Accept", "application/json"]],
        body: null,
      });
    } catch {
      this.options.log.warn("mcp.reconcile_unreachable");
      return this.state();
    }
    if (response.status !== 200) return this.state();
    const verdict = grantVerdict(grant.grantId, parseGrantRows(response.body), this.now());
    if (verdict === "usable") {
      this.invalidated = false;
    } else {
      this.options.log.warn("mcp.grant_unusable", { verdict });
      this.invalidated = true;
    }
    return this.publish();
  }

  /**
   * The one-click repair behind the reconnect banner: retire the dead grant and mint a replacement. The
   * app never does this on its own in response to a 401 — minting automatically would silently hand back
   * access the user had just taken away on purpose.
   */
  async reconnect(): Promise<McpAccessState> {
    await this.options.grants.replace();
    // A replace that produced nothing leaves no grant, and `state()` calls that `signed_out`: the account
    // is not in a position to mint, so telling the user to reconnect again would be a loop with no exit.
    this.invalidated = false;
    return this.publish();
  }

  /** The bearer for the next forwarded request. Main process only: never a log, never an ACP payload. */
  private bearer(): string | null {
    if (this.invalidated) return null;
    const grant = this.options.grants.current();
    if (grant === null) return null;
    return grant.expiresAt > this.now() ? grant.key : null;
  }

  /**
   * Records a relay failure.
   *
   * `forbidden` is deliberately not a state. A call outside the grant's scopes or its task narrowing is the
   * model's problem, it reached the model unchanged, and turning it into a banner would tell the user
   * something is broken when the agent was merely told no.
   */
  private record(failure: "invalid_token" | "forbidden" | "throttled"): void {
    if (failure === "invalid_token") {
      this.options.log.warn("mcp.grant_invalid");
      this.invalidated = true;
      this.publish();
      return;
    }
    if (failure === "throttled") {
      this.throttledUntil = this.now() + THROTTLE_NOTICE_MS;
      this.publish();
    }
  }

  private publish(): McpAccessState {
    const state = this.state();
    this.options.onChange?.(state);
    return state;
  }
}

export {
  type AcpHttpMcpServer,
  symplistMcpServer,
  symplistServerName,
  symplistToolNames,
  toolNameIsClean,
} from "./acp.ts";
export { type DeviceGrant, type DeviceGrantSource, deviceGrantSource } from "./grant-source.ts";
export { relayCapabilityHeader, revokedNotice, throttledNotice } from "./policy.ts";
