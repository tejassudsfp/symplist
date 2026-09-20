# D2 Connections and MCP stream

Status: **backend ready for root integration; local review complete, combined/live gates remain**. Sole writer at
`symplist-wt/connections`, branch `wip/d2-connections`, original base `8e26f4f`.

## Final backend review — September 20

This section supersedes the historical September 16 checkpoint below. Connections UI remains a
separate stream. This is backend integration readiness, not a claim that D2 or E is finished.

Commit `fb35529` fixes a confirmation race: the existing 500-connection bound is now checked in
the deciding INSERT, not just before the provider callback. A regression fills the capacity after
an attempt starts and proves confirmation cannot overflow inventory, the inventory remains readable,
and the unconfirmed provider account is revoked. The same commit gives the analytics test double
its actual callback type, fixing the final checkpoint's inferred zero-argument tuple type error
without removing assertions. No dependencies, timeouts or test expectations were weakened.

The resumed whole-diff adversarial review covered callback/session ownership, generation/lease
fencing, disconnect approval expiry, raw webhook receipt/effect atomicity, provider error/secret
boundaries, OAuth code/refresh reuse and JWT claims, pinned metadata fetching/SSRF, grant scope in
deciding writes and replay, post-I/O authorization, retrieval budgets, bounded D1 batches, and
single-reveal secret scans. The capacity race above was the additional defect found and fixed.
The earlier corrections documented below remain intact. No TODO/FIXME or biome-ignore additions
remain in owned production areas; root-owned UI is not represented as reviewed by this stream.

### Verification and coverage

- Original Git-history suite: **14/14 passed** without changing its timeout; the prior timeout did
  not reproduce.
- All **17 project typechecks passed**. Whole core **733/733**, integrations **19/19**, worker
  **97/97**, agent **78/78**, and pure API metadata/SSRF plus JWT tests **61/61** passed.
  Contracts **164** and config **276** also passed before the recursive run reached blocked tests.
- Lint checked **1,357 files**, zero errors and warnings. Production TypeScript build
  `node_modules/.bin/tsc -b tsconfig.build.json`, docs links/44-screen check, and whitespace check
  passed.
- Full recursive tests could not finish: storage R2 test servers and script loopback/websocket
  probes fail with **`listen EPERM 127.0.0.1`** in the restricted environment. The blocked script
  run was interrupted; no listeners or dev servers were started successfully.
- Web tests: **1,557/1,558 passed**. The one failure is the root-owned archive test at
  `apps/web/src/features/workspace/archive-view.test.tsx:67`: its September 16 fixture expects
  “Today” on September 20. Production correctly renders “Wednesday, September 16, 2026”. Root was
  notified to freeze the fixture clock; this stream did not change web tests.
- Next's production build stalled at “Creating an optimized production build ...” and was
  interrupted (exit 130); no more specific cause was established. Smoke then lacked
  `.next/BUILD_ID`. Clean web build/deploy checker, browser/executor parity and live suites remain
  root gates, not passes claimed here. The last unrestricted September 16 results below are
  historical evidence only.
- Exact pnpm 12.4.2 frozen install was not repeated: the available shim runs pnpm 11.1.2 and its
  bootstrap needs unavailable network access. Local gates used existing binaries or
  `COREPACK_ROOT=1 pnpm --pm-on-fail=ignore` as a script orchestrator. The shim's accidental lockfile
  bootstrap edits were removed; no lockfile/dependency changes remain.

### Root-only integration work

1. Wire owner/run-scoped Composio authority, `ConnectionTools`, and the metadata-only approval
   validator into Simon. The primitive-schema Vault-handle masking/schema adapter remains a
   fail-closed integration seam; API code must never resolve Vault contents or execute a tool.
2. In maintenance-owned `apps/worker/src/infra/scheduling-runtime.ts`, call
   `cleanupMcp({db,now,mode:'durable',generation})` and
   `connectionReconcilerFor(runtime)?.drain({mode:'durable',generation})` under the hourly fence.
   Local hourly cleanup and daily durable reconciliation are already wired.
