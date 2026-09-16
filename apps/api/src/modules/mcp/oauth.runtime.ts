import { OAuthError } from "@modelcontextprotocol/server";
import { oauthRegistrationSchema } from "@symplist/contracts";
import type { McpIdentity } from "@symplist/core/mcp";
import {
  type ConsentClient,
  McpError,
  type McpGrants,
  OAuthRequests,
  OAuthTokens,
  oauthScopes,
} from "@symplist/core/mcp";
import { int, sql, uuidv7 } from "@symplist/db";
import { ClientMetadataLoader, redirectUriMatches, validRedirectUri } from "./client-metadata.ts";
import { McpTokens } from "./mcp-tokens.ts";

export const OAUTH_RUNTIME = "symplist:OAUTH_RUNTIME";
export class OAuthBoundaryError extends Error {
  constructor(
    readonly code:
      | "invalid_client"
      | "invalid_redirect_uri"
      | "invalid_client_metadata"
      | "invalid_request"
      | "invalid_target"
      | "invalid_scope"
      | "invalid_grant"
      | "unsupported_grant_type",
  ) {
    super(code);
  }
}
export class OAuthRuntime {
  readonly requests: OAuthRequests;
  readonly tokens: OAuthTokens;
  readonly accessTokens: McpTokens;
  constructor(
    readonly grants: McpGrants,
    readonly issuer: string,
    readonly metadata = new ClientMetadataLoader(undefined, grants.options.now),
  ) {
    this.requests = new OAuthRequests(grants, issuer);
    this.tokens = new OAuthTokens(grants, issuer);
    this.accessTokens = new McpTokens({
      keys: grants.options.keys,
      grants,
      issuer,
      now: grants.options.now,
    });
  }

  async register(input: unknown) {
    const parsed = oauthRegistrationSchema.safeParse(input);
    if (!parsed.success || parsed.data.redirect_uris.some((uri) => !validRedirectUri(uri)))
      throw new OAuthBoundaryError("invalid_client_metadata");
    const id = uuidv7(this.grants.options.now());
    const metadata = {
      ...parsed.data,
      client_id: id,
      client_id_issued_at: Math.floor(this.grants.options.now() / 1000),
    };
    await this.grants.options.db.run(
      sql(
        "INSERT INTO oauth_clients (id,metadata,created_at,write_id) VALUES (:id,:metadata,:now,:id)",
        {
          id,
          metadata: JSON.stringify(metadata),
          now: int(this.grants.options.now()),
        },
      ),
    );
    return metadata;
  }

  async client(clientId: string, redirectUri: string): Promise<ConsentClient> {
    if (clientId.startsWith("https://")) {
      let metadata: Awaited<ReturnType<ClientMetadataLoader["load"]>>;
      try {
        metadata = await this.metadata.load(clientId);
      } catch {
        throw new OAuthBoundaryError("invalid_client");
      }
      if (!redirectUriMatches(redirectUri, metadata.redirectUris))
        throw new OAuthBoundaryError("invalid_redirect_uri");
      return {
        name: metadata.name,
        unverified: false,
        metadataHost: metadata.metadataHost,
        loopbackOnly: metadata.loopbackOnly,
      };
    }
    if (!/^[a-f0-9-]{36}$/.test(clientId)) throw new OAuthBoundaryError("invalid_client");
    const row = await this.grants.options.db.first(
      sql("SELECT metadata,last_used_at,created_at FROM oauth_clients WHERE id = :id", {
        id: clientId,
      }),
    );
    if (
      !row ||
      (row.last_used_at === null && Number(row.created_at) <= this.grants.options.now() - 86400_000)
    )
      throw new OAuthBoundaryError("invalid_client");
    const metadata = oauthRegistrationSchema.safeParse(JSON.parse(String(row.metadata)));
    if (!metadata.success) throw new OAuthBoundaryError("invalid_client");
    if (!redirectUriMatches(redirectUri, metadata.data.redirect_uris))
      throw new OAuthBoundaryError("invalid_redirect_uri");
    if (
      row.last_used_at === null ||
      Number(row.last_used_at) < this.grants.options.now() - 3600_000
    )
      await this.grants.options.db.run(
        sql("UPDATE oauth_clients SET last_used_at = :now, write_id = :write WHERE id = :id", {
          now: int(this.grants.options.now()),
          write: uuidv7(this.grants.options.now()),
          id: clientId,
        }),
      );
    return {
      name: metadata.data.client_name,
      unverified: true,
      metadataHost: null,
      loopbackOnly: metadata.data.redirect_uris.every((uri) => new URL(uri).protocol === "http:"),
    };
  }

  validateTarget(resource: string, scope?: string) {
    if (resource !== `${this.issuer}/mcp`) throw new OAuthBoundaryError("invalid_target");
    if (scope !== undefined) {
      try {
        oauthScopes(scope);
      } catch {
        throw new OAuthBoundaryError("invalid_scope");
      }
    }
  }

  async revoke(token: string, clientId: string) {
    if (!token.includes(".")) return this.tokens.revoke(token, clientId);
    try {
      const verified = await this.accessTokens.verifyAccessToken(token);
      const identity = verified.extra?.identity as McpIdentity | undefined;
      if (identity) await this.tokens.revokeGrant(identity, clientId);
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
    }
  }

  async exchange(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new OAuthBoundaryError("invalid_request");
    const body = input as Record<string, unknown>;
    const field = (name: string) => {
      const value = body[name];
      if (typeof value !== "string" || !value.length || value.length > 2048)
        throw new OAuthBoundaryError("invalid_request");
      return value;
    };
    this.validateTarget(field("resource"));
    const clientId = field("client_id");
    const resource = field("resource");
    try {
      const result =
        body.grant_type === "authorization_code"
          ? await this.tokens.code({
              code: field("code"),
              clientId,
              resource,
              redirectUri: field("redirect_uri"),
              verifier: field("code_verifier"),
              ...(body.scope === undefined ? {} : { scope: field("scope") }),
            })
          : body.grant_type === "refresh_token"
            ? await this.tokens.refresh({
                refreshToken: field("refresh_token"),
                ...(body.scope === undefined ? {} : { scope: field("scope") }),
                clientId,
                resource,
              })
            : undefined;
      if (!result) throw new OAuthBoundaryError("unsupported_grant_type");
      return {
        access_token: await this.accessTokens.sign(result.identity),
        token_type: "Bearer",
        expires_in: 900,
        scope: result.identity.scopes.join(" "),
        ...(result.refreshToken ? { refresh_token: result.refreshToken } : {}),
      };
    } catch (error) {
      if (error instanceof McpError) throw new OAuthBoundaryError("invalid_grant");
      throw error;
    }
  }
}
