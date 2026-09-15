# Composio research (verified 2026-09-15)

Scope: the current Composio TypeScript SDK for server-side use in Symplist. NestJS on Render starts connections; Trigger.dev v4 tasks run tools; the Vercel AI SDK agent loop calls our own tool wrappers. Covers sessions and meta tools, the toolkit catalogue, auth configs, connected accounts, single-tool execution, errors, rate limits and webhooks.

How this was checked: versions come from `npm view` on 2026-09-15. API facts come from the official Markdown docs at docs.composio.dev (llms.txt index, REST v3.1 reference, TypeScript SDK reference) and were checked against the published `.d.mts` types and `dist/index.mjs` of `@composio/core@0.18.1`. Every snippet below was type-checked with `tsc` 7.0.2 (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `skipLibCheck: false`) in a throwaway project. The probes used an invalid API key, so no live account was involved. REST v3.1 (`https://backend.composio.dev/api/v3.1`) is current, and the SDK calls v3.1 paths.

## Versions

| Package | Version | Peer / engine notes |
| --- | --- | --- |
| `@composio/core` | 0.18.1 (published 2026-09-04) | peer `zod >=3.25.76 <5`; engines `node >=22.22.3`; ESM only (`exports` has `default` -> `.mjs`, no `require` condition); license ISC. Hard deps include `openai ^7.2.0`, `pusher-js ^8.6.0`, `undici ^7.29.0`, `@composio/client 0.1.0-alpha.76` (a prerelease, pinned by core). No `typescript` peer. Built with `typescript: npm:@typescript/typescript6@^6.0.2`. `1.0.0-beta.0`/`beta.1` exist (dist-tag not latest): ignore. |
| `@composio/slim` | 0.18.1 | Same API and deps as core without packaged source/docs (2.5 MB vs 3.5 MB unpacked). Optional. |
| `@composio/client` | 0.1.0-alpha.76 (transitive) | Stainless REST client exposed via `composio.getClient()`. Do not add as a direct dep (prerelease). |
| `@composio/vercel` | 0.12.0 | peer `@composio/core >=0.10.0 <1.0.0`, `ai ^6.0.0 \|\| ^7.0.0` (ai latest 7.0.101); engines `node >=22.22.3`. Only needed if we hand `session.tools()` to the AI SDK (not recommended, see Decisions). |
| `@composio/json-schema-to-zod` | 0.3.2 (transitive) | peer `zod >=3.25.76 <5`. |
| `zod` | 4.6.5 | Satisfies the core peer. Core types import `zod/v3` and `zod/v4` subpaths, which zod 4.x provides. |
| `typescript` | 7.0.2 | Works, see TypeScript 7 below. |
| `composio-core` | 0.5.39 | Legacy v1/v2 SDK. Do not use. |

TypeScript 7 evidence (experiment in the research scratchpad):
- ESM, `module: ESNext`, `moduleResolution: bundler` (same as `apps/worker/tsconfig.json`), `skipLibCheck: false`: 0 errors across session, catalogue, auth, pagination, webhook and no-retry snippets. Negative tests (wrong field names, `r.successful` on a session result, `sandbox.enabled`) fail as expected, so the types resolve and are not `any`.
- CommonJS with `module/moduleResolution: nodenext`, `type: commonjs`, decorators on (NestJS-style): `tsc` 7.0.2 emits `require("@composio/core")`, and Node 24.15 loads it through `require(esm)` (exit 0).
- The SDK sets no TypeScript peer and ships plain `.d.mts`. No TS 6/5 fallback is needed. If a regression appears, the fallback is `typescript@6.0.3`, the line Composio builds with.

## Verified APIs

### 1. Client setup

```ts
import { Composio } from '@composio/core';

export const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,   // also read from env by default
  allowTracking: false,                   // default true: SDK telemetry to Composio
  disableVersionCheck: true,              // default false: fetches registry.npmjs.org at init
  // dangerouslyAllowAutoUploadDownloadFiles defaults to false; keep it off
});
```
Sources: https://docs.composio.dev/reference/sdk-reference/typescript/composio.md (`ComposioConfig` in the published types), https://docs.composio.dev/docs/changelog/2026/04/24.md (auto file handling is off by default).
`composio.sessions.create(...)` is the canonical entry point, and `composio.create(...)` remains an alias. `composio.toolRouter` is deprecated, and so is `composio.mcp` (use the session MCP endpoint instead).

