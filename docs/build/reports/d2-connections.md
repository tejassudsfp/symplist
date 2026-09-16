# D2 Connections and MCP stream

Status: **in progress; not ready to integrate as a finished feature**. Sole writer at
`symplist-wt/connections`, branch `wip/d2-connections`, original base `8e26f4f`.

## Implemented checkpoint

- Live connector catalogue pagination, auth-capability filtering, two-minute memory cache,
  repeated-cursor/page caps; no persistence dependency.
- Explicit SDK credentials; SDK telemetry/version checks/file transfers disabled. Both core and
  raw client content logging disabled and tested with the installed SDK.
- Safe provider error boundary; per-owner discovery, schema validation, explicit confirmed-account
  selection, generation/admission rechecks, read versus no-retry write execution, native-only
  manage-connections result. Identity selectors are removed recursively from model input.
- The resolved action keeps an independent server-owned copy, so changing the returned argument
  object cannot change what executes. Stored-approval preparation is an explicit separate entry.
- Migration 0901: connection generation, session/pin leases, connection attempts and auth-config
  leases. No existing migration changed. Restriction expires attempts; bounded purge removes new
  owner-scoped rows.
- Per-user Composio session repository: durable cross-process lease; trusted active pins only;
  update on generation changes; recreate only on upstream 404; refuse stale publication after
  admission/key/generation/lease changes.
- Metadata-only approval-edit validator with an injected pure policy: live schemas, exact owner,
  account and generation, fresh access checks, and previews with masked Vault handles. No model,
  session creation, tool execution or secret resolution. Primitive-schema Vault placeholders need
  the root/Vault integration adapter; currently they fail closed.
- OAuth client metadata foundation: DNS-vetted pinned HTTPS transport, no redirects, public-address
  checks, five-second deadline, 10 KB response cap, exact client identity and bounded memory cache;
  strict HTTPS redirects and loopback-only variable port matching. Not yet mounted as OAuth routes.
- Hosted-link provider adapter and toolkit auth-config find/create lease, including pagination past
  fifty records, managed/custom capability checks and no retry on creation. Native start/callback
  service binds an expiring nonce to user and login session, attests through `complete_auth`, checks
  exact account/toolkit/ACTIVE status, and encrypts aliases with row-specific AAD. A late relock,
  logout, shred or expiry refuses publication. Logout expires pending attempts in its batch.
- Folded connect/disconnect idempotency (hosted link is never replayable), version-bound reconnect,
  durable ids-only provider revocation, and set-based approval expiry/continuations in the deciding
  connection batch. Expiry has five statements regardless of approval count, tested with 100 pauses;
  it does not permanently block disconnect behind a small preflight limit. HTTP/event wiring remains.
- Connection HTTP routes now mount the live catalogue/list/start/callback/disconnect surface, with
  route classes, fresh admission for mutations, same-session callback, fixed redirects, CSRF and
  folded one-time-secret outcomes. Six real-HTTP tests cover those boundaries and scan every local
  D1/R2/log sink. Missing provider configuration does not prevent native read/disconnect authority.
- Signed raw-body Composio webhook uses the installed SDK verifier, native account mapping (never
  payload identity), receipt/effect/approval expiry in one batch, and deduplicated pin refresh.
  Forged, altered and stale requests fail before any database work without logging their bodies.
  Migration 0601 is a byte-identical, explicitly authorized dependency copied from merged Scheduling.
- Shared generation-fenced reconciliation, daily Trigger task on imported d1, matching local daily
  schedule, local hourly revocation retry, callback cleanup and ids-only worker announcements.
  Batches cap connection mutations at eight and provider revocation claims at twenty. Active pending
  callback attempts are protected until their bounded expiry. Provider purge removes all account
  statuses in bounded shrinking-page passes, then the known session, after crypto-shredding.
- MCP grants/API-key foundation: migration 0910, encrypted client names, 32-byte single-reveal
  credentials, fresh admission/session/selected-task guards inside mint/revoke transactions and replay,
  versioned timing-safe digest verification, bounded negative cache and last-used writes. The trusted
  UI routes `/v1/mcp/grants` list/mint/revoke; bearer MCP and OAuth exchanges are not mounted yet.
  Restriction revokes grants and expires OAuth rows atomically; logout expires same-session requests;
  purge removes owner rows in bounded dependency order.
- MCP JWT signer/verifier uses exact HS256/at+jwt/versioned kid, issuer, single audience, 15-minute
  lifetime and fresh grant claim binding. API keys receive the required synthetic sixty-second
  resource-server expiry. Twenty focused token tests pass; these helpers are not yet HTTP-mounted.

## Simon seam

