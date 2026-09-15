# MCP research (verified 2026-09-15)

Scope: the incoming, remote MCP server at `https://api.symplist.tejassuds.com/mcp`, served by NestJS 12 (Express 5) on Render. It accepts OAuth 2.1 access tokens from a first-party authorization server (with an in-app consent screen) and bearer API keys (decision D4). Versions come from the npm registry. API facts come from official docs or the published type declarations, and I checked them with throwaway experiments on Node 24.15.0 and TypeScript 7.0.2.

Summary:

- **Current spec revision: `2026-07-28`.** It removes sessions and `Mcp-Session-Id`, drops the `initialize` handshake, adds `server/discover`, requires `Mcp-Method`/`Mcp-Name` headers, and deprecates Dynamic Client Registration (DCR) in favour of Client ID Metadata Documents (CIMD). Most clients in use today still speak the 2025 revisions, so the server has to handle both.
- **Current SDK: v2, split into packages.** The server needs `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/express` 2.0.0 and `@modelcontextprotocol/node` 2.0.0. `createMcpHandler(factory)` is stateless per request and serves 2026-07-28 clients plus 2025-era clients (stateless fallback) from one factory.
- **The SDK checks tokens but does not issue them.** v2 ships only resource-server helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`). The v1 authorization-server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`) survive only in the deprecated, frozen `@modelcontextprotocol/server-legacy/auth`, which has no CIMD support and is slated for removal in v3. The first-party authorization server is ours to build in Nest.
- **API keys fit the same gate.** One `OAuthTokenVerifier` can recognise either an API key (by prefix) or a JWT access token and return an `AuthInfo` for both.
- **TypeScript 7.0.2 works.** Strict `nodenext` compiles with `skipLibCheck: false` passed with no errors against all MCP packages, including a NestJS 12 controller using decorators. TypeScript also reported deliberate type errors correctly, and the compiled servers answered real MCP traffic.

## Versions

| Package | Version | Peer / engine notes |
| --- | --- | --- |
| MCP specification | `2026-07-28` (current) | Previous revision `2025-11-25`. Per the changelog, deprecated features get at least 12 months before removal. |
| `@modelcontextprotocol/server` | 2.0.0 (published 2026-07-27) | `engines.node >=20`. Depends on `zod ^4.2.0` and `@modelcontextprotocol/core 2.0.0`. No peer dependencies. Ships both ESM and CJS with `.d.mts`/`.d.cts`. |
| `@modelcontextprotocol/express` | 2.0.0 | Peers: `express ^4.18.0 \|\| ^5.0.0`, `@modelcontextprotocol/server ^2.0.0`. Node >=20. |
| `@modelcontextprotocol/node` | 2.0.0 | Peers: `hono ^4.11.4`, `@modelcontextprotocol/server ^2.0.0`. Depends on `@hono/node-server ^1.19.9`. Node >=20. Add `hono` explicitly. |
| `@modelcontextprotocol/core` | 2.0.0 | Transitive; public Zod schemas. |
| `@modelcontextprotocol/client` | 2.0.0 | Dev and test only (contract tests against `/mcp`). |
| `@modelcontextprotocol/server-legacy` | 2.0.0 | Its README says: "Deprecated — frozen copy of v1 code… planned for removal in v3". Do not use. |
| `@modelcontextprotocol/sdk` | 1.30.0 (v1 line) | Peers: `zod ^3.25 \|\| ^4.0`, `@cfworker/json-schema ^4.1.1`. Node >=18. v1 gets fixes for at least 6 months after v2. Do not use for new code. |
| `@modelcontextprotocol/inspector` | 2.6.0 | `engines.node >=22.19.0`. Manual testing tool only. |
| `zod` | 4.6.5 | The SDK docs import `* as z from 'zod/v4'`. |
| `express` | 5.2.1 | `@nestjs/platform-express` 12.0.3 pins `express 5.2.1`. |
| `@nestjs/core` / `@nestjs/common` / `@nestjs/platform-express` | 12.0.3 | `"type": "module"`. The SDK's ESM build loads cleanly. |
| `jose` | 6.2.12 | For signing and verifying our own JWT access tokens. |
| `hono` | 4.13.8 | Required as a peer of `@modelcontextprotocol/node`, even though we don't use Hono directly. |
| `typescript` | 7.0.2 | Compatible (see verdict). The SDK's own devDependency is `typescript ^5.9.3`; that doesn't matter because it ships compiled JS and declarations. |
| Alternatives, not recommended | `oidc-provider` 9.12.2; `@better-auth/mcp` / `@better-auth/cimd` / `@better-auth/oauth-provider` 1.7.5 | See "SDK authorization-server helpers". |

**TypeScript 7 evidence.** In a scratch project I ran `tsc` 7.0.2 (`strict`, `module`/`moduleResolution: nodenext`, `verbatimModuleSyntax`, `skipLibCheck: false`) over:

