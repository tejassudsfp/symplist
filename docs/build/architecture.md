# Build architecture

Binding implementation design for the end-to-end build. Every build agent follows this document together with the [numbered specifications](../notes/files/00_index.md), the [screen briefs](../../design/mockups/overall.md), the [decisions](decisions.md), and the verified research notes in `docs/build/research/`. Where this document is silent, follow the specification; where the specification is silent, choose the simplest correct option and record it in [decisions](decisions.md).

## 1. Stack lock (verified 2026-09-15)

Pin exact versions. Do not upgrade or add dependencies outside this list without recording the reason in [decisions](decisions.md).

| Area | Packages |
| --- | --- |
| Runtime and tooling | Node.js 24 LTS, pnpm 12.4.2, TypeScript 7.0.2 (`skipLibCheck: true`), Biome 2.5.13 (lint and format; ESLint/typescript-eslint do not support TypeScript 7) |
| Web | next 16.3.5, react and react-dom 19.3.0, @types/react and @types/react-dom 19.3.0, tailwindcss and @tailwindcss/postcss 4.3.3, postcss 8.5.28, shadcn 4.21.0 with @base-ui/react 1.8.0, class-variance-authority 0.7.1, tw-animate-css 1.4.0, lucide-react 1.46.0, react-resizable-panels 4.12.4, @dnd-kit/react, @dnd-kit/dom and @dnd-kit/helpers 0.5.0, culori 4.0.2 with @types/culori 4.0.1, @fontsource-variable/* and @fontsource/ibm-plex-mono 5.3.0, @codemirror/* 6 (view 6.43.11, state 6.7.4, lang-markdown 6.5.2), @milkdown/kit 7.22.1 (not @milkdown/react), @tanstack/react-query (verify latest stable at install) |
| API | @nestjs/core, common, platform-express, websockets, platform-ws, testing 12.0.3; @nestjs/config 12.0.0; @nestjs/throttler 6.5.0; helmet 8.3.0; cookie-parser 1.4.7; reflect-metadata 0.2.2; rxjs 7.8.2; zod 4.6.5 (Nest 12 Standard Schema validation, no class-validator) |
| Agent | ai 7.0.101, @ai-sdk/react 4.0.104, @ai-sdk/openai 4.0.66, @ai-sdk/amazon-bedrock 5.0.82, @ai-sdk/google-vertex 5.0.82, @ai-sdk/togetherai 3.0.49, @ai-sdk/anthropic 4.0.53, @types/json-schema 7.0.15 |
| Durable execution | @trigger.dev/sdk, @trigger.dev/build, trigger.dev 4.6.0 |
| Integrations | @composio/core 0.18.1 (`allowTracking: false`, `disableVersionCheck: true`) |
| Storage | @aws-sdk/client-s3 3.1132.0 (R2); D1 through a first-party fetch client (no `cloudflare` SDK for queries); `node:sqlite` for local and test D1 |
| Email and analytics | resend 6.28.0, react-email 6.9.5, @react-email/render 2.1.0, posthog-js 1.433.4, posthog-node 5.52.3 |
| MCP | @modelcontextprotocol/server, express, node and client 2.0.0; jose 6.2.12 |
| Documents and search | unified 11.0.5, remark-parse 11.0.0, remark-gfm 4.0.1, remark-rehype 11.1.2, remark-stringify 11.0.0, rehype-sanitize 6.0.0, rehype-stringify 10.0.1, minisearch 7.2.0; Git CLI (Trigger image ships 2.39.5; Render image installs Debian git) |
| Time, crypto, ids | temporal-polyfill 1.0.5 (ponyfill import), `node:crypto` (AES-256-GCM, HKDF, HMAC, `crypto.argon2`), uuid 14.0.2 (v7) |
| Tests | vitest 5.0.1, vite 8.3.0, @vitejs/plugin-react 6.1.1, jsdom 30.0.1, @testing-library/react 16.3.3, @testing-library/dom 10.4.2, @testing-library/jest-dom 7.0.1, @testing-library/user-event 14.6.7, @playwright/test 1.63.0, @axe-core/playwright 4.13.0 (named import) |

pnpm 12 rules: build scripts only through `allowBuilds` in `pnpm-workspace.yaml`; deliberately pinned releases younger than one day go in `minimumReleaseAgeExclude`.

## 2. Repository layout and ownership

```text
apps/
  web/        Next.js App Router (Vercel). UI only; never holds server secrets.
  api/        NestJS 12 ESM on Express (Render). HTTP API, WebSocket gateway, MCP server,
              OAuth 2.1 authorization server, share routes, webhooks, local executor and
              local scheduler.
  worker/     Trigger.dev tasks: Simon runs, scheduled scans and deliveries, cleanup, indexing.
  e2e/        Playwright end-to-end, accessibility and visual tests.
packages/
  config/       Zod environment schemas for api, worker and web (public values only).
  contracts/    Zod schemas and types shared by every runtime: ids, errors, REST DTOs,
                WebSocket frames, events, tool inputs/outputs, access states.
  crypto/       Key provider, HKDF, AES-256-GCM envelopes with frozen AAD encoding, HMAC digests,
                Argon2id, token and OTP generation.
  db/           DbClient interface, D1 REST client, local node:sqlite client, migrations and runner.
  storage/      ObjectStore interface, R2 client, local filesystem store.
  core/         Domain services shared by api and worker, one folder per domain with its SQL.
  docs/         Markdown sections, Git versioning service, changes/diffs, read receipts.
  agent/        Simon: provider registry, rules, prompts, native and wrapped tools, run loop.
  integrations/ Composio client wrapper: sessions, meta tools, catalogue, auth configs, connections.
  search/       MiniSearch index build, serialize, encrypt, query, snippets.
  email/        react-email templates with plain-text versions; Resend and log transports.
  analytics/    Event allowlist schemas, payload scrubber, server emitter.
  testing/      Fakes, fixtures (Maya dataset), shared contract test suites.
```

- All packages are ESM TypeScript (`"type": "module"`). Packages build with `tsc -b` to `dist/`; `package.json` `exports` use a `source` condition pointing at `src/*.ts` (used by Vitest, Next `transpilePackages`, and the Trigger bundler) and `default` pointing at `dist/*.js` (used by Node in the api).
- `apps/api` builds with plain `tsc` (Nest CLI refuses TypeScript 7) and runs `node dist/main.js`; development uses `tsc -b --watch` plus `node --watch --env-file-if-exists=.env`.
- `apps/web` lives under `src/`: `app/` routes, `features/<feature>/` UI owned by one feature, `components/ui/` shared primitives, `theme/`, `actions/` (command registry), `lib/api/` (HTTP client), `lib/realtime/` (WebSocket client).
- `apps/api/src/`: `main.ts`, `app.module.ts`, `infra/` (config, db, storage, crypto, email, executors, rate budget), `common/` (guards, pipes, error filter, idempotency interceptor, request context), `modules/<feature>/` (controllers, gateway handlers, providers).
- Feature ownership is folder-level: `core/src/<domain>/`, `apps/api/src/modules/<feature>/`, `apps/web/src/features/<feature>/`, `apps/web/src/app/<route group>/`. A feature changes shared files (barrels, `app.module.ts`, route layouts, contracts index) only through the placeholders created in the foundation.

## 3. Data access and the D1 request budget

Production data lives in Cloudflare D1, reached only through `POST /accounts/{account}/d1/database/{db}/query` with body `{ "batch": [{ "sql", "params" }] }`. Research found the Cloudflare API limit is about 1,200 requests per 5 minutes and may be shared across the account. Treat D1 requests as the scarcest resource.

- `DbClient` interface: `batch(statements): Promise<StatementResult[]>` (one HTTP request, executed in order), plus `all`, `first`, `run` helpers that call `batch` with one statement. Every multi-statement logical write is one `batch` call.
- The D1 REST client enforces a process-wide token bucket (default 3 requests per second sustained, burst 20), honors `Retry-After`, retries reads with backoff, and **never retries writes at the transport level**. An unknown write outcome is reconciled by reading the write's unique `write_id`/request id.
- Conditional writes: guard with version or generation columns and decide from `RETURNING` rows, never from `meta.changes`. The multi-statement batch atomicity of the REST API must be confirmed by the live contract test; until confirmed, design so each safety-critical decision is made by a single conditional statement (for example the invite seat claim is one `UPDATE ... WHERE redemption_count < max_redemptions ... RETURNING`, followed by inserts that are idempotent by unique keys).
- Local and test D1: `node:sqlite` `DatabaseSync`, each batch wrapped in `BEGIN IMMEDIATE`/`COMMIT`, single-statement guard, authorizer rejecting `BEGIN`/`COMMIT`/`SAVEPOINT`/`ATTACH` inside statements. The same shared contract suite runs against both clients (live suite only when credentials exist).
- Budget rules for services: one D1 request per API call where possible (batch reads); cache session/access lookups, preferences and the owner's task tree in api process memory with explicit invalidation on writes (the api is a single instance); worker-originated changes notify the api through the internal event endpoint so caches invalidate. Never write per streamed token.
- Migrations: SQL files in `packages/db/migrations/NNNN_name.sql`, applied in lexical order by a REST runner that records applied files in `d1_migrations` (wrangler-compatible). Foundation owns `0001`–`0019`. Feature amendments use their reserved range: access `01xx`, workspace `02xx`, documents `03xx`, search and keyboard `04xx`, Simon `05xx`, scheduling `06xx`, vault `07xx`, sharing `08xx`, connections and MCP `09xx`, analytics and consent `10xx`. Render runs migrations as a pre-deploy step; local development runs them on startup.
- IDs are UUIDv7 strings. Ordering within lists uses fractional index strings (`position`), never timestamps.

## 4. Encryption model

Keys come from the environment through a `KeyProvider` interface (a KMS provider can replace it later).

- `CONTENT_KEK_<n>` (32 random bytes, base64url) with `CONTENT_KEK_CURRENT=<n>`. Old versions stay configured until migrated.
- Each account has a random 32-byte account data key, wrapped with `HKDF-SHA256(CONTENT_KEK, "symplist/account-key/v1")` under AES-256-GCM and stored in `account_keys` with its KEK version.
- **Field envelopes** (D1 text columns ending `_enc`): `sym1.<keyVersion>.<iv b64url>.<ciphertext+tag b64url>`, 12-byte IV, 16-byte tag, encrypted with the account data key. AAD is the canonical UTF-8 JSON (sorted keys, no whitespace) of `{"f":"sym1","p":<purpose>,"o":<ownerId>,"t":<table>,"i":<rowId>,"c":<column>,"k":<keyVersion>}`.
- **Object envelopes** (R2): binary `SYMO` magic, version byte, 4-byte header length, JSON header `{v, alg:"A256GCM", kv, iv, wk}` where `wk` is a random per-object key wrapped by the account data key, then ciphertext and tag. AAD binds owner, object kind, object id and format version.
- AAD encoding and envelope formats are frozen with test vectors in `packages/crypto` before any other package writes ciphertext. Wrong key, modified ciphertext, swapped row/column/owner, and truncated objects must fail without plaintext output.
- Digests: `HMAC-SHA256(secret, purpose || 0x00 || value)` with a version prefix, compared with `timingSafeEqual` (sessions, OTPs, invite codes, share tokens, MCP API keys, OAuth codes and refresh tokens, email lookup for suppression lists).
- Argon2id: `crypto.argon2` with m=19456 KiB, t=2, p=1, 16-byte salt, parameters stored with the hash (Vault passphrase wrapping, share-link passwords).
- **Explicit plaintext operational metadata:** ids, owner ids, parent ids, collection, position, status and lifecycle enums, versions/generations, created/updated timestamps, verified email address (needed for OTP delivery and admin lists), access state, schedule instants, local times and IANA zones, reminder/occurrence timing and status, share mode/expiry/status, appearance preferences, analytics consent and analytics id, provider ids and upstream correlation ids. Everything user-authored (task titles and previews, display names, Markdown, messages, tool arguments/results, prompts, artifact titles and bodies, vault items, notification text) is encrypted.
- Vault: see section 11.

## 5. Identity, sessions, access

- Account lookup `POST /v1/auth/lookup {email}` returns whether the account exists (intentional, throttled by IP and email). Signup consent `POST /v1/auth/signup` creates a pending account idempotently and sends a signup OTP. `POST /v1/auth/otp` sends a login OTP; `POST /v1/auth/otp/verify` verifies and creates a session.
- OTP: 6 digits from `crypto.randomInt`, stored as digest bound to challenge id and purpose (`login`, `signup`, `vault_reset`), 10-minute expiry, 5 attempts, 60-second resend cooldown, resend supersedes the previous challenge, atomic consumption. OTP email is sent from the security sender; reminder preferences never suppress it.
- Sessions: 32-byte token. Production cookie `__Host-sym_session` set by the API host (Secure, HttpOnly, SameSite=Lax, Path=/, no Domain) so it never reaches the web or share hosts. The API also sets a non-secret presence cookie `sym_hint=1` for the parent domain so the Next.js proxy can redirect signed-out visitors; the API remains the only authority. D1 stores the token digest, user, created/last-seen/expiry, and revocation. Development uses `sym_session` without the `__Host-` prefix.
- CSRF: CORS allows only the configured web origin with credentials; unsafe methods require a matching Origin and an `X-Symplist-CSRF` header equal to the token returned by `GET /v1/auth/csrf` (bound to the session). WebSocket upgrades check Origin and the session cookie.
- Access state is four independent fields: `email_verified_at`, `beta_state` (`locked`, `unlocked`, `relocked`), `suspended_at`, `onboarding_step` (`name`, `connections`, `done`); `role` (`member`, `admin`). `BETA_ACCESS_REQUIRED=false` treats verified, non-suspended, non-relocked accounts as unlocked.
- Guards (`@Access('identity' | 'admitted' | 'admin')`): `identity` needs a valid session; `admitted` needs verified, unlocked, not suspended, not relocked; `admin` adds role. Every HTTP route, WebSocket subscription and command, MCP call, object read, connector authorization, executor dispatch and tool execution checks access. Workers re-check access through `core/access` before each run step and each external action. Relock revokes sessions' admitted status immediately (cache invalidation), closes protected subscriptions, requests run cancellation and disables share grants.
- Admin bootstrap: `ADMIN_BOOTSTRAP_EMAIL`. On startup and after each successful verification, if that verified account exists and has no admin role, grant `admin` plus an admin access grant and write an audit event. Never promote the first signup. A CLI (`pnpm --filter @symplist/api admin:bootstrap`) performs the same action explicitly.

## 6. HTTP API and errors

- Base path `/v1`. JSON only. Validation with Zod schemas from `packages/contracts` through Nest 12's Standard Schema pipe.
- Error envelope: `{ "error": { "code": "<stable_code>", "message": "<safe text>", "details": {...}?, "requestId": "..." } }`. Codes are enumerated in `contracts/errors.ts` (for example `auth.session_required`, `access.locked`, `access.relocked`, `task.not_found`, `document.conflict`, `idempotency.mismatch`, `rate.limited`, `ai.unavailable`). Unknown and unauthorized resources return the same `not_found` shape without names.
- Mutations with side effects require an `Idempotency-Key` header, recorded in `idempotency_records` (scope, user, key, input fingerprint, status, response, expiry). Exact retries return the recorded response; the same key with a different fingerprint returns `idempotency.mismatch`.
- Logging: structured JSON with request id, route template, status and duration. Never log bodies, OTPs, tokens, share keys, passwords, prompts, document text or email contents. Share-route logs redact the `key` query parameter.

## 7. Realtime protocol

- One WebSocket endpoint: `wss://<api>/v1/ws`. Commands (send message, stop, approve, schedule changes) go through HTTP with idempotency; the socket carries events only, plus `subscribe`/`unsubscribe`/`ping`.
- Client frames: `{"t":"sub","topic":"user"|"conversation:<id>","cursor":<seq|null>}`, `{"t":"unsub","topic"}`, `{"t":"ping"}`.
- Server frames: `{"t":"ev","topic","seq","id","type","data"}`, `{"t":"snapshot","topic","seq","data"}`, `{"t":"resync","topic"}`, `{"t":"err","code"}`, `{"t":"pong"}`.
- `user` topic events: task tree changes, notification created/read, access state changed (forces the client to the correct gate), preference changes from another device, run status for tasks (activity markers).
- `conversation:<id>` events carry AI SDK UI message chunks for the active run (`type: "chunk"`), run status changes, approval requests/decisions and queued-message changes. The api keeps an in-memory ring buffer per active run; a reconnect with a cursor inside the buffer replays the tail, otherwise the api sends a snapshot (persisted messages plus the live partial) and continues.
- Heartbeat: server ping every 30 s, close idle sockets, `1001` on shutdown; the client reconnects with jittered backoff and resubscribes with cursors.

## 8. Simon execution

- Shared code: `packages/agent` builds the model, rules, system instructions and tool set from trusted context (owner, conversation, task, run, access) and runs `streamText` with a step limit, abort signal and `onError`, emitting UI message chunks to a `RunSink`. Both executors call the same `runSimonTurn(runId, deps)`.
- Accepting a message (`POST /v1/conversations/:id/messages`, idempotent): one D1 batch inserts the encrypted user message, a `runs` row (`queued`) and a `dispatch_intents` row. If a run is active, the message is stored as `queued` and dispatched after the run ends. One active run per conversation.
- Dispatcher (api): picks pending intents after commit. `DURABLE=false` starts the run in process. `DURABLE=true` calls `tasks.trigger("simon-run", { runId }, { idempotencyKey: runId })`, stores the Trigger run id, and never runs model or tool code in the api. A reconciler re-dispatches stale pending intents, marks local runs without heartbeat as `interrupted` after restart, and checks Trigger run status for durable runs.
- Output path, durable mode: the worker writes UI chunks to a Trigger realtime stream on the run and the api consumes it server-side, relays it on the conversation topic, and keeps its own browser cursor. The worker persists checkpoints (assistant message parts, tool invocation ledger, run status) to D1 at step boundaries and on finish, so persistence never depends on a viewer. If the realtime stream API proves unsuitable during implementation, use a signed worker-to-api push (`INTERNAL_EVENT_SECRET`) behind the same `RunOutputSource` interface and record the change. The browser never connects to Trigger.
- Approvals: when a tool requires approval, the run records an `approvals` row (exact action, connected account, argument hash, encrypted preview, expiry), emits the approval request and **ends** with status `awaiting_approval`. Approve/deny (`POST /v1/approvals/:id/decision`, idempotent) validates the argument hash and access, then dispatches a continuation run that executes exactly the approved action and continues the loop. Edited arguments create a new approval. This works identically in both executors and needs no long waits.
- Stop: `POST /v1/runs/:id/stop` sets `cancel_requested_at`; local runs abort their controller; durable runs call Trigger `runs.cancel` and the worker also checks the flag between steps. Partial output is checkpointed as `stopped`. Completed external actions are never undone or silently retried; uncertain outcomes are recorded as `uncertain` and surfaced in chat.
- Models: provider registry with `fast` and `smart` aliases from `AI_FAST_*`/`AI_SMART_*`. OpenAI uses the Responses API (`gpt-5.6-luna` effort low, `gpt-5.6-terra` effort medium, `store: false`, no provider-hosted tools). Bedrock (Anthropic), Vertex (Anthropic and Gemini) and Together are available by configuration. Missing configuration yields `ai.unavailable` and the chat's operator-not-configured state. Tests use a scripted mock model selectable only when `NODE_ENV=test` or `AI_PROVIDER_MODE=scripted` in development.
- Tools (all executed through `core` services with trusted identity): `task_context`, `rules_read`, `user_ask`, `task_document_outline`, `task_document_search`, `task_document_read_section`, `task_document_update_section`, `task_document_changes`, `task_document_diff`, `task_document_history`, `task_document_restore`, `task_schedule`, `task_create`/`task_move` (quick chat and task chat), `handoff_prepare`, `artifact_snapshot`, `artifact_share_create`, `artifact_share_list`, `artifact_share_revoke`, and the Composio wrappers `search_tools`, `get_tool_schemas`, `manage_connections`, `execute_tools`. Composio workbench and bash tools and unknown slugs are rejected. Document text is never injected into the prompt; the initial context is task id, title, revision and read positions.
- Quick chat: `conversations.kind = 'quick'`, `task_id` null, `expires_at` 24 hours after last activity. Tools exclude document edits (read-only on explicitly referenced tasks), Vault and incoming MCP. "Save as task" creates a task and attaches the conversation in one batch. Hourly cleanup deletes expired quick chats and their encrypted parts.
- Trigger machines: `simon-run` micro, no OOM retry (an out-of-memory failure marks the run `interrupted`); Git document tasks small-1x; background tasks micro with `retry.outOfMemory` one size up.

## 9. Documents and Git

Follow note 11 exactly. `packages/docs` owns:

- Markdown sections: remark with position offsets; opaque section ids derived from commit id plus structural path; preamble and heading-free block splitting; fenced code awareness; bounded pagination.
- Git service: per-task bare repository reconstructed in a private temp directory (`GIT_TMP_DIR`), Git invoked with `execFile` and an isolated environment (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `core.hooksPath=/dev/null`, `protocol.allow=never`, `safe.bareRepository=explicit`), plumbing commits with explicit parents and author/committer identity (`You` or `Simon`), bundle create/verify/unbundle, `fsck --strict`, bounded diffs with `--no-ext-diff --no-textconv`, cleanup in `finally` plus startup sweep.
- Publication: resolve expected base and request id → read head → reconstruct → commit → bundle → encrypt → upload to an immutable R2 key with `If-None-Match: *` → conditional D1 head update guarded by generation with `RETURNING` → record commit index rows. Conflicts return the current revision and preserve the candidate/draft. Uncertain responses reconcile by request id; unreferenced objects are collected only after a grace period and reachability check.
- Saves: the editor keeps an unsaved buffer locally and in `doc_drafts` (encrypted, per user and task, throttled). A Git commit is published after 3 seconds of idle, on blur, on task switch, on Mod+S, and at most every 60 seconds during continuous typing. "Saved" appears only after publication. History groups consecutive commits by the same author within 10 minutes.
- User saves publish from the api; Simon document edits publish from the executor running the tool.

## 10. Search, keyboard, appearance

- Search: per-user MiniSearch index (titles, headings, section bodies of current documents; chat messages as a separate opt-in field set; archived items flagged) serialized, encrypted and stored in R2 with generation tracked in D1. The api loads and caches decrypted indexes in memory with an LRU bound, applies change intents in batches, and re-authorizes each result when rendering. Indexing runs in the worker when `DURABLE=true` and in the api otherwise. Vault never enters the index. Deadline filters come from schedule metadata, not the index.
- Keyboard: one action registry in `apps/web/src/actions/` (id, label, context, enabled predicate with reason, handler, default binding). Buttons, menus, palette and shortcuts invoke the same actions. Dispatcher precedence: modal/menu → editor/composer → focused pane → app. Unmodified keys and sequences never fire in inputs, contenteditable, the editor, or during IME composition. Bindings follow note 13; remaps persist in preferences.
- Appearance: six themes (Studio, Paper, Pebble, Postcard, Meadow, Tide) defined as token sets from the UI sample (`bg, panel, surface, line, lineStrong, text, muted, faint, hover, selected, codeBg, danger, ok, okSoft, warn, warnSoft, ink, onInk` per mode, plus geometry `r, rl, rc, bubble, rowPad, h2Size, h2Rule, panelInset, panelRadius, panelBorder, panelShadow, sheet, sheetPad, sheetMax, marker*, cardShadow, cardBorder` and fonts). Accent is a separate seed (8 presets or validated hex) resolved with culori into `accent, accentSoft, onAccent, accentHover, focus, link, selection` per theme surface and mode with WCAG checks. CSS variables on `<html data-theme data-mode>`; the server renders the stored preference from a non-sensitive appearance cookie to avoid a flash. Fonts are self-hosted with `next/font/local`.

## 11. Vault

- Setup creates a random vault data key, wraps it twice: under an Argon2id-derived passphrase key (salt and parameters stored) and under `HKDF(VAULT_RECOVERY_KEY, "symplist/vault-recovery/v1")`. First-setup races are prevented by a conditional insert.
- Unlock derives the passphrase key server-side, unwraps the vault key, and issues a vault session: a 32-byte token in an HttpOnly host-only cookie; D1 stores its digest and the vault key re-wrapped under `HKDF(token, "symplist/vault-session/v1")`. The server can decrypt only while the client presents the token; nothing plaintext is persisted. Sessions expire after 5 minutes idle and on logout; reset revokes all.
- Items (secret or secure note) are encrypted under the vault key. Simon access uses per-item grants: on explicit approval the item value is re-encrypted into the grant under the account content key with the grant id in the AAD, bounded by expiry and task; tools receive a handle and the executor resolves it at call time without exposing the value to the model, chat or logs.
- Reset: fresh `vault_reset` OTP → single-use reset authorization bound to vault version → new passphrase wrapper committed with expected-version check → revoke vault sessions → notification email and redacted audit event.

## 12. Scheduling and notifications

Follow note 15 with [decision D3](decisions.md): deliveries at the top of the local hour.

- Records: `task_schedules` (version, deadline kind, date or instant, original local time, IANA zone), `reminders` (relative or absolute rule, channels, quiet-hours override, generation), `reminder_occurrences` (intended top-of-hour instant, status, lease owner/expiry, fencing token, attempts), `notification_outbox` (unique occurrence and channel, idempotency key, encrypted payload, provider id, delivery status), `notifications` (unique occurrence, read/dismissed), `notification_prefs` (timezone, default reminder hour, channels, quiet hours, email preview), `executor_state` (active scheduler executor and generation), `email_suppressions`.
- Time math uses `temporal-polyfill`: date-only deadlines keep `PlainDate` plus zone; timed deadlines keep instant, local time and zone; DST gaps and overlaps are detected and surfaced for a choice. Reminder times resolve to whole local hours, rounding down.
- Scanner: `DURABLE=true` runs a declarative Trigger schedule `0,30,45 * * * *` (UTC) that selects due occurrences in bounded batches and claims them with conditional leases; `DURABLE=false` runs the same scanner in the api on the same minutes. The executor generation in `executor_state` prevents both from sending. Delivery validates owner access, task still active, current generation, channel preference, quiet hours, lateness (24 hours) and lease immediately before sending. Stale work is a successful no-op.
- In-app notifications are persisted, then announced on the `user` topic by the api (the worker signals the api through the internal event endpoint). Email uses Resend with idempotency key `reminder/<occurrence>/email`; Resend webhooks update delivery status and suppressions.

## 13. Sharing and handoff

Follow note 16.

- `artifacts` (immutable encrypted Markdown snapshot in R2, source commit and sections), `share_grants` (mode `link`/`password`/`public`, token digest, public id, Argon2id password verifier, expiry, revoked/disabled reason, generation), `share_sessions`, `share_approvals`, `share_audit`.
- Share host routes on the api (`ARTIFACT_ORIGIN` host only): `GET /artifact/:id?key=`, `GET /artifact/:id/raw?key=`, `POST /artifact/:id/password`, `GET /artifact/:id/public/:publicationId` and `/raw`. Every request re-checks grant status, expiry, generation, owner access and artifact existence. Responses: server-rendered HTML with inline theme CSS and self-hosted fonts from the share host, no scripts, strict CSP, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, sanitized Markdown (no raw HTML, inert internal links). Unknown, expired and revoked share the same generic unavailable page.
- Release is always an explicit reviewed action through trusted UI; Simon's tools create drafts and snapshots and reference grants by id, never raw tokens or passwords.

## 14. Connections and incoming MCP

- Connections: the Composio catalogue is fetched live (`toolkits.list` with cursor pagination) and cached briefly in memory; auth configs are found or created with Composio-managed auth; connection links use the api callback `/v1/connections/callback`, confirmed by `connectedAccounts.get` with backoff. Composio user id equals the Symplist user id. No OAuth tokens are stored by Symplist.
- MCP server at `<API_ORIGIN>/mcp` using `@modelcontextprotocol/server` 2.0 stateless handler. Credentials: `sym_` bearer API keys (digest lookup, scopes, optional task scope, expiry) and OAuth 2.1 access tokens (JWT signed with `MCP_OAUTH_SIGNING_KEY`, audience and issuer equal to the MCP URL, 1-hour expiry, rotating refresh tokens). The api implements protected resource metadata, authorization server metadata, dynamic client registration, client id metadata documents (with SSRF guards), PKCE S256, authorize (redirects to the web consent page), token and revoke. Scopes `tasks:read`, `tasks:write`, `ai:run`. Every call re-checks access and ownership; relock blocks all calls.

## 15. Analytics and consent

- `packages/analytics` defines the event allowlist and property schemas from note 17 (plus `quick_chat_started`, `quick_chat_saved`). The client loads `posthog-js` dynamically only after consent is `granted`, with capture features disabled, `persistence: 'localStorage'`, identity from the random `analytics_id`, and a `before_send` scrubber. The server emitter checks stored consent before capturing. Excluded routes (auth, OTP, beta gate, Vault, OAuth consent, share host) never mount the client.
- Consent banner (decision D5) appears in the signed-in app until the user chooses; the choice is stored in preferences and mirrored in Settings → Account → Privacy. `ANALYTICS_ENABLED=false` or no key hides the banner and sends nothing.

## 16. Configuration and local development

- `packages/config` validates environment at startup with strict booleans and cross-field rules (production refuses local drivers, `BILLING_ENABLED`/`PAYWALL_ENABLED`/`AI_USAGE_LIMITS_ENABLED=true` are rejected, `DURABLE=true` requires Trigger settings, encryption secrets must decode to 32 bytes).
- Drivers: `DATA_DRIVER=d1|local` (D1 plus R2, or SQLite file plus filesystem under `.local-data/`), `EMAIL_DRIVER=resend|log` (log prints the message to the api console in development only). Development without credentials: `DATA_DRIVER=local`, `EMAIL_DRIVER=log`, `DURABLE=false`, AI unavailable unless `OPENAI_API_KEY` is set.
- Local URLs: web `http://localhost:3000`, api `http://localhost:4000`, share host `http://127.0.0.1:4000` (a different host so session cookies never reach it).
- `pnpm dev` runs web, api (with migrations) and, when `TRIGGER_SECRET_KEY` is present, `trigger dev`. `pnpm secrets:generate` prints fresh values for every generated secret.

## 17. Testing conventions

- Every package and feature ships tests in the same change. Vitest files sit beside code as `*.test.ts(x)`.
- Shared contract suites live in `packages/testing/src/contracts/` and run against every implementation: `DbClient` (local always, D1 when `LIVE_D1=1`), `ObjectStore` (local, R2 when `LIVE_R2=1`), `Executor` (local executor and a Trigger adapter driven through a fake Trigger client; live Trigger when `LIVE_TRIGGER=1`), email transport, Composio wrapper (fake client; live when `LIVE_COMPOSIO=1`), AI provider (scripted model; live when `LIVE_OPENAI=1`). Live suites are skipped with a visible reason when credentials are absent and are never counted as passing in that case.
- API tests boot Nest with the local drivers, the scripted model and fakes, and call it over real HTTP and WebSocket on an ephemeral port.
- Negative tests are required for cross-user access, relock bypass, replay and idempotency mismatch, stale revisions, unsafe tools, secret leakage in logs and responses, interrupted execution, and missing configuration.
- `apps/e2e` runs the api (local drivers, scripted model) and a production web build together, covering the flows in the [coverage ledger](coverage.md) at 1440, 1024 and 390 px, with axe checks and screenshots stored as evidence.
- Commands: `pnpm typecheck`, `pnpm lint` (Biome), `pnpm test`, `pnpm build`, `pnpm e2e`. A change is not done until these pass for the packages it touches.