### 2. Sessions (formerly "tool router") and meta tools

Create, reuse, update and delete a session (REST: `POST/GET/PATCH/DELETE /api/v3.1/tool_router/session[/{id}]`):

```ts
const session = await composio.sessions.create(userId, {
  toolkits: ['gmail', 'github'],          // or { enable: [...] } / { disable: [...] }; omit = whole catalogue
  sandbox: { enable: false },             // removes COMPOSIO_REMOTE_WORKBENCH + COMPOSIO_REMOTE_BASH_TOOL
  manageConnections: false,               // removes COMPOSIO_MANAGE_CONNECTIONS; we own the connect UI
  multiAccount: { enable: true, maxAccountsPerToolkit: 3, requireExplicitSelection: true }, // 2-10, default 5
  connectedAccounts: { gmail: ['ca_work'] },   // pin accounts (arrays preferred)
  authConfigs: { notion: 'ac_notion_api_key' },
  tags: { disable: ['destructiveHint'] },      // optional behaviour filter
});
session.sessionId;                                   // store it; sessions do not expire
const again = await composio.sessions.use(sessionId);
await again.update({ connectedAccounts: { gmail: ['ca_personal'] } }); // partial PATCH
const { sessionId: deletedId, deleted } = await session.delete();      // core >= 0.13.1
```
Sources: https://docs.composio.dev/docs/configuring-sessions.md, https://docs.composio.dev/docs/how-composio-works.md, https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSession.md.
- When the sandbox is disabled, the two sandbox tools are excluded, sandbox prompt lines are stripped, and direct sandbox calls get a 400 (configuring-sessions). `workbench` is an accepted alias for `sandbox`.
- Account precedence when a tool runs: the `connectedAccounts` pin, then the `authConfigs` override, then an existing auth config for the toolkit, then a new Composio-managed auth config, else an error if no managed scheme exists. With several accounts the most recently connected one wins, unless multi-account `requireExplicitSelection` is on (configuring-sessions, managing-multiple-connected-accounts).
- `preload.tools` is not supported when `multiAccount.enable` is true (configuring-sessions).
- The REST create body also has `manage_connections.enable_connection_removal` (default true: the agent can delete connections) and `enable_wait_for_connections`, plus `experimental.permissions`, `search.enable` and `execute.enable_multi_execute`. The SDK type does not expose these; setting `manageConnections: false` avoids the removal risk.