1. An Express 5 server using `createMcpHandler`, `registerTool` with a Zod 4 schema, `requireBearerAuth`, `mcpAuthMetadataRouter`, `originValidation` and `toNodeHandler`.
2. A client test using `@modelcontextprotocol/client` 2.0.0 and `@modelcontextprotocol/sdk` 1.30.0.
3. A NestJS 12.0.3 app with `experimentalDecorators` and `emitDecoratorMetadata`.

All three compiled with exit code 0. A negative test (a number assigned to a string inside a tool handler, a non-object `inputSchema`, and an `AuthInfo` missing `scopes`) produced the expected TS2769, TS2322 and TS2741 errors. The compiled output ran on Node 24.15.0 and answered MCP requests from both eras. No TypeScript 6.x or 5.x fallback is needed.

## Verified APIs

### 1. Spec 2026-07-28: what changes for a server

Sources: https://modelcontextprotocol.io/specification/2026-07-28/changelog and https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http

- Protocol-level sessions and `Mcp-Session-Id` are gone, and so is `initialize`/`notifications/initialized`. Every request carries `_meta` with `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`. Servers MUST implement `server/discover`.
- Every POST MUST carry `MCP-Protocol-Version`. `Mcp-Method` is required on all requests, and `Mcp-Name` on `tools/call`, `resources/read` and `prompts/get`. If a header disagrees with the body, the server returns `400` with JSON-RPC error `-32020` (`HeaderMismatch`).
- The HTTP GET stream is replaced by `subscriptions/listen`. Resumability (`Last-Event-ID`) is removed. A server that only speaks this revision SHOULD answer GET/DELETE with `405` and ignore `Mcp-Session-Id`.
- Servers "MUST validate the `Origin` header on all incoming connections… If the `Origin` header is present and invalid, servers MUST respond with HTTP 403 Forbidden."
- Server-to-client requests (elicitation, sampling, roots) become Multi Round-Trip Requests (`InputRequiredResult`). Roots, Sampling and Logging are deprecated.
- Authorization changes: `iss` in authorization responses (RFC 9207), DCR deprecated in favour of CIMD, `application_type` required in DCR, and client credentials bound to the issuing authorization server.

### 2. Server handler plus a tool with a Zod schema

Sources: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html, https://ts.sdk.modelcontextprotocol.io/v2/serving/express.html and https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html (raw markdown under https://github.com/modelcontextprotocol/typescript-sdk/tree/main/docs)

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(({ authInfo, era }) => {      // factory runs once per HTTP request
    const server = new McpServer({ name: 'symplist', version: '1.0.0' });
    server.registerTool(
        'list_tasks',
        {
            title: 'List tasks',
            description: "List the caller's tasks",
            inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
            annotations: { readOnlyHint: true }
        },
        async ({ limit }, ctx) => {
            const caller = ctx.http?.authInfo;                    // same object the verifier returned
            return { content: [{ type: 'text', text: `limit=${limit} user=${String(caller?.extra?.userId)}` }] };
        }
    );
    return server;
});
// handler: { fetch(request, { authInfo?, parsedBody? }), close(), notify, bus }
```

- `registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations?, icons?, _meta? }, cb)` accepts a Standard Schema such as `z.object(...)`. The raw-shape form `{ field: z.string() }` still works but is marked `@deprecated`. Arguments are validated before the handler runs, and invalid input comes back as a tool result with `isError: true`. `outputSchema` plus `structuredContent` is validated too.
- `CreateMcpHandlerOptions` (from the type declarations) are:
  - `legacy: 'stateless'` (the default) or `'reject'`.
  - `responseMode: 'auto'` (default), `'json'` or `'sse'`. `'json'` drops mid-call notifications.
  - `bus` (a `ServerEventBus` for `subscriptions/listen`; defaults to in-process).
  - `maxSubscriptions` (default 1024), `keepAliveMs` (default 15000) and `onerror`.
- The handler itself does no token verification and no Host/Origin validation: "`authInfo` is pass-through".

### 3. Stateless vs sessions, and legacy clients

Sources: https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html, https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.html and https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html

- With `legacy: 'stateless'`, each 2025-era request (including `initialize`) is served by a fresh instance from the same factory through a transport built with `sessionIdGenerator: undefined`. Legacy GET and DELETE get `405`. With `legacy: 'reject'`, 2025 clients get `400` / `-32022 Unsupported protocol version`.
- Sessionful mode only exists on the hand-wired 2025 transport (`NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })`, optionally with an `eventStore`). Routing between modes goes through `isLegacyRequest(request)`. Symplist doesn't need either.
- What crosses nodes in stateless mode is the `subscriptions/listen` fan-out ("the default bus is in-process"). That's fine for the single Render instance (A2).
- Verified by experiment against the server below:
  - A v2 client with `versionNegotiation: { mode: 'auto' }` connected on era `modern`.
  - The v2 default mode and a v1.30.0 client both connected on `legacy`.
  - All three called the tool with an API key.
  - GET `/mcp` returned `405`.
  - A mismatched `Mcp-Name` returned `400` / `-32020`.
  - `server/discover` returned `{"supportedVersions":["2026-07-28"],...}`.

### 4. Mounting in NestJS 12 (Express)

Sources: https://ts.sdk.modelcontextprotocol.io/v2/serving/express.html, https://docs.nestjs.com/middleware ("functional middleware"; Nest registers `json` and `urlencoded` body parsers by default) and https://docs.nestjs.com/controllers (`@All()`; `@Res()` switches to library-specific response mode). I compiled this with TypeScript 7.0.2 and ran it.

```ts
@Controller()
class McpController {
    @All('mcp')                                               // POST handled; GET/DELETE answered 405 by the SDK
    async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
        await mcpNode(req, res, req.body);                     // mcpNode = toNodeHandler(createMcpHandler(factory))
    }
}