3. Merge backend, then Connections UI, preserving newer root TaskAuthorization/Simon fixes rather
   than restoring this branch's older `4c49738` dependency snapshot. Freeze the archive fixture
   clock and run combined exact-tooling, browser, executor-parity, visual and live gates.
4. Verify the live Composio project's callback identity configuration during E. This branch used
   no live credentials and performed no live provider mutations.

All specified MCP backend tools, including concrete scheduling and artifact services, are wired;
the remaining items above are explicit root-owned integration or environment validation, not
unimplemented backend tool stubs.

### Commit and shared-file inventory

First-parent stream commits through the final source fix (the report-only completion commit
follows this list):

```text
b801b9e Build safe Composio execution and fenced session persistence
7a09647 Build Simon question commands and scoped authorization seam
bc340a5 Validate approval edits and pin OAuth metadata fetches
5e0d663 Bind hosted connection callbacks to the initiating session
7e77300 Fence reconnect and disconnect with atomic approval expiry
a5d21b2 Wire connection HTTP routes and update the pre-D2 callback probe
f06b438 Verify Composio webhook receipts with atomic connection expiry
df96c3d Reconcile connections and implement provider purge, updating pre-D2 purge expectations
6f6d821 Fence task tool writes and replay with trusted runtime authority
131818d Add scoped MCP grants and single-reveal API key management
29fd1ec Pin MCP JWT validation to issuer audience and live grants
1322884 Define the trusted OAuth consent UI contract
182216c Build session-bound OAuth consent and single-use token exchange; move pre-D2 route probes
71e975f Build grant-scoped MCP transport and tools; preserve pre-D2 guard probes
5e82a14 Merge integrated D2 services for concrete MCP tool wiring
ed5abf3 Checkpoint concrete MCP integrations; focused tests pass, final gates unverified
fb35529 Fence connection capacity at confirmation and type analytics test callbacks
```

`7a09647` and `6f6d821` are parent-owned seam cherry-picks. `5e82a14` merged only committed root
`4c49738`, not dirty files. Every shared path outside the owned Connections/MCP, contracts
Connections, integrations and worker Connections feature directories in the feature delta against
that root snapshot is listed here:

```text
apps/api/src/app.test.ts
apps/api/src/common/guards/route-class.guard.test.ts
apps/api/src/common/http/global-prefix.ts
apps/api/src/infra/account/account-purge.module.ts
apps/api/src/modules/search/search.module.ts
apps/api/test/probes/bootstrap.probe.ts
apps/api/test/probes/route-classes.probe.ts
apps/worker/src/infra/account-purge.ts
apps/worker/src/trigger/account-purge.ts
docs/build/decisions.md
docs/build/reports/d2-connections.md
packages/contracts/src/index.ts
packages/core/src/access/restrict-contributors/connections.ts
packages/core/src/access/restrict-contributors/mcp.ts
packages/core/src/access/session-revoke-contributors/connections.ts
packages/core/src/access/session-revoke-contributors/index.ts
packages/core/src/access/session-revoke-contributors/mcp.ts
packages/core/src/account/purge-contributors/connections.ts
packages/core/src/account/purge-contributors/mcp.ts
packages/core/src/account/purge-contributors/types.ts
packages/core/src/account/purge-steps.test.ts
packages/core/src/documents/budgets.test.ts
packages/core/src/documents/budgets.ts
packages/core/src/search/index.ts
packages/core/src/search/request-signal.test.ts
packages/core/src/search/request-signal.ts
packages/core/src/search/service.ts
packages/db/migrations/0901_connection_lifecycle.sql
packages/db/migrations/0902_connection_revocation.sql
packages/db/migrations/0910_mcp_grants.sql
```

Historical dependency copies include the byte-identical Scheduling 0601 receipt migration and
root search-source AAD fix; both already match the merged root snapshot. Merge-only resolutions
retained root progress/coverage/parallel/integration reports, Simon files, and visual evidence;
they are not Connections feature edits. Earlier per-checkpoint inventories below retain details
of these shared dependency touches.

