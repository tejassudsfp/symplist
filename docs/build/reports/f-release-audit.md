# Phase F release audit

Date: 2026-09-20  
Branch: `feat/symplist-build`

## Verdict

The D2/E release candidate passed the independent backend, frontend, privacy/cost, self-hosting and
integrated-diff reviews. Every defect below was fixed and covered before the final gate. No test was
deleted, weakened or skipped to obtain green, and no lint suppression was added.

The repository-side Phase G work is also complete: production deployment configuration, migration
CI, runnable self-hosting/operations documentation, brand assets, README and About screen exist.
Merging to `main`, configuring production provider controls and running the deployed durable smoke
remain owner-controlled release actions.

## Defects found and fixed

- React Strict Mode could remount a memoized provider around a permanently disposed store. Stores
  now reopen on effect entry, fence abandoned work and reset loading states that have no request in
  flight; real-provider lifecycle tests cover the replay.
- The isolated artifact viewer's no-referrer navigation legitimately sent `Origin: null`. Password
  submission now admits that value only with independent same-origin Fetch Metadata and the existing
  one-time form nonce; missing/cross-site witnesses remain forbidden.
- Simon's responsive document navigation, analytics consent timing, scheduling concurrency
  assertions and executor/search recovery states had integration gaps. The current component,
  service and browser contracts exercise the corrected paths.
- Quick Chat expiry, share expiry and owner-reviewed handoff release lacked browser proof. Their real
  API journeys now run at 1440, 1024 and 390 pixels.
- Simon had no hard model-output ceiling or byte-bound prompt history. The shared loop now requests
  at most 4,096 output tokens per step and 8,192 per run, retains at most the newest 40 messages and
  64 KiB while preserving the current turn, and bounds provider-controlled connector output to
  96 KiB. Ten steps, one tool call per step and zero model retries remain enforced.
- Prompt-cache usage was invisible. GPT-5.6 now explicitly selects implicit 30-minute prefix
  caching; content-free cache read/write token counts are persisted, and a credential-gated live
  contract proves an actual cache read. Symplist intentionally does not memoize responses or use
  `previous_response_id`, because every turn must recheck authorization, revisions and tools.
- The AI SDK's default error callback could expose request input in diagnostics. Production uses an
  explicit stable-code-only callback and the provider contract guards it.
- History-floor and numeric-bind edge cases could advance context incorrectly or pass unsupported
  numeric values to SQLite. They now use the actual retained floor once and normalized integer
  bindings, with adversarial maximum-history coverage.
- A client-network-only Simon burst key made unrelated authenticated users behind one NAT consume
  one another's budget. The before-D1 limiter now adds a one-way session digest without retaining
  the bearer token; unauthenticated traffic still falls back to the network key.

## Security and architecture recheck

The final pass re-read the integrated paths for client-trusted authorization, CSRF/origin handling,
encrypted field/object boundaries and frozen AAD, plaintext in logs/analytics/Trigger sinks,
idempotency folding, executor generation fences, side-effect uncertainty, unbounded D1 loops,
keyboard reachability and empty/loading/error states. Executable evidence includes:

- marker-string contracts over every Trigger-hosted payload/output/metadata/tag sink;
- local/Trigger parity for chat, native tools, documents, Sharing, Connections and Vault grants;
- locked-account, wrong-executor, duplicate-message, stop/approval, disconnect/replay,
  side-effect-restart and environment-mode-switch tests;
- one-time-secret scans over issuing endpoints, stored rows/objects and logs;
- the combined D1 request-budget/circuit-breaker contract;
- WCAG 2.2 AA automation and focus restoration at all three viewports, plus the inspected 36-frame
  theme/mode/viewport matrix.

## Final verification

- `pnpm install --frozen-lockfile`: passed across 18 workspaces.
- `pnpm lint`: 1,453 files, zero errors and zero warnings.
- `pnpm typecheck`: all 17 projects passed.
- `pnpm test`: 4,767 Vitest tests and 61 script tests passed; 22 credential/target-specific tests
  intentionally skipped.
- `pnpm build && pnpm build:web:clean`: passed; the web build emitted 39 routes.
- `pnpm e2e`: 212 passed and 16 intentional viewport/target skips.
- `pnpm smoke:local`: passed.
- `node scripts/check-api-deploy.mjs`: passed over 12 workspace packages, 13 dist directories and
  all 46 migrations.
- `python3 scripts/check_docs.py`: passed all 44 screen briefs.
- `pnpm env:check`: passed 82 API, 55 worker and five web assignments, with mode-600 ignored files.
- Live bounded contracts: D1 15/15; R2 10/10; Trigger 15 passed with three intentional control
  skips; OpenAI 13/13 including a cache read; Composio seven passed with five intentional target
  capability skips; PostHog 1/1. No private product content was used.
- Live D1 migrator: `applied: 0`, `alreadyApplied: 46`, `outOfOrder: 0`.

A live Resend delivery/webhook is not claimed; the optional-secret 404 behavior, signature failure,
receipt deduplication, six allowed events and permanent-bounce/complaint suppression rules pass
locally.

## Owner release boundary

Before admitting users, the owner must merge the reviewed feature branch, configure production
domains and secrets, set an enforced hard spend limit and alerts in the dedicated model-provider
project, confirm backups/recovery material, and run the guide's post-deploy API/artifact/MCP and
durable Simon smoke. Those steps mutate external production state and are not hidden as code work.