@Module({ controllers: [McpController] })
class McpModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer
            .apply(originValidation(['symplist.tejassuds.com']), bearer)   // 403 bad Origin, then 401/403 bearer
            .forRoutes('mcp');
    }
}

// main.ts, before listen():
app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: MCP_URL, scopesSupported, resourceName: 'Symplist' }));
```

Observed:

- A bad `Origin` got `403`.
- An allowed `Origin` with a key got `200`.
- No token got `401` with the challenge header.
- A legacy `tools/call` returned an SSE `message` event.
- A modern `tools/call` returned `application/json` with `resultType: "complete"`.

Pass `req.body` as the third argument, because Nest's JSON parser has already drained the stream. `toNodeHandler` forwards `req.auth` to `ctx.http.authInfo`.

### 5. Bearer validation: `requireBearerAuth` and `OAuthTokenVerifier`

Sources: https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html and https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/express/auth/bearerAuth.html (the declarations in `@modelcontextprotocol/server` 2.0.0 match)

```ts
import { getOAuthProtectedResourceMetadataUrl, requireBearerAuth, type OAuthTokenVerifier } from '@modelcontextprotocol/express';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';

const MCP_URL = new URL('https://api.symplist.tejassuds.com/mcp');
const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
        // MUST throw OAuthError(InvalidToken) to get 401; any other error becomes 500 server_error
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
    }
};
const bearer = requireBearerAuth({
    verifier,
    requiredScopes: ['tasks:read'],                                   // optional; missing scopes -> 403 insufficient_scope
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_URL) // -> https://api.symplist.tejassuds.com/.well-known/oauth-protected-resource/mcp
});
```

`AuthInfo` is `{ token; clientId; scopes: string[]; expiresAt?: number /* seconds */; resource?: URL; extra?: Record<string, unknown> }`.

Behaviour I observed in the SDK source and in experiments:

- A missing header, a non-`Bearer` scheme, or an `OAuthError(InvalidToken)` gets `401`: `WWW-Authenticate: Bearer error="invalid_token", error_description="…", [scope="…",] resource_metadata="…"`.
- A token missing `requiredScopes` gets `403`: `Bearer error="insufficient_scope", scope="tasks:read tasks:write", resource_metadata="…"`.
- **Tokens without `expiresAt` are rejected with 401** ("Token has no expiration time"). API keys therefore need a synthetic `expiresAt`.
- **The SDK does not check audience or `resource`.** The verifier must enforce `aud`/`resource` equal to `https://api.symplist.tejassuds.com/mcp` (required by the spec's token audience rule).
- `scope=` appears in the challenge only when `requiredScopes` is set. On a request with no credentials the SDK still adds `error="invalid_token"`; RFC 6750 says it SHOULD NOT include an error code there. Clients tolerate this.

### 6. Protected Resource Metadata and AS metadata router

Sources: https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html, https://datatracker.ietf.org/doc/html/rfc9728 and https://datatracker.ietf.org/doc/html/rfc8414