`@symplist/integrations` exports `ConnectionTools(client, session, authority)` where authority is
`{ownerId, check():Promise<boolean>, connections():Promise<ExternalConnection[]>, schema(slug)}`.
It exposes `searchTools(query)`, `getToolSchemas(slugs)`, `resolveAction(input)`,
`prepareStoredAction(input)` for a trusted stored approval, `executeResolved(action,{sideEffect})`
and `manageConnections(toolkit?)`. The caller still owns deterministic approval policy, invocation
ledger and escaped untrusted-data presentation. `readExternalToolSchema(client,slug)` normalizes
installed SDK metadata. `ComposioSessions.use(ownerId)` in core owns session creation/pin updates.

The runtime authority adapter, approval validation integration and incoming MCP surface are **not
yet wired**. Never count these unit tests as a live Composio or executor-parity verification.

## Decisions

See append-only D2E.1–D2E.3: direct per-action execution for exact account selection; durable pin
leases/generation; silence provider-owned content logs. The provider's own retry machinery is never
used for a write. An ambiguous write is surfaced as uncertain, not silently resent.

## Verification so far

- Frozen install passed.
- Lint passed over 1,155 files, zero warnings/errors.
- All 17 project typechecks passed, including the SDK-log regression test.
- Integrations: 15 tests passed. Core: 416 tests passed, including 9 session security/race tests.
- Database: 164 passed; two existing credential-gated live checks skipped.
- Full repository tests passed (including core 416, integrations 15, API 391, web 1,484,
  worker 82 and 47 script tests; nine pre-existing live skips). Production web build passed.
- Docs link/screen check and diff whitespace check passed. No browser/e2e run attempted.
- Follow-up focused tests: approval validation 15 passed; CIMD/redirect security 41 passed. Core
  and API typechecks passed after the authorized Simon authorization-seam cherry-pick (7a09647).
- Next checkpoint: 58 selected core connection/session tests and all 18 integration tests pass;
  core/integrations typechecks pass. These services are not yet HTTP-mounted.
- Third checkpoint: 63 connection tests pass, database 164 pass / 2 credential-gated skips; full
  lint over 1,171 files has zero warnings/errors and all 17 project typechecks pass.
- HTTP checkpoint: lint 1,174 files and all typechecks pass. Full tests passed every package except
  a pre-D2 route-class probe that occupied the now-real callback route. Moved only that test probe to
  `connections/callback/guard-probe`, preserving its 200/401 guard assertions. Reran the entire API
  suite: 439 passed / 6 existing live skips, and all 47 script tests passed; docs check passed.
- Webhook checkpoint: eight connection/webhook HTTP tests passed; lint over 1,177 files has zero
  warnings/errors and all 17 project typechecks passed.
- Reconcile/purge checkpoint: 110 core connection/account tests and ten focused worker tests passed;
  all 17 typechecks and lint over 1,184 files pass. Full tests hit the known parallel-load Git timeout;
  unchanged rerun passed all packages (core 492, API 442 plus six live skips, worker 84, web 1,484,
  and 47 script tests). Updated the pre-D2 provider-purge test because a domain now really owns
  provider cleanup: the assertion now requires registered provider state to block premature success.
- Adversarial follow-up bounds provider revocation to five concurrent calls with a fresh executor
  check between groups and a ten-second no-retry transport deadline. A mode-switch test proves no
  new group starts and the retired executor cannot acknowledge already-deleted jobs.
- MCP grants checkpoint: ten core security tests and three real-HTTP tests pass, including full
  D1/R2/log secret scans for key minting. All 17 typechecks, lint over 1,192 files and full repository
  tests pass. OAuth claim-binding validation has an additional focused regression. The docs check
  needed the exact `d2-integration.md` report referenced by the root task-authorization cherry-pick;
  copied its tracked version from 7d0a77d and the docs check now passes.

## Adversarial findings fixed in this checkpoint

1. A caller could mutate a prepared action's nested arguments after schema validation. Keep a
   private structured clone, tested by mutating the public object before execution.
2. The SDK has two independent content-bearing loggers. Disabling telemetry alone did not disable
   either. Both are now silent, including raw no-retry clones.
3. An oversized response after a side effect cannot be called an ordinary validation failure;
   it is uncertain, preserving the no-resend contract.
4. A provider response after lease expiry or changed connection pins cannot publish its session;
   the new session is deleted and the caller retries the ordinary session acquisition explicitly.

## Remaining work

Connections UI is now owned by the separate `connections-ui` worktree. Incoming MCP OAuth/transport/
tools/client suites, complete runtime tool
authority, remaining secret scans, browser specs and whole-diff review. The root must wire
`connectionReconcilerFor(runtime)?.drain({mode:'durable',generation})` into merged cleanup-hourly;
the daily task already drains but hourly durable retry is not yet integrated here. Full feature gates
remain required. Root owns progress/coverage and combined E work.

## Files outside owned feature directories

