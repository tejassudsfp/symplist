/**
 * The MCP credential the assistant authenticates to the cloud with.
 *
 * The whole point of phase 2 is that the assistant runs on this machine, and it still has to read and
 * write the workspace that lives in the cloud. It does that over Symplist's own incoming MCP server, so
 * it needs a key — and `POST /v1/mcp/grants` hands the key back exactly once (`@OneTimeSecret(["key"])`),
 * which is why it is minted here at sign-in and kept in the keychain rather than fetched when needed.
 *
 * Three properties of MCP grants shape everything below:
 *
 *   1. **A grant outlives the session that created it.** The mcp session-revoke contributor only expires
 *      pending `oauth_requests`, so signing out does not revoke the key. The revoke therefore has to be
 *      sent *before* the logout, because the session is what authorizes it — `CloudSession.beforeRequest`
 *      is where that ordering is enforced.
 *   2. **Minting needs a fresh, admitted session** (`@Access("admitted", { fresh: true })`). An account
 *      still at the beta gate cannot have one, so `established` is only called once the destination says
 *      the account is past it.
 *   3. **The key is a live credential sitting on disk between sign-ins.** It is stored under the same
 *      `safeStorage` mechanism as the session and removed on sign-out whatever the server said. If the
 *      revoke could not be sent — offline sign-out — the key survives at the api, and the app must say so
 *      rather than claim a clean sign-out; `lastRevoke()` is what a screen reads to do that.
 *
 * Scopes are `tasks:read` and `tasks:write` with no task narrowing: the assistant works across the whole
 * workspace, which is what the 13 incoming tools are for. Those two are the entire scope set
 * (`packages/contracts/src/connections/mcp.ts`).
 */
import { randomUUID } from "node:crypto";
import type { MainLog } from "../log.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import type { CloudHttp, CloudResponse } from "./http.ts";
import type { IdentitySnapshot, SessionCredentialHooks } from "./session-state.ts";

/** The secret store entry holding the grant. */
export const MCP_GRANT_SECRET_NAME = "mcp-grant";
export const MCP_GRANT_BLOB_VERSION = 1;

/**
 * How close to expiry a grant is re-minted. Grants last 30 days (`MCP_GRANT_LIFETIME_MS`), so three days
 * of headroom means an app opened even once a week never hands dsh a key that dies mid-turn.
 */
export const MCP_GRANT_RENEW_WITHIN_MS = 3 * 86_400_000;

/** The name the grant is listed under in Settings → Connections, so a person can recognise it there. */
export const MCP_GRANT_NAME = "Symplist for macOS";

export interface StoredMcpGrant {
  readonly version: number;
  readonly apiOrigin: string;
  readonly grantId: string;
  readonly key: string;
  readonly expiresAt: number;
}

/** What happened the last time a grant was released, for a sign-out that has to be honest about it. */
export type RevokeOutcome = "revoked" | "not_held" | "failed";

export interface McpGrantOptions {
  readonly apiOrigin: string;
  readonly http: CloudHttp;
  readonly store: SecretStore;
  readonly log: MainLog;
  readonly now?: () => number;
  readonly newIdempotencyKey?: () => string;
}

/** Parses the stored blob; null for anything that is not a usable grant for this cloud. */
export function parseStoredGrant(
  raw: string,
  apiOrigin: string,
  now: number,
): StoredMcpGrant | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = value as Record<string, unknown> | null;
  if (record === null || typeof record !== "object") return null;
  if (record.version !== MCP_GRANT_BLOB_VERSION) return null;
  if (record.apiOrigin !== apiOrigin) return null;
  if (typeof record.grantId !== "string" || record.grantId.length === 0) return null;
  if (typeof record.key !== "string" || record.key.length === 0) return null;
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
  if (record.expiresAt <= now) return null;
  return {
    version: MCP_GRANT_BLOB_VERSION,
    apiOrigin,
    grantId: record.grantId,
    key: record.key,
    expiresAt: record.expiresAt,
  };
}

/** The `{id, key?, expiresAt}` of a mint, or null when the api answered something else. */
export function parseMintResult(
  body: string,
): { readonly id: string; readonly key: string | null; readonly expiresAt: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const record = value as Record<string, unknown> | null;
  if (record === null || typeof record.id !== "string") return null;
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
  const key = typeof record.key === "string" && record.key.length > 0 ? record.key : null;
  return { id: record.id, key, expiresAt: record.expiresAt };
}

/**
 * Holds the device's MCP grant. Implements `SessionCredentialHooks`, so `CloudSession` provisions and
 * releases it at the right points in the session's life without knowing what it is.
 */
export class McpGrantStore implements SessionCredentialHooks {
  private readonly options: McpGrantOptions;
  private readonly now: () => number;
  private readonly newIdempotencyKey: () => string;
  private lastRevokeOutcome: RevokeOutcome = "not_held";
  private csrfToken: string | null = null;

  constructor(options: McpGrantOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    // `Idempotency-Key` takes 16 to 128 URL-safe characters; a UUID is well inside that.
    this.newIdempotencyKey = options.newIdempotencyKey ?? randomUUID;
  }

  /**
   * The key for dsh, or null when the device has none. Read by the assistant lane when it builds the MCP
   * server configuration; it never travels to the renderer.
   */
  current(): StoredMcpGrant | null {
    const raw = this.options.store.read(MCP_GRANT_SECRET_NAME);
    if (raw === null) return null;
    const grant = parseStoredGrant(raw, this.options.apiOrigin, this.now());
    if (!grant) {
      this.options.store.clear(MCP_GRANT_SECRET_NAME);
      return null;
    }
    return grant;
  }