```ts
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/express';
import type { OAuthMetadata } from '@modelcontextprotocol/server';

const ISSUER = 'https://api.symplist.tejassuds.com';          // no trailing slash; must equal metadata "issuer" exactly
const oauthMetadata: OAuthMetadata = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,       // DCR (deprecated in spec, still used by Cursor/VS Code/Claude fallback)
    revocation_endpoint: `${ISSUER}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],              // clients MUST refuse to proceed if absent
    token_endpoint_auth_methods_supported: ['none'],         // Claude requires "none" to pick CIMD
    scopes_supported: ['tasks:read', 'tasks:write', 'offline_access'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
};
app.use(mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: new URL(`${ISSUER}/mcp`),
    scopesSupported: ['tasks:read', 'tasks:write'],          // PRM SHOULD NOT list offline_access
    resourceName: 'Symplist'
}));
```

What the router served in the experiment (localhost values shown):

- `GET /.well-known/oauth-protected-resource/mcp` returned `{"resource":"http://localhost:3999/mcp","authorization_servers":["http://localhost:3999"],"scopes_supported":["tasks:read","tasks:write"],"resource_name":"Symplist"}` with `Access-Control-Allow-Origin: *`.
- `GET /.well-known/oauth-authorization-server` returned `oauthMetadata` unchanged.
- `GET /.well-known/oauth-protected-resource` (root) returned `404`; the router only serves the path-aware URL.
- The `OAuthMetadata` type accepts `client_id_metadata_document_supported` and `authorization_response_iss_parameter_supported`. An excess-property check under TypeScript 7 passed.
- `buildOAuthProtectedResourceMetadata` requires an HTTPS issuer outside localhost. `dangerouslyAllowInsecureIssuerUrl` is for local development only.

RFC facts:

- RFC 9728: `resource` is REQUIRED, and the returned `resource` "MUST be identical" to the identifier the well-known URL was derived from.
- RFC 9728 §3.1: a path is inserted after `/.well-known/oauth-protected-resource`.
- RFC 8414: `issuer`, `authorization_endpoint`, `token_endpoint` and `response_types_supported` are required, and clients must reject metadata whose `issuer` differs from the URL they used.

### 7. Authorization spec requirements (2026-07-28)

Sources: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration and https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations

- **Roles.** The MCP server is an OAuth 2.1 resource server. The authorization server "MUST implement OAuth 2.1" (draft-ietf-oauth-v2-1-13) and may be co-hosted with the resource server.
- **Protected Resource Metadata (PRM).**
  - The MCP server MUST implement RFC 9728, and the document MUST list at least one `authorization_servers` entry.
  - The server advertises it through `WWW-Authenticate: Bearer resource_metadata="…"` on 401, and/or at a well-known URI.
  - Clients try the path-aware URI `/.well-known/oauth-protected-resource/mcp` first, then the root.
- **AS metadata discovery.**
  - Clients try `/.well-known/oauth-authorization-server`, then `/.well-known/openid-configuration` (issuer without a path).
  - They MUST reject a document whose `issuer` is not identical.
  - The AS MUST provide RFC 8414 metadata or OIDC Discovery.
- **Client registration**, in the client's priority order: pre-registered, then CIMD (if `client_id_metadata_document_supported`), then DCR (if `registration_endpoint`), then prompting the user.
  - AS and clients SHOULD support CIMD. DCR is MAY and deprecated.
  - For CIMD, the AS "MUST validate that the fetched document's `client_id` matches the URL exactly" and "MUST validate redirect URIs… against those in the metadata document". It SHOULD cache per HTTP headers and SHOULD consider SSRF.
  - The AS "MUST clearly display the redirect URI hostname during authorization" and SHOULD warn when all redirect URIs are localhost.
  - DCR clients MUST send `application_type` (`native` for loopback/CLI, `web` otherwise).
- **PKCE.** Clients MUST use `S256`. If `code_challenge_methods_supported` is absent, clients MUST refuse to proceed.
- **Resource indicators (RFC 8707).** Clients MUST send `resource` (the canonical server URI, for example `https://api.symplist.tejassuds.com/mcp`, no fragment, preferably no trailing slash) in both the authorization and token requests, "regardless of whether authorization servers support it".
- **Token use.**
  - Tokens go in `Authorization: Bearer <token>` on every request, never in the query string.
  - Servers "MUST validate that access tokens were issued specifically for them as the intended audience". Invalid or expired tokens get `401`.
  - Servers "MUST NOT accept or transit any other tokens", and MUST NOT pass the client's token to upstream APIs (confused deputy).
- **Issuer in the authorization response (RFC 9207).** The AS SHOULD include `iss` in authorization responses, including errors. If it does, it MUST advertise `authorization_response_iss_parameter_supported: true`. Clients compare `iss` to the recorded issuer by exact string match.
- **Scopes and errors.**
  - The server SHOULD include `scope` in the 401 challenge. Without it, clients use PRM `scopes_supported`.
  - Runtime insufficient scope SHOULD return `403` with `Bearer error="insufficient_scope", scope="…", resource_metadata="…"`, listing all required scopes in one challenge.
  - Status codes: 401 for missing or invalid tokens, 403 for insufficient scope, 400 for a malformed request.
- **Refresh tokens.** The AS MUST rotate refresh tokens for public clients and SHOULD issue short-lived access tokens. Clients MAY add `offline_access` when the AS lists it. Servers SHOULD NOT list `offline_access` in the challenge or in PRM.
- **Transport security.** All AS endpoints MUST be HTTPS. Redirect URIs MUST be localhost or HTTPS. The AS MUST validate exact redirect URIs.