Meta tools today. The names match the brief exactly (https://docs.composio.dev/toolkits/meta-tools.md):

| Slug | Tags | Key input | Key output (`data`) |
| --- | --- | --- | --- |
| `COMPOSIO_SEARCH_TOOLS` | important, openWorld, readOnly | `queries[] {use_case (req), known_fields}`, `session {generate_id \| id}`, `model`, `search_strategy auto\|tool_search` | `results[] {primary_tool_slugs, related_tool_slugs, toolkits, reasoning, recommended_plan_steps?, known_pitfalls?}`, `tool_schemas{slug:...}`, `toolkit_connection_statuses[] {toolkit, has_active_connection, connection_details, account_type, status_message}`, `time_info`, `session {id, generate_id, instructions}`, `next_steps_guidance[]` |
| `COMPOSIO_GET_TOOL_SCHEMAS` | readOnly | `tool_slugs[]` (req), `include` (default `["input_schema"]`), `session_id` | `success`, `tool_schemas`, `not_found[]`, `suggestions` |
| `COMPOSIO_MANAGE_CONNECTIONS` | openWorld, destructive | `toolkits[]` (req), `reinitiate_all`, `session_id` | `message`, `results{}`, `summary {total_toolkits, active_connections, initiated_connections, failed_connections}` |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | openWorld, destructive, important | `tools[] {tool_slug, arguments}` (req), `sync_response_to_workbench` (boolean, **required**, default false), `thought`, `current_step`, `current_step_metric`, `session_id` | `results[] {index, tool_slug, response?, error?}`, `success_count`, `error_count`, `total_count`, `remote_file_info?`, `next_steps?` |
| `COMPOSIO_REMOTE_WORKBENCH` | destructive, openWorld | `code_to_execute` (Python, 180 s limit) | `results`, `stdout`, `stderr`, `*_file_path` |
| `COMPOSIO_REMOTE_BASH_TOOL` | destructive, openWorld | `command` (180 s limit) | `stdout`, `stderr`, `stdoutLines`, `stderrLines` |

Every meta tool response envelope is `{ data, error?, successful }` (per-tool pages under https://docs.composio.dev/toolkits/meta-tools/). The REST `execute_meta` slug enum also includes `COMPOSIO_WAIT_FOR_CONNECTIONS` (opt-in through `manage_connections.enable_wait_for_connections`), and create accepts `experimental.submit_feedback` for `COMPOSIO_SUBMIT_FEEDBACK` (https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSessionBySessionIdExecuteMeta.md). `sync_response_to_workbench: true` saves the full response to the workbench and returns an inline preview. With the sandbox disabled, always send `false`.

Executing meta tools or app tools from server code, without an agent framework:

```ts
const found = await session.execute('COMPOSIO_SEARCH_TOOLS', {
  queries: [{ use_case: 'send an email', known_fields: 'recipient:a@b.com' }],
  session: { generate_id: true },
});
// found: { data: Record<string, unknown>; error: string | null; logId: string }  (no `successful` field)

await session.execute('COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: ['GMAIL_SEND_EMAIL'] });
await session.execute('COMPOSIO_MULTI_EXECUTE_TOOL', {
  tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@b.com' } }],
  sync_response_to_workbench: false,
});
// App tool directly; `account` selects an account (id or alias) in multi-account sessions
await session.execute('GMAIL_SEND_EMAIL', { recipient_email: 'a@b.com' }, { account: 'ca_work' });
```
Sources: https://docs.composio.dev/docs/how-composio-works.md#executing-session-tools, https://docs.composio.dev/reference/sdk-reference/typescript/session.md, https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSessionBySessionIdExecute.md.
- `session.execute` posts to `/tool_router/session/{id}/execute` (meta and app tools) and returns `{data, error, logId}`. Do not run meta tools through `composio.tools.execute()`: it fails with `"can only be called inside a tool-router session"` (how-composio-works).
- `session.execute` uses the SDK's default client, which retries twice on 408/409/429/5xx and connection errors (from `@composio/client` `shouldRetry`; the SDK source comments say session execute keeps default retries). For write actions, send the call once through a no-retry raw client:

```ts
const raw = composio.getClient().withOptions({ maxRetries: 0 });
const res = await raw.toolRouter.session.execute(sessionId, { tool_slug: 'GMAIL_SEND_EMAIL', arguments: {...}, account: 'ca_work' });
// res: { data, error, log_id }; raw.toolRouter.session.executeMeta(sessionId, { slug: 'COMPOSIO_SEARCH_TOOLS', arguments })
```

Other session helpers: `session.search({ query, toolkits? })`, `session.toolkits({ limit, cursor, isConnected, toolkits, search })`, which returns `{ items: [{ slug, name, logo, isNoAuth, connection?: { isActive, authConfig?, connectedAccount?: { id, status } } }], cursor, totalPages }`, and `session.proxyExecute(...)` (session.md, configuring-sessions).

### 3. Toolkit catalogue (all toolkits, pagination, managed-auth fields)

REST `GET /api/v3.1/toolkits`: query `limit` (max 1000), `cursor`, `managed_by composio|all|project`, `type native|custom|all`, `sort_by usage|alphabetically`, `include_deprecated`, `search`, `category`. The response is `{ items, next_cursor, total_pages, current_page, total_items }`. Each item has `slug`, `name`, `type`, `auth_schemes: string[]`, **`composio_managed_auth_schemes: string[]`**, `no_auth: boolean`, `auth_guide_url`, `meta {description, logo, categories, tools_count, triggers_count, version}` (https://docs.composio.dev/reference/api-reference/toolkits/getToolkits.md). The catalogue lists 1,519 toolkits (https://docs.composio.dev/toolkits.md).

The SDK's `composio.toolkits.get({ limit, cursor })` returns a plain array and **drops `next_cursor`** (confirmed in `transformToolkitListResponse`), so it cannot paginate. Use the raw client:

```ts
const client = composio.getClient();
let cursor: string | undefined;
do {
  const page = await client.toolkits.list({ limit: 1000, cursor, managed_by: 'all', sort_by: 'alphabetically' });
  for (const t of page.items) {
    const managed = t.composio_managed_auth_schemes ?? [];   // e.g. ['OAUTH2']
    const schemes = t.auth_schemes ?? [];
    const noAuth = t.no_auth ?? false;
  }
  cursor = page.next_cursor ?? undefined;
} while (cursor);
```

Per-toolkit detail: `composio.toolkits.get('gmail')` (REST `GET /toolkits/{slug}`) returns camelCase `composioManagedAuthSchemes`, `authConfigDetails[] { mode, name, fields: { authConfigCreation, connectedAccountInitiation: { required, optional } } }`. REST also returns `composio_managed_auth[] { mode, scopes.available }` (https://docs.composio.dev/reference/api-reference/toolkits/getToolkitsBySlug.md). A toolkit has Composio-managed OAuth when `composio_managed_auth_schemes` contains its OAuth method (https://docs.composio.dev/toolkits/managed-auth.md, which lists 122 such toolkits). Field helpers: `composio.toolkits.getAuthConfigCreationFields(slug, scheme, { requiredOnly })` and `getConnectedAccountInitiationFields(...)` (https://docs.composio.dev/reference/sdk-reference/typescript/toolkits.md).

### 4. Auth configs

```ts
// Find (SDK `toolkit` maps to REST `toolkit_slug`; page size is capped at 50)
const page = await composio.authConfigs.list({ toolkit: 'gmail', isComposioManaged: true, limit: 50, cursor });
page.items[0]?.id; page.nextCursor;
// Create with Composio-managed credentials
const ac = await composio.authConfigs.create('gmail', { type: 'use_composio_managed_auth', name: 'Gmail (managed)' });
ac.id; // ac_...
// API-key toolkit whose key the user enters in the hosted form
await composio.authConfigs.create('perplexityai', { type: 'use_custom_auth', authScheme: 'API_KEY', name: 'Perplexity', credentials: {} });
await composio.authConfigs.disable(id); await composio.authConfigs.enable(id); await composio.authConfigs.delete(id);
```
Sources: https://docs.composio.dev/docs/authentication/programmatic-auth-configs.md, https://docs.composio.dev/reference/sdk-reference/typescript/auth-configs.md, https://docs.composio.dev/reference/api-reference/auth-configs/getAuthConfigs.md, https://docs.composio.dev/kb/guide/platform-pagination.md (50-item clamp). The REST list item has `id`, `type default|custom`, `auth_scheme`, `is_composio_managed`, `status ENABLED|DISABLED`, `no_of_connections`, `expected_input_fields[] {name, required, is_secret, user_visible}`. Creating a config does not change sessions: pass its id in `authConfigs`.

### 5. Connected accounts

Start a connection (Connect Link) with a callback:

```ts
// Session route: auto-resolves or creates the managed auth config (precedence above)
const req = await session.authorize('gmail', { callbackUrl: 'https://api.symplist.app/connections/callback', alias: 'work' });
req.id;            // connected account id (ca_...), status INITIATED
req.redirectUrl;   // https://connect.composio.dev/link/ln_...

// Direct route with a known auth config; allowMultiple is required if an ACTIVE account already exists
const link = await composio.connectedAccounts.link(userId, ac.id, { callbackUrl, alias: 'work', allowMultiple: true });
```
- After auth, Composio redirects to the callback with `status=success|failed` and `connected_account_id=ca_...` appended, keeping existing query params (https://docs.composio.dev/docs/authentication/manually-authenticating.md).
- A link session that is not completed within 10 minutes expires (https://docs.composio.dev/kb/guide/platform-connected-accounts.md). REST `POST /connected_accounts/link` returns `link_token`, `redirect_url`, `expires_at`, `connected_account_id` (https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink.md).
- `connectedAccounts.initiate()` is deprecated for Composio-managed OAuth. It throws `ComposioLegacyConnectedAccountsEndpointRetiredError` after the 2026-07-03 cutover, so use `link()` (https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts.md).
- Optional hardening: callback identity verification. When a project verifier URL is set, Composio redirects with `session_uri`, and our server posts `session_uri` plus the signed-in `user_id` to `POST /api/v3.1/connected_accounts/complete_auth`. The `session_uri` is single-use and valid for 10 minutes, and a mismatch returns 400 and marks the connection FAILED (https://docs.composio.dev/reference/api-reference/connected-accounts.md).

Completion, listing, disabling and deleting:

```ts
const acct = await composio.connectedAccounts.get(id);       // { id, status, statusReason, isDisabled, alias, wordId, toolkit.slug, authConfig }
await composio.connectedAccounts.waitForConnection(id, 120_000); // polls GET every 1 s; throws ConnectionRequestFailedError (FAILED/EXPIRED/REVOKED) or ConnectionRequestTimeoutError
const page = await composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: ['gmail'], statuses: ['ACTIVE', 'EXPIRED'], limit: 100, cursor });
page.items; page.nextCursor;
await composio.connectedAccounts.disable(id);   // PATCH /connected_accounts/{id}/status {enabled:false} -> INACTIVE
await composio.connectedAccounts.enable(id);
await composio.getClient().connectedAccounts.patch(id, { alias: 'work-gmail' }); // SDK update() only accepts { enabled } in 0.18.1
await composio.connectedAccounts.delete(id);    // soft delete; does NOT pass revoke_on_delete
await composio.getClient().connectedAccounts.delete(id, { revoke_on_delete: true }); // also revokes upstream (background job)
```
Sources: https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts.md, https://docs.composio.dev/reference/api-reference/connected-accounts/getConnectedAccounts.md, https://docs.composio.dev/reference/api-reference/connected-accounts/deleteConnectedAccountsByNanoid.md, https://docs.composio.dev/reference/api-reference/connected-accounts/patchConnectedAccountsByNanoIdStatus.md.
- Statuses (SDK enum): `INITIALIZING, INITIATED, ACTIVE, FAILED, EXPIRED, INACTIVE, REVOKED`.
- The REST list `user_id` field is deprecated and will stop being returned ("you will only be able to read via userId"), so store the `ca_ → user` mapping ourselves.
- Explicit provider revoke: `POST /api/v3.1/connected_accounts/{nanoid}/revoke` -> `{ revoked_tokens[], connected_account {id, status: REVOKED} }`. It returns 400 if the toolkit cannot revoke and 409 if the account is not revokable (https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsByNanoidRevoke.md). This endpoint is not in `@composio/client` alpha.76, so call it with `fetch`.
- Multiple accounts per toolkit: repeat `authorize`/`link` (with `allowMultiple` on `link`), label with `alias` (unique per user and toolkit), and select with the session `connectedAccounts` pin or `account` on execute (https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts.md).

### 6. Executing one tool with a specific connected account

```ts
const { version } = await composio.tools.getRawComposioToolBySlug('GMAIL_SEND_EMAIL'); // e.g. '20260901_00'
const r = await composio.tools.execute('GMAIL_SEND_EMAIL', {
  userId,
  connectedAccountId: 'ca_work',
  version,                                  // required unless toolkitVersions set or dangerouslySkipVersionCheck: true
  arguments: { recipient_email: 'a@b.com' },
});
r.successful; r.error; r.data;
```
Sources: https://docs.composio.dev/reference/sdk-reference/typescript/tools.md, https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug.md (body `connected_account_id`, `user_id`, `version`, `arguments`; response `{data, error, successful, log_id}`). A version resolving to `latest` throws `ComposioToolVersionRequiredError`. `tools.execute` and `tools.proxyExecute` use a no-retry client, and SDK 0.14.0+ does not auto-retry non-idempotent executions (https://docs.composio.dev/kb/guide/sdk-tool-execution-retries.md). Do not use it for meta tools.

### 7. Errors and rate limits

- REST error envelope: `{"error":{"message","code"(number),"slug","status","request_id","suggested_fix","errors"?}}`. A live probe with an invalid key returned 401 `{"code":801,"slug":"APIKey_InvalidAPIKey",...}`, and a missing key returned `906 Auth_NoAuthProvided`, with an `x-request-id` header (https://docs.composio.dev/reference/errors.md and the endpoint pages).
- Two error families reach app code (confirmed at runtime):
  - `ComposioError` subclasses from `@composio/core` carry `name`, `code` (e.g. `TS-SDK::TOOLKIT_FETCH_ERROR`), `possibleFixes` and `cause`. Examples: `ComposioToolkitFetchError`, `ComposioToolExecutionError`, `ComposioMultipleConnectedAccountsError`, `ConnectionRequestFailedError`, `ComposioWebhookSignatureVerificationError`.
  - Raw `@composio/client` `APIError` subclasses (`AuthenticationError`, `RateLimitError`, and so on) have `.status`, `.headers` and `.error` (the envelope). They escape from `sessions.create`, `connectedAccounts.list` and `session.execute`. They are not `instanceof` the core `ComposioError` and are not re-exported by core, so detect them by shape (`typeof e.status === 'number' && 'error' in e`).
- Rate limits are per organization over a fixed 1-minute window, shared by all endpoints: Hobby 2,000, Pro 10,000, Enterprise custom. Headers are `X-RateLimit`, `X-RateLimit-Remaining`, `X-RateLimit-Window-Size`, and `Retry-After` on 429. The 429 body is `{"message":"Rate limit exceeded. ..."}`, which is not the standard envelope (https://docs.composio.dev/reference/rate-limits.md). Provider quotas are separate, and managed OAuth apps share quota across Composio customers (https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app.md).

### 8. Webhooks relevant to connection status

```ts
await composio.triggers.setWebhookSubscription({
  webhookUrl: 'https://api.symplist.app/webhooks/composio',
  enabledEvents: ['composio.connected_account.expired'],   // SDK default is only composio.trigger.message
});
// handler (raw body required)
const result = await composio.triggers.parse(request /* Fetch Request or { body, headers } */, {
  verifySecret: process.env.COMPOSIO_WEBHOOK_SECRET,
});
const raw = result.rawPayload;   // union of V1/V2/V3 shapes; V1 has no `type`, so narrow first
if ('type' in raw && raw.type === WebhookEventTypes.CONNECTION_EXPIRED) { /* mark Needs attention */ }
```
The docs' `result.rawPayload.type === ...` snippet does not compile under `strict` in 0.18.1 because `rawPayload` is a union and V1 has no `type`. The narrowed form above compiles.
Sources: https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events.md, https://docs.composio.dev/reference/api-reference/webhook-subscriptions.md, https://docs.composio.dev/reference/api-reference/webhook-events/composio_connected_account_expired.md, https://docs.composio.dev/reference/sdk-reference/typescript/triggers.md.
- Signature: HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${rawBody}`, base64, header `webhook-signature: v1,<sig>`. The SDK enforces a 300 s timestamp tolerance. `webhook-id` equals payload `id` and stays stable across retries, so use it for idempotency. `x-composio-delivery-attempt` counts attempts.
- The documented event types are only `composio.trigger.message`, `composio.connected_account.expired` (V3 payloads only) and `composio.trigger.disabled` (https://docs.composio.dev/reference/api-reference/webhook-events.md). **No "connection became active" event exists**, so completion comes from the callback redirect plus a GET, or from polling.
- Composio's outbound IPs are dynamic, so no IP allowlist; rely on signature verification.

## Decisions and recommendations

1. **Package:** add `@composio/core@0.18.1` (exact pin) and `zod@4.6.5` to `apps/api` (Nest) and `apps/worker` (Trigger). Do not add `@composio/vercel`, `@composio/client` or `composio-core`. Keep TypeScript 7.0.2. Construct the client with `allowTracking: false` and `disableVersionCheck: true`.
2. **Server-owned execution, not a provider:** Simon's AI SDK tools should be our own thin wrappers that call `session.execute(...)` for reads and meta tools. For approved write actions, call the no-retry raw client (`getClient().withOptions({ maxRetries: 0 }).toolRouter.session.execute`) inside a Trigger task with its own idempotency, so a timeout never re-sends an email.
3. **Session shape per user or chat:** use `sandbox: { enable: false }` (the no-code-execution constraint) and `manageConnections: false`, so the agent cannot start or delete connections and never gets `enable_connection_removal`. Always send `sync_response_to_workbench: false`. Store `sessionId` on the chat and reuse it with `sessions.use`. Change pinned accounts with `session.update({ connectedAccounts })`.
4. **Catalogue (D6):** fetch live with the raw client: `toolkits.list({ limit: 1000, cursor, managed_by: 'all' })`, about 2 pages, cached in memory for minutes and not persisted. Show a toolkit when `no_auth`, or `composio_managed_auth_schemes` is non-empty, or `auth_schemes` includes a user-supplied scheme (`API_KEY`, `BEARER_TOKEN`, `BASIC`) whose required connect fields are `user_visible`. Hide the rest.
5. **Auth configs (D7, automatic):** look up with `authConfigs.list({ toolkit, isComposioManaged: true })` and paginate with the 50 cap. Choose an `ENABLED` config, else `create(toolkit, { type: 'use_composio_managed_auth' })`. For API-key-only toolkits, create `use_custom_auth` with `credentials: {}` and pass `authConfigs` to the session. Serialize creation per toolkit (a D1 row or lock) to avoid duplicate configs.
6. **Connect flow:** Nest calls `session.authorize(toolkit, { callbackUrl, alias })`, or `connectedAccounts.link(..., { allowMultiple: true })` for extra accounts, and records `{connected_account_id, user, toolkit, expires ~10 min}`. The callback handler checks the id against that pending record for the signed-in user, then `connectedAccounts.get(id)` must show `ACTIVE`. Also run a delayed Trigger task that polls `get` with backoff until 10 minutes pass; do not use `waitForConnection`, which polls every second. Consider enabling callback identity verification before opening the beta.
7. **Lifecycle:** subscribe to `composio.connected_account.expired` (V3) and verify with `triggers.parse({ verifySecret })` on the raw body, deduplicating on `webhook-id`. Map EXPIRED, FAILED, REVOKED and INACTIVE to "Needs attention". Disconnect with `getClient().connectedAccounts.delete(id, { revoke_on_delete: true })`, not SDK `delete` (which does not revoke). Use `disable`/`enable` for pause.
8. **Direct single-tool execution** (scheduled jobs with a known account): use `tools.execute(slug, { userId, connectedAccountId, version, arguments })` with a pinned `version` from `getRawComposioToolBySlug`, or `toolkitVersions` config. It does not retry.
9. **Errors and limits:** normalize both error families into one internal error carrying `status`, `code`/`slug`, `request_id` and `suggested_fix`. On 429, honor `Retry-After` and let Trigger retry only idempotent work. Budget 2,000 requests/min on Hobby across Nest and Trigger combined.

## Risks and open questions

- **Meta-tool result nesting through `session.execute`:** the types give `{data, error, logId}`, and the meta docs describe `{data, error, successful}`. Whether `data` is the meta `data` object or the whole envelope needs a live check with a real key (the credentialed live-integration check in coverage).
- **`sync_response_to_workbench` with the sandbox disabled:** the field is required. Behaviour for large responses (no offload target) is undocumented; verify that `false` returns full inline data and that nothing is silently truncated.
- **Session execute retries:** the default SDK client retries 408/409/429/5xx up to twice on `session.execute`, which risks duplicate side effects. Mitigated by the no-retry raw client; that path relies on `@composio/client` (prerelease alpha.76, whose shape may change).
- **SDK gaps and inconsistencies:** `toolkits.get()` drops pagination. The multi-account guide's `connectedAccounts.update(id, { alias })` does not type-check in 0.18.1 (`update` takes only `{ enabled }`), so use raw `connectedAccounts.patch`. The docs' webhook `rawPayload.type` access needs narrowing. SDK docs say `connectedAccounts.delete` "will revoke" tokens, but the implementation does not send `revoke_on_delete` and REST defaults it to false. The `/revoke` endpoint is missing from the client. REST `user_id` on accounts is deprecated.
- **1.0 is coming:** `@composio/core@1.0.0-beta.1` (2026-09-11) moves to `@composio/client 2.0.0-rc.7`. Expect breaking changes, so pin 0.18.1 and re-verify on 1.0 GA.
- **Managed OAuth trade-offs (D7):** consent screens show "Composio", quota is shared with other Composio customers, managed-auth triggers poll at 15 minutes minimum, and switching to own apps forces users to reconnect. Composio can withdraw managed credentials per toolkit (for example, Twitter on 2026-02-12, per the changelog https://docs.composio.dev/docs/changelog.md), so re-derive visibility live and do not cache.
- **API-key toolkits through the hosted form:** docs imply that `use_custom_auth` + `credentials: {}` lets users enter keys on the Connect Link page (`user_visible` fields). Confirm live for a sample toolkit, and confirm session auto-resolution accepts it via `authConfigs`.
- **No "connection active" webhook:** completion depends on the callback redirect or polling. A user who closes the tab leaves the account `INITIATED` until it expires.
- **OAuth session fixation:** without callback identity verification, a copied Connect Link could attach someone else's account. Enabling it disables completing connections from the Composio dashboard.
- **Rate-limit plan naming differs between pages** (reference: Hobby/Pro; KB: Starter/Hobby/Growth), so confirm the plan limit in the dashboard. The 429 body does not use the standard error envelope.
- **Supply chain:** `@composio/core` pulls `openai`, `pusher-js` and `undici` even when unused. pnpm 12 `minimumReleaseAge` accepted 0.18.1 in the scratch install (published 11 days ago). Re-check if a newer patch is pinned.
- **Privacy:** SDK telemetry and the npm version check are on by default. Disable both, and keep Composio out of the PostHog allowlist unless events are explicitly added.