  /** Whether the last release actually reached the api. A sign-out screen reads this to be honest. */
  lastRevoke(): RevokeOutcome {
    return this.lastRevokeOutcome;
  }

  /** `SessionCredentialHooks`: mint a grant if the device has none, or one that is about to expire. */
  async established(identity: IdentitySnapshot): Promise<void> {
    void identity;
    const existing = this.current();
    if (existing && existing.expiresAt - this.now() > MCP_GRANT_RENEW_WITHIN_MS) return;
    // A grant close to expiry is replaced rather than extended: the api has no renew, and two live grants
    // for one device would be worse than a brief overlap.
    if (existing) await this.revoke(existing);
    await this.mint();
  }

  /** `SessionCredentialHooks`: revoke at the api while the session still authorizes it. */
  async beforeSignOut(): Promise<void> {
    const existing = this.current();
    if (!existing) {
      this.lastRevokeOutcome = "not_held";
      return;
    }
    await this.revoke(existing);
  }

  /** `SessionCredentialHooks`: the session is gone, so the local copy goes whatever the api said. */
  async cleared(): Promise<void> {
    this.options.store.clear(MCP_GRANT_SECRET_NAME);
    this.csrfToken = null;
  }

  private async mint(): Promise<void> {
    const response = await this.send("POST", "/v1/mcp/grants", {
      name: MCP_GRANT_NAME,
      scopes: ["tasks:read", "tasks:write"],
      taskIds: null,
    });
    if (response === null) return;
    if (response.status !== 200 && response.status !== 201) {
      this.options.log.warn("mcp_grant.mint_refused", { status: response.status });
      return;
    }
    const result = parseMintResult(response.body);
    if (!result) {
      this.options.log.warn("mcp_grant.mint_unparsable", { status: response.status });
      return;
    }
    if (result.key === null) {
      // `secretUnavailable`, or the `secret.already_issued` notice on an exact retry. Either way this
      // response carries no key, and the grant it names is one we cannot use.
      this.options.log.warn("mcp_grant.no_secret");
      await this.revokeById(result.id);
      return;
    }
    const blob: StoredMcpGrant = {
      version: MCP_GRANT_BLOB_VERSION,
      apiOrigin: this.options.apiOrigin,
      grantId: result.id,
      key: result.key,
      expiresAt: result.expiresAt,
    };
    if (!this.options.store.write(MCP_GRANT_SECRET_NAME, JSON.stringify(blob))) {
      // Nowhere safe to keep it, so it is revoked rather than left live at the api with no local record
      // of its id — which would make it unrevokable from this machine.
      this.options.log.warn("mcp_grant.not_persisted");
      await this.revokeById(result.id);
      return;
    }
    this.lastRevokeOutcome = "not_held";
    this.options.log.info("mcp_grant.minted");
  }

  private async revoke(grant: StoredMcpGrant): Promise<void> {
    const revoked = await this.revokeById(grant.grantId);
    this.lastRevokeOutcome = revoked ? "revoked" : "failed";
    // The local copy goes either way: a key we cannot revoke is still a key we must not keep.
    this.options.store.clear(MCP_GRANT_SECRET_NAME);
  }

  private async revokeById(grantId: string): Promise<boolean> {
    const response = await this.send(
      "DELETE",
      `/v1/mcp/grants/${encodeURIComponent(grantId)}`,
      null,
    );
    if (response === null) return false;
    // A grant already revoked, or gone with the account, is as released as one revoked just now.
    const released = response.status === 200 || response.status === 204 || response.status === 404;
    if (!released) this.options.log.warn("mcp_grant.revoke_refused", { status: response.status });
    return released;
  }

  /**
   * One authenticated call on the `app` route class. Unsafe methods need the session-bound CSRF token, so
   * it is fetched once and re-fetched when the api rejects it, mirroring what `ApiClient` does in the
   * renderer.
   */
  private async send(
    method: "POST" | "DELETE",
    path: string,
    body: unknown,
  ): Promise<CloudResponse | null> {
    for (const attempt of [0, 1]) {
      const token = await this.token();
      if (token === null) return null;
      let response: CloudResponse;
      try {
        response = await this.options.http({
          method,
          path,
          headers: [
            ["Accept", "application/json"],
            ["X-Symplist-CSRF", token],
            ["Idempotency-Key", this.newIdempotencyKey()],
            ...(body === null
              ? []
              : ([["Content-Type", "application/json"]] as [string, string][])),
          ],
          body: body === null ? null : JSON.stringify(body),
        });
      } catch {
        this.options.log.warn("mcp_grant.unreachable");
        return null;
      }
      if (response.status === 403 && attempt === 0) {
        // A stale token: the api rotated the session, or this one was minted for a session that ended.
        this.csrfToken = null;
        continue;
      }
      return response;
    }
    return null;
  }

  private async token(): Promise<string | null> {
    if (this.csrfToken !== null) return this.csrfToken;
    let response: CloudResponse;
    try {
      response = await this.options.http({
        method: "GET",
        path: "/v1/auth/csrf",
        headers: [["Accept", "application/json"]],
        body: null,
      });
    } catch {
      this.options.log.warn("mcp_grant.csrf_unreachable");
      return null;
    }
    if (response.status !== 200) return null;
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      return null;
    }
    const token = (value as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || token.length === 0) return null;
    this.csrfToken = token;
    return token;
  }
}