Example challenge from the spec:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource",
                         scope="files:read"
```

### 8. SDK authorization-server helpers: do they fit a first-party AS?

Sources: https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html, https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html and the README of `@modelcontextprotocol/server-legacy` 2.0.0 (https://www.npmjs.com/package/@modelcontextprotocol/server-legacy)

- In v2, the resource-server helpers live in `@modelcontextprotocol/express`: `requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl` and `OAuthTokenVerifier`. Runtime-neutral versions are in `@modelcontextprotocol/server`: `verifyBearerToken`, `bearerAuthChallengeResponse`, `oauthMetadataResponse` and `buildOAuthProtectedResourceMetadata`.
- The AS helpers (`mcpAuthRouter`, `OAuthServerProvider`, `ProxyOAuthServerProvider`, `authorizationHandler`, `tokenHandler`, `revocationHandler`, `clientRegistrationHandler`) moved to `@modelcontextprotocol/server-legacy/auth`, described as "deprecated, frozen v1 copy; migrate AS to a dedicated IdP/OAuth library". The SDK docs say: "the SDK never issues tokens."
- Why the legacy router doesn't fit:
  - Its `OAuthServerProvider` (`clientsStore`, `authorize`, `challengeForAuthorizationCode`, `exchangeAuthorizationCode(…, resource?)`, `exchangeRefreshToken`, `verifyAccessToken`, `revokeToken?`) is DCR-store-based and has no CIMD support.
  - It is frozen, and removal is planned for v3.
  - `ProxyOAuthServerProvider` is for proxying an upstream IdP, which is not our case.
- Third-party options I checked:
  - `oidc-provider` 9.12.2 is a certified OAuth/OIDC server. Its CIMD support is "experimental", tracking draft-02, and experimental specs change in MINOR releases (https://github.com/panva/node-oidc-provider/blob/main/docs/README.md).
  - `@better-auth/mcp` 1.7.5 turns a Better Auth app into the AS. It "targets MCP 2026-07-28 exclusively" and tells servers to use `legacy: 'reject'` (https://better-auth.com/docs/plugins/mcp). That conflicts with serving today's 2025-era clients, and the docs cover only Better Auth hosts.

### 9. Bearer API keys alongside OAuth

Sources: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization ("Authorization is OPTIONAL… Implementations using an HTTP-based transport SHOULD conform") and https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html (client `AuthProvider { token(); onUnauthorized?() }` for non-OAuth bearer auth). I verified this pattern in the experiment.

```ts
const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
        if (token.startsWith('sym_')) {                                   // API key: HMAC(MCP_TOKEN_DIGEST_SECRET) lookup in D1
            const key = await apiKeys.findActiveByDigest(hmacSha256(token));
            if (!key) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown or revoked API key');
            await access.assertBetaUnlocked(key.userId);                  // note 04: every MCP call checks access
            return { token, clientId: `api_key:${key.id}`, scopes: key.scopes,
                     expiresAt: Math.floor(Date.now() / 1000) + 60,       // SDK requires expiresAt
                     extra: { userId: key.userId, kind: 'api_key' } };
        }
        const { payload } = await jwtVerify(token, signingKey, { issuer: ISSUER, audience: MCP_URL.href })
            .catch(() => { throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token'); });
        await access.assertGrantActive(payload.sub!, String(payload.client_id), payload.iat!);
        return { token, clientId: String(payload.client_id), scopes: String(payload.scope).split(' '),
                 expiresAt: payload.exp, resource: MCP_URL, extra: { userId: payload.sub, kind: 'oauth' } };
    }
};
```

This is illustrative: `apiKeys`, `access`, `hmacSha256` and `signingKey` are app code. `jwtVerify(token, key, { issuer, audience })` is jose's API (https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md). The experiment used the same shape with HS256.

Client support for static bearer keys:

- Claude Code: `--header "Authorization: Bearer …"`.
- Cursor and VS Code: `headers` in `mcp.json`.
- The Claude.ai, Desktop and Cowork "Request headers" option is beta and org-shared.
- ChatGPT "cannot present custom API keys". ChatGPT users must use OAuth.

### 10. How popular clients connect with OAuth today

| Client | Registration | Redirect URIs to accept | Static header | Source |
| --- | --- | --- | --- | --- |
| Claude.ai / Desktop / mobile / Cowork | CIMD selected only if AS metadata has `client_id_metadata_document_supported: true` **and** `none` in `token_endpoint_auth_methods_supported`; otherwise DCR; or a pre-registered client ID/secret in Advanced settings. Always sends PKCE S256. Uses the WWW-Authenticate `scope`, else PRM `scopes_supported`, and adds `offline_access` if the AS lists it. Refreshes on 401 and up to 5 minutes before expiry. Token endpoint must accept `application/x-www-form-urlencoded`. 10 s timeout on discovery/registration/token, 30 s on refresh. Egress `160.79.104.0/21`. | `https://claude.ai/api/mcp/auth_callback` | Beta (`static_headers`, org-shared; `Authorization` not allowed alongside OAuth) | https://claude.com/docs/connectors/building/authentication and https://claude.com/docs/connectors/custom/remote-mcp |
| Claude Code | Its own CIMD `https://claude.ai/oauth/claude-code-client-metadata`; DCR; `--client-id/--client-secret/--callback-port`. The v2 runtime (default from v2.1.232) probes for 2026-07-28. | `http://localhost/callback` and `http://127.0.0.1/callback` **with any port** | `claude mcp add --transport http name URL --header "Authorization: Bearer …"`; `.mcp.json` `headers` with `${VAR}` | https://code.claude.com/docs/en/mcp and https://claude.com/docs/connectors/building/authentication |
| ChatGPT (apps/plugins, developer mode) | CIMD preferred (`none` or `private_key_jwt`), else DCR or a static client. Requires `code_challenge_methods_supported` with `S256`. Puts `resource` in the token `aud`. | `https://chatgpt.com/connector_platform_oauth_redirect` if the AS meets the issuer-identification requirements, otherwise `https://chatgpt.com/connector/oauth/{callback_id}` | Not supported ("cannot present custom API keys"; no client-credentials grant) | https://developers.openai.com/plugins/build/auth |
| VS Code (Copilot) | "first starts with a Dynamic Client Registration (DCR) handshake and then falls back to a client-credentials workflow" (manual client ID/secret); `oauth.clientId` in config | `http://127.0.0.1:33418` and `https://vscode.dev/redirect` | `"headers": {"Authorization": "Bearer ${input:api-token}"}` | https://code.visualstudio.com/api/extension-guides/ai/mcp and https://code.visualstudio.com/docs/agents/reference/mcp-configuration |
| Cursor | DCR by default ("static OAuth client credentials in `mcp.json` instead of dynamic client registration" when needed: `auth.CLIENT_ID`, `CLIENT_SECRET`, `scopes`) | `http://localhost:8787/callback` (desktop), `https://www.cursor.com/agents/mcp/oauth/callback` (web/agents) | `"headers": {…}` with `${env:NAME}` | https://cursor.com/docs/context/mcp |