## Resume here — September 16 checkpoint

The historical checkpoints below were superseded by this September 16 section. Root committed `4c49738` was
merged at `5e82a14`; no later root commits or dirty files were copied. Connections UI is separately
owned by `/root/d2_vault` in `connections-ui` and must merge after this backend.

Completed since the transport checkpoint: all four concrete MCP extensions (`task_schedule`,
`artifact_snapshot`, `artifact_share_list`, `artifact_share_revoke`) use the actual merged core
services. Revoke folds encrypted idempotency and fresh authority into the deciding batch; retries
produce one audit row. Mutations require request IDs and active-task predicates. Both SDK auto
and legacy clients now also complete real HTTP PKCE consent/exchange, use the resulting JWT,
and stop after refresh revocation. Task create/move emits server analytics only after an applied
write, never on replay; analytics failure cannot fail the task or expose its analytics identifier.

Review corrections: post-I/O document authorization prevents content returning after revocation;
getter-backed actor predicates refresh expiry at publication; concurrent document retrievals cannot
overdraw a grant budget; OAuth unknown-id caching cannot be poisoned by a wrong claim on a valid
grant; OAuth last-used timestamps use the same ten-minute cadence as keys; scoped search masks
ungranted parent metadata; account-selection errors now include native `{id,toolkit}` choices;
Retry-After accepts HTTP dates as well as seconds. Earlier OAuth scope-before-consume and key/code/
refresh/redirect/provider-link sink scans remain covered. The whole-diff final review is not yet
complete; this is not a claim that D2 or E is finished.

Actual latest verification:

- Frozen install passed, no dependency changes.
- All 17 typechecks and zero-warning lint (1,357 files) passed before the final small analytics
  callback/schema change. API typecheck passed again after that change.
- Last focused run: MCP HTTP 12 passed; core MCP task tools 8 passed. Other review tests: core
  grants 11 passed, shared budget/search signal tests passed, integrations 19 passed.
- One complete repository test run passed (core 729, API 568 with six credential-gated skips,
  web 1,558, worker 97, all other packages and 47 script tests).
- The subsequent full rerun passed web 1,558 and core 730 but timed out in
  `packages/core/src/documents/service.test.ts:349`, “pages history with the head pinned while new
  revisions arrive”, at the existing 5,000 ms limit. It stopped downstream packages. No assertion
  or timeout was changed. Rerun this before diagnosis; the owner requested an immediate checkpoint
  before that rerun could happen.
- Production build and `build:web:clean` passed before the final small analytics callback/schema
  change. Docs link/44-screen check passed. Latest full build/typecheck/lint/test refresh remains.
- No browser/e2e or live suites were run; root owns those. No live credentials copied or used.

Exact remaining integration/resume work:

1. Rerun the Git-history timeout, then all final gates (including full tests/builds, smoke/deploy
   check). Finish the final adversarial diff review. Do not weaken tests.
2. Root wires the exported Composio authority/runtime and metadata-only approval factory into
   Simon. `createApprovalEditValidator` still fails closed on primitive-schema Vault placeholders;
   the root/Vault masking/schema adapter is still needed. Surface safe account-selection choices.
3. Root adds durable hourly hooks in maintenance-owned `apps/worker/src/infra/scheduling-runtime.ts`:
   `cleanupMcp({db,now,mode:'durable',generation})` and
   `connectionReconcilerFor(runtime)?.drain({mode:'durable',generation})` under its fence. Local
   hourly jobs and daily durable reconciliation are already wired.
4. Root merges backend then Connections UI, reconciles newer root task/Simon review commits,
   runs combined real-browser/executor-parity/live suites and visual evidence. Do not replace
   newer root files with the older `4c49738` dependency snapshot in this branch.

Additional shared files in the final checkpoint: `packages/core/src/documents/budgets.ts` and
new `budgets.test.ts` (concurrent-grant regression); `packages/core/src/search/request-signal.test.ts`.
No active commands remain at checkpoint; no dev server was started.

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
