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

Connection/auth-config lifecycle, callback identity verification, same-batch webhook dedupe and
approval expiry, generation-fenced reconcile/local scheduler/provider purge, full HTTP and UI,
incoming MCP grants/API keys/OAuth/CIMD/tools/client suites, secret scans, browser specs and whole
diff review. Full feature gates remain required. Root owns progress/coverage and combined E work.

## Files outside owned feature directories

- `packages/db/migrations/0901_connection_lifecycle.sql`
- `packages/db/migrations/0902_connection_revocation.sql`
- `packages/core/src/access/restrict-contributors/connections.ts`
- `packages/core/src/account/purge-contributors/connections.ts`
- `packages/core/src/access/session-revoke-contributors/connections.ts` and its registry
- `apps/api/src/common/guards/route-class.guard.test.ts` and
  `apps/api/test/probes/route-classes.probe.ts` (pre-D2 probe route collision, assertions preserved)
- `docs/build/decisions.md`
- This report.

`packages/integrations/src/*` and `packages/core/src/connections/*` are owned by this stream.