### 11. Minimal verified server and auth metadata (Express form; Nest mount in section 4)

I compiled this with TypeScript 7.0.2 and ran it on Node 24.15.0. It is the scratch experiment minus the demo key store.

```ts
import express from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, originValidation, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const ISSUER = 'https://api.symplist.tejassuds.com';
const MCP_URL = new URL(`${ISSUER}/mcp`);

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'symplist', version: '1.0.0' });
    server.registerTool('list_tasks', { description: "List the caller's tasks", inputSchema: z.object({ limit: z.number().int().max(50).default(10) }) },
        async ({ limit }, ctx) => ({ content: [{ type: 'text', text: `user=${String(ctx.http?.authInfo?.extra?.userId)} limit=${limit}` }] }));
    return server;
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: MCP_URL, scopesSupported: ['tasks:read', 'tasks:write'], resourceName: 'Symplist' }));
const node = toNodeHandler(handler);
app.all('/mcp',
    originValidation(['symplist.tejassuds.com']),
    requireBearerAuth({ verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_URL) }),
    (req, res) => void node(req, res, req.body));
```

`oauthMetadata` is defined in section 6 and `verifier` in section 9.

A modern request that succeeded in the experiment:

```http
POST /mcp
Authorization: Bearer <jwt aud=…/mcp>
Accept: application/json, text/event-stream
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: list_tasks

{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tasks","arguments":{"limit":5},
 "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}
-> 200 application/json {"result":{"content":[…],"resultType":"complete","_meta":{"io.modelcontextprotocol/serverInfo":{…}}},…}
```

A JWT with the wrong audience got `401 invalid_token`.

### 12. Required endpoints checklist