- `packages/db/migrations/0901_connection_lifecycle.sql`
- `packages/db/migrations/0902_connection_revocation.sql`
- `packages/db/migrations/0910_mcp_grants.sql`
- `packages/db/migrations/0601_notification_provider_events.sql` (exact Scheduling dependency)
- `packages/core/src/access/restrict-contributors/connections.ts`
- `packages/core/src/account/purge-contributors/connections.ts`
- `packages/core/src/account/purge-contributors/types.ts` and `packages/core/src/account/purge-steps.test.ts`
- `apps/api/src/infra/account/account-purge.module.ts`
- `apps/worker/src/infra/account-purge.ts` and `apps/worker/src/trigger/account-purge.ts`
- `packages/core/src/access/session-revoke-contributors/connections.ts` and its registry
- `packages/core/src/access/session-revoke-contributors/mcp.ts`
- `packages/core/src/access/restrict-contributors/mcp.ts` and `packages/core/src/account/purge-contributors/mcp.ts`
- `packages/contracts/src/index.ts` (exports for the Connections-owned MCP contracts)
- `apps/api/src/common/guards/route-class.guard.test.ts` and
  `apps/api/test/probes/route-classes.probe.ts` (pre-D2 probe route collision, assertions preserved)
- `docs/build/decisions.md`
- This report.
- `docs/build/reports/d2-integration.md` (exact 7d0a77d documentation dependency, no content edits).

`packages/integrations/src/*` and `packages/core/src/connections/*` are owned by this stream.

### OAuth checkpoint

Core consent requests, encrypted labels/state, session-bound decisions, one-time code issuance,
PKCE exchange, 60-second expiry, refresh rotation/reuse revocation and 30-day absolute grants are
implemented. Public registration, authorize/login bridge, token/revoke and trusted consent HTTP
routes are mounted. Dynamic registration uses the existing five-per-hour IP bucket (503 and
Retry-After, per C6.7); CIMD uses the already-tested pinned-DNS loader. The UI agent owns the web
consent/bridge and settings surfaces against the committed contracts.

Verification: whole core suite passed (535 tests); 9 new real HTTP OAuth tests pass; the existing
route-class and parser probes pass after moving their collision-prone pre-D2 OAuth URLs to explicit
guard/body-probe suffixes. No assertions were removed. HTTP mint/decision tests scan D1, R2 and logs
for codes, state, access tokens, refresh tokens and full redirect URLs. Scope validation was moved
before single-use token consumption during review, preventing an invalid scope from burning a valid
credential. Incoming MCP transport/tools and their client contract suites remain unfinished.

Additional shared files: `apps/api/src/common/http/global-prefix.ts`, `apps/api/src/app.test.ts`,
`apps/api/test/probes/bootstrap.probe.ts`; all changes are OAuth routing or preservation of existing
guard/parser probes. No live suites or browsers were run.

### MCP transport checkpoint

The SDK v2 stateless transport, resource/authorization metadata, strict origin/host handling,
bearer challenge and failure throttling are mounted. Task, search, document and Simon message/run
tools use grant-scoped core services. Auto and legacy SDK clients exercise discovery and real
HTTP calls. Task create/move replay is encrypted and generation-fenced; move authorization covers
the complete affected subtree. Search suppresses out-of-scope parent metadata. Document reads
record grant-specific section receipts, and writes use the actual encrypted Git repository.
Simon admission only dispatches through the existing executor; MCP cannot approve, stop, retry
or answer app-owned questions. MCP cleanup is bounded and executor-generation fenced.

Checkpoint verification: all 17 projects typechecked; lint checked 1,215 files with no warnings;
9 focused core task/maintenance tests and 22 API transport/guard tests passed. Earlier search
tests also passed. Full final gates remain pending. Scheduling and artifact MCP extensions are
not wired yet: the next step is merging the root's committed services and testing those concrete
paths. The root's dirty Simon UI is deliberately excluded.

Additional shared files: `packages/core/src/search/{index,service,request-signal}.ts`,
`apps/api/src/modules/search/search.module.ts`. Search requests feed the existing coalesced index
coordinator, not another writer. `packages/core/src/search/sources/tasks.ts` is byte-identical to
the owner's committed 4d67768 AAD fix, copied as an explicit dependency. The pre-D2 `/mcp` guard
probe moved to `/mcp/guard-probe`; original security assertions remain intact.

Root integration: merged committed `4c49738` after checkpoint `71e975f`. Conflicting root-owned
Simon module/tests, progress, coverage, parallel plan and integration report retain the incoming
committed versions exactly; earlier copies were dependency snapshots, not Connections work.
All 35 conflicting evidence PNGs likewise retain the root's newer captures (no browser run here).
The guard-test conflict combines OAuth's `/oauth/token/guard-probe` with Sharing's
`/artifact/_probe/abc`. Task service and Simon core auto-merges match the root byte-for-byte,
including authorization and quick-create attachment seams; the root AAD dependency also matches.
All 17 project typechecks pass after resolution. Root dirty files were not read or copied.