| # | Endpoint | Method | Owner | Required by | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `/mcp` | POST (GET/DELETE get 405 from the SDK) | Nest + SDK | MCP transport | Origin allowlist, then bearer (OAuth JWT or API key), then `toNodeHandler(createMcpHandler)`. Serves `server/discover` and both eras. |
| 2 | `/.well-known/oauth-protected-resource/mcp` | GET | `mcpAuthMetadataRouter` | MCP (RFC 9728) | `resource` exactly `https://api.symplist.tejassuds.com/mcp`; `authorization_servers: [ISSUER]`. Also referenced from every 401/403 challenge. |
| 3 | `/.well-known/oauth-authorization-server` | GET | `mcpAuthMetadataRouter` (our real AS metadata, same origin) | MCP (RFC 8414 or OIDC) | `issuer` with no trailing slash; `code_challenge_methods_supported: ["S256"]`; `client_id_metadata_document_supported: true`; `token_endpoint_auth_methods_supported: ["none"]`; `authorization_response_iss_parameter_supported: true`; `registration_endpoint`; `scopes_supported` incl. `offline_access`. |
| 4 | `/oauth/authorize` | GET | Nest (custom) | OAuth 2.1 | Requires `response_type=code`, `client_id` (a CIMD URL or DCR id), exact `redirect_uri` (loopback port-agnostic for `localhost`/`127.0.0.1`), `code_challenge` + `S256`, and `resource` equal to the MCP URL (`invalid_target` otherwise). Echoes `state`. Checks the login cookie (host-only on the API domain) and beta access, then redirects to the web consent page. |
| 5 | Consent UI `https://symplist.tejassuds.com/oauth/consent` plus internal API for pending request details and approve/deny | GET / POST | Next.js + Nest | Spec (show redirect hostname; warn on localhost-only) | Shows `client_name`, redirect host and scopes. On approval, Nest issues a single-use code bound to client, redirect_uri, code_challenge, resource and scopes, then redirects with `code`, `state` and `iss`. Errors also carry `iss`. |
| 6 | `/oauth/token` | POST `application/x-www-form-urlencoded` | Nest (custom) | OAuth 2.1 | `authorization_code` (verifies `code_verifier`, `redirect_uri`, `client_id`, `resource`) and `refresh_token` (rotate on every use; reuse detection revokes the grant). Returns a short-lived JWT access token (`aud`=MCP URL). Uses RFC 6749 error codes (`invalid_grant`). |
| 7 | `/oauth/register` | POST `application/json` | Nest (custom) | DCR, RFC 7591 (deprecated but needed by Cursor, VS Code and Claude fallback) | Public clients only (`token_endpoint_auth_method: none`). Accept `application_type`, validate redirect URIs (HTTPS or loopback), rate-limit, garbage-collect unused registrations. |
| 8 | `/oauth/revoke` | POST form | Nest (custom) | RFC 7009 (recommended) | Revoke a refresh token or grant. Also offered from Settings, under connected agents. |
| 9 | CIMD fetcher (outbound, not a route) | n/a | Nest | CIMD draft | HTTPS only, block private or loopback IPs (SSRF), size and time limits, respect cache headers, require `client_id` to equal the URL, and require `client_name` and `redirect_uris`. |
| 10 | API key management (create shows the key once; list; revoke) | App REST | Nest | D4 | Store only the HMAC digest (`MCP_TOKEN_DIGEST_SECRET`). Keys carry scopes and an optional expiry. |
| 11 | `/.well-known/oauth-protected-resource` (root) | not served | n/a | Optional fallback | Skip it. The challenge carries `resource_metadata`, and a root document would describe a different `resource` under RFC 9728 §3.3. |

## Decisions and recommendations

1. **Use SDK v2.** Add `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/express@2.0.0`, `@modelcontextprotocol/node@2.0.0`, `hono@4.13.8` (peer) and `zod@4.6.5` to the Nest app. Add `@modelcontextprotocol/client@2.0.0` as a dev dependency for contract tests. Do not add `@modelcontextprotocol/sdk` (v1) or `@modelcontextprotocol/server-legacy`.
2. **Serve both protocol eras from one stateless endpoint**: `createMcpHandler(factory)` with the default `legacy: 'stateless'`. Do not set `legacy: 'reject'`, because hosted Claude surfaces, Cursor, VS Code and older SDKs still speak 2025-era MCP. Use no sessions and no event store. The default in-process bus is enough for the single Render instance (A2); revisit if Nest is ever replicated.
3. **Mount under Nest the way section 4 does.** Use an `@All('mcp')` controller with `@Res()` and `mcpNode(req, res, req.body)`. Apply `originValidation([WEB_ORIGIN host])` and `requireBearerAuth` through `MiddlewareConsumer.forRoutes('mcp')`. Register `mcpAuthMetadataRouter` with `app.use` before `listen`. If a global route prefix is ever introduced, `/mcp`, `/.well-known/*` and `/oauth/*` must be excluded from it. Never accept cookie auth on `/mcp`.
4. **Build a small first-party OAuth 2.1 authorization server in Nest** (endpoints 3 to 9), with issuer `https://api.symplist.tejassuds.com`.
   - Public clients only, authorization code with PKCE S256 only, `resource` required and pinned to the MCP URL.
   - Emit `iss` (RFC 9207).
   - Support both CIMD and DCR.
   - Do not advertise OIDC; no ID tokens are needed.
   - Access tokens: JWTs signed with `MCP_OAUTH_SIGNING_KEY` via `jose`, `aud` = MCP URL, lifetime 10 to 15 minutes, carrying `sub`, `client_id`, `scope` and `jti`.
   - Refresh tokens: opaque, stored as digests in D1, rotated on every use.
   - The consent screen is the "Allow this agent" page in the web app and must show the client name and redirect hostname.
   - Why not the frozen `mcpAuthRouter` (no CIMD) or Better Auth's plugin (modern-only posture, Better Auth host): both fit worse. `oidc-provider` is the fallback if the custom AS grows. Its CIMD support is experimental; pin with `~`.
5. **Scopes, kept minimal for beta.** Use `tasks:read` and `tasks:write`; PRM advertises both, and the AS additionally lists `offline_access`. Enforce `tasks:write` per tool inside handlers (an `isError` result, following the SDK docs), or return `403 insufficient_scope` for a step-up. Reuse the same domain authorization services as chat (note 07 §9).
6. **One verifier for both credential types**, routed by a key prefix (for example `sym_…`).
   - Enforce issuer, audience and expiry for JWTs yourself; the SDK does not.
   - Throw only `OAuthError(InvalidToken)` for rejects, since anything else becomes a 500.
   - Always set `expiresAt`; API keys get a short synthetic value.
   - On every call, check beta access or relock and grant revocation, with a short bounded cache (notes 03 and 04). Short JWT lifetimes alone can't satisfy relock semantics.
7. **Redirect URI matching.**
   - Exact match for HTTPS.
   - Port-agnostic match for `http://127.0.0.1` and `http://localhost` loopback URIs (Claude Code, VS Code, Cursor desktop).
   - Pre-trust nothing. Clients arrive through CIMD or DCR.
   - Expected hosted callbacks include `https://claude.ai/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform_oauth_redirect`, `https://vscode.dev/redirect` and `https://www.cursor.com/agents/mcp/oauth/callback`.
8. **Tests.**
   - Contract tests with `@modelcontextprotocol/client` in `mode: 'auto'` and in legacy mode against `/mcp`.
   - Metadata snapshots.
   - 401/403 challenge shape, wrong `aud`, a missing `resource`, PKCE failure, `iss` present, refresh rotation and reuse, and CIMD SSRF guards.
   - A manual pass with MCP Inspector 2.6.0 and with Claude Code (`claude mcp add --transport http`).
9. **TypeScript 7.0.2 stays the compiler.** The MCP packages need no TypeScript 6.x or 5.x fallback.

## Risks and open questions

- **Era churn.** 2026-07-28 was only published on 2026-07-28, and client adoption varies: Claude Code probes for it, while other clients' docs still cite 2025-11-25. The default stateless legacy fallback covers both eras. Re-verify when a client drops 2025 support, or when the SDK changes `legacy` defaults.
- **The SDK has no audience check** and rejects tokens without `expiresAt`. A verifier bug here means accepting foreign tokens or getting 500s. Cover it with tests.
- **DCR sprawl.** Claude registers a new client on every fresh connection when it uses DCR. Advertise CIMD correctly (both required values) so Claude and ChatGPT use it, and rate-limit DCR and garbage-collect registrations.
- **The CIMD draft is moving.** MCP cites draft-00, while `oidc-provider` and Better Auth track draft-02. Accept the MCP-required fields (`client_id`, `client_name`, `redirect_uris`) and ignore unknown ones.
- **Origin allowlist vs browser-based clients.** A strict allowlist blocks browser-origin MCP clients (for example web inspectors). Server-to-server clients such as Claude.ai, ChatGPT and CLIs send no `Origin`. If browser clients are ever wanted, CORS must allow `Authorization`, `Mcp-Method`, `Mcp-Name` and `MCP-Protocol-Version`, and expose `WWW-Authenticate`.
- **Cross-subdomain consent flow.** The login cookie is host-only on the API domain, and the consent UI lives on the web origin. The approve/deny call must be a credentialed same-site request with CSRF protection. This needs confirming with the auth research.
- **D1 REST latency on every MCP call** for API key lookups and access checks. Use bounded in-memory caches and make sure revocation latency is acceptable.
- **Body size.** Nest's default JSON limit applies to `/mcp` (the SDK's Express helper defaults to 100kb too). Section-write tools may need a higher limit. Verify the Nest body-parser configuration in the backend research.
- **The ChatGPT app review path** (`securitySchemes`, `_meta["mcp/www_authenticate"]`) is OpenAI-specific and wasn't prototyped. It's optional for beta.
- **Not verified live.** The end-to-end OAuth dance with Claude, ChatGPT, Cursor or VS Code can't be tested until the AS exists on a public HTTPS origin.
- **Local tooling.** The scratch experiments used a locally installed pnpm 11.1.2, not the project's pnpm 12.4.2. Package versions came from the registry, so this doesn't affect the findings, but the project's pnpm 12 minimum-release-age policy (A6) may delay `hono` 4.13.8 or future SDK patches.
