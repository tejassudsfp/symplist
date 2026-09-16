# D2 Scheduling and Resend stream — handoff

Worktree: `symplist-wt/scheduling`, branch `wip/d2-scheduling`. Sole writer. Implementation is checkpointed in logical commits; cross-stream wiring and Phase E browser/live verification belong to the integrator.

## Implementation

- Expand-only migrations 0600–0603: versioned schedules, reminders, leased occurrences, encrypted notification/outbox content, preferences, suppression, encrypted audit/response and content-free provider correlation; nullable retry-response and quiet-window-start additions.
- Temporal date-only/timed deadlines, standalone/relative reminders, explicit DST disambiguation, local-hour rounding and quiet-hours preview.
- Shared local/Trigger scanner, fenced claims, send-time access/task/generation/preferences/suppression validation, stable provider idempotency, encrypted immutable payloads, late/missed notification collapse and quiet-window summaries.
- API schedule/preview/summary/calendar/preferences/notification/snooze routes with app CSRF/access and folded idempotency. Resend raw-body verified webhook and narrow POST-only reminder unsubscribe.
- Imported-queue `reminder-scan` at `0,15,30 * * * *` and `cleanup-hourly` at `5 * * * *`; no child reminder jobs. Cleanup calls SimonPauseReconciler and search stale-intent requeue, and exposes `cleanupFeatureExpiries` for the integrator's Vault/quick-chat wiring.
- Archive/restriction/purge contributor implementations. No schedule restore revives cancelled occurrences.
- Deadline editor with explicit previews, standalone and relative reminders, DST choices including resolved offsets, timezone, quiet override, cancellation and conflict recovery. Existing deadline-chip seam and task menus are wired; no parallel task surface.
- Notification center with unread sync, quiet/missed states, pagination, read/dismiss/complete/open/snooze actions, loading/error/offline/reconnect states and mobile layout. Settings include saved timezone, first-use detection, delivery preview, privacy preview, server-disabled and tracked suppressed-address states.
- Month/week/agenda calendar, mobile agenda default, date navigation, active/completed/collection/unscheduled filters, all-day and point deadlines, roving date focus and keyboard/drag date editing through the same schedule editor.
- A stable authenticated `/tasks/:id` resolver now follows the current collection/archive route. Reminder links remain valid after moves; unavailable/foreign tasks reveal no content.
- Native `task_schedule` contract/implementation and authoritative deadline search contributor. Incoming tool calls require trusted owner/task scope plus SQL guards at the actual write and replay boundary.
- Optional API-side delivery reconciliation runs only when the webhook secret is configured. The worker does not receive or infer that API-only secret.

## Decisions

Appended D2C.1–D2C.8 to the append-only ledger. Migration allocation follows architecture 06xx, not the colliding suggested 0350 range. First-use timezone detection happens on the first admitted workspace after onboarding, guarded by preference version zero; later travel never rewrites it.

## Verification

- Frozen dependency installation passed in this isolated worktree.
- Full lint passed on 1,181 files, zero errors/warnings. Full 17-project typecheck passed, including authored E2E contracts.
- All unit/integration suites and 47 script tests passed with `pnpm --workspace-concurrency=1 -r test && pnpm test:scripts`. Web: 96 files / 1,512 tests. Core: 37 / 413. API: 37 / 393 (six existing credential-dependent live cases skipped). Worker: 18 / 87. All other packages passed; existing D1/R2 live cases remain credential-gated in this isolated worktree.
- Default-concurrency `pnpm test` was rerun repeatedly. It exposed and led to fixing the real worker-helper classification and pre-D2 realtime fixture collision. It also intermittently hit the unchanged Git-history test's 5-second contention timeout; that test passes in serial-workspace runs. No timeout was raised and no assertion weakened.
- Temporal tests cover every IANA timezone over each UTC hour of 2026. Both executor labels use the same scanner fixtures. New Resend HTTP tests exercise all six event types through the real SDK signature verifier, duplicate/stale/tampered/unlisted input and no-body logging.
- The 50-task scanner budget regression persists all 50 notifications with at most ten underlying D1 batches and one owner hint; provider concurrency is bounded to five. This is a feature budget regression, not a substitute for Phase E's combined ten-Simon-plus-fifty-reminder live load test.
- `pnpm build && pnpm build:web:clean` passed: both production builds and a clean web rebuild from source, including the new stable task route.
- Two real-API Playwright journeys are authored in `apps/e2e/tests/scheduling.spec.ts` (task → deadline → calendar → clear, and notifications → persisted settings). They were deliberately not run: the integrator reserved all browser/server runs for the merged pass.
- Documentation links/44-screen brief check and `git diff --check` passed.

## Adversarial review fixes

1. Mixed-channel opt-out could revive email after re-enable. Disabled channels are now removed from pending definitions under the preference guard; affected schedule versions advance.
2. Operation-style add/cancel/snooze retries could plan against their own previous mutation. Encrypted immutable fingerprints and responses replay before re-planning, with current authorization.
3. A renderer yielding past lease expiry could still use the claim's old clock. Materialization now refreshes the lease timestamp after rendering, and tests prove expired claims cannot publish.
4. Same-hour overdue occurrences could produce the wrong missed count. Equal-time tie breaking and already-counted exclusion now collapse correctly without duplicate email.
5. Quiet-hour preferences could change before send. Delivery rechecks current preferences, defers to the new permitted hour, and fences preference versions. The actual DST-aware summary window is persisted for API recount.
6. Serial per-occurrence DB calls and repeated owner announcements were replaced by bounded scan-scoped batching/coalescing. Deadline caches prune unmounted ids and serialize 50-id reconnect batches.
7. Calendar pagination could append an old range after navigation; request epochs now reject stale pages. The calendar has a real roving tab stop, day activation, keyboard arrows and boundary focus restoration.
8. Editing while Save/Preview was pending could discard new input. Dialog/settings fields lock for the request, preserving drafts and retry keys after failure.
9. Stable reminder task links pointed at a route that did not exist. Added the authenticated current-location resolver and tests for every collection/archive/denied read.
10. Unsubscribe masked infrastructure failures as invalid-token 404s. Only invalid capabilities become 404; transient database failures remain retryable platform errors.
11. Parallel schedule preflight could allocate an account key even if a sibling authorization read failed before the zeroization scope. Key acquisition now follows successful preflight. Custom relative offsets from tools also retain their actual minutes/days labels in the editor rather than masquerading as the one-hour/previous-day presets.

## Exact integration seams / remaining cross-stream work

- `@symplist/core/scheduling`: `taskScheduleTool(service, actor, input)`. Actor is `{kind:'simon'|'mcp', ownerId, requestId, taskIds: readonly string[] | null, scopes: readonly string[], guards: readonly {sql:string, params:Readonly<Record<string,string>>}[]}`. Guards are mandatory and must be built from authenticated run/grant state; callers must never expose them to model/client input. Mutations take `expectedVersion`. Scope names are `tasks:read` / `tasks:write`.
- `cleanupHourly(options, execution)` already calls `SimonPauseReconciler.run({executor,generation})`. Wire `options.cleanupFeatureExpiries` to merged Vault `cleanupVault`, Simon quick-chat expiry and incoming-MCP unused OAuth-client expiry. The API local registration is `SchedulingLifecycle` in `scheduling.module.ts`; durable wiring is `apps/worker/src/infra/scheduling-runtime.ts`. Existing `documents-maintenance` already owns Git/R2 orphan/job sweeps and is intentionally not duplicated.
- Analytics merge must emit allowlisted `reminder_created` after confirmed new-reminder saves/snoozes, with consent and stable event dedupe. Emit channel enums only; no task/reminder ids as properties. A replay or first-use timezone save must not produce a new event.
- Parent retains Phase E: run authored E2E, all-theme/viewport visual evidence, live provider suites, final default-concurrency gate and combined D1 load. This branch neither applied live migrations nor sent real reminder email.

## Every outside-feature file / overlap

- `packages/db/migrations/0600_scheduling.sql`, `0601_notification_provider_events.sql`, `0602_schedule_retry_response.sql`, `0603_quiet_summary_window.sql`.
- `packages/core/src/access/restrict-contributors/scheduling.ts`, `account/purge-contributors/scheduling.ts`, `tasks/archive-contributors/scheduling.ts`, `search/sources/contributors/scheduling.ts`.
- `packages/email/package.json` (type-only transport export), `apps/worker/tsconfig.json` (JSX for existing email renderer), `apps/worker/src/infra/scheduling-runtime.ts` (runtime adapter), `apps/web/package.json` and `pnpm-lock.yaml` (existing pinned Temporal 1.0.5 added to the browser).
- `apps/web/src/components/shell/feature-slots.tsx` (keyed SchedulingProvider; preserve other streams' slot changes), `apps/web/src/app/globals.css` (one appended Scheduling block only).
- `apps/web/src/app/(app)/calendar/page.tsx`, `settings/notifications/page.tsx`, `tasks/[taskId]/page.tsx`, and `layout.test.tsx` (real notification control replaces the old empty seam assertion).
- `apps/web/src/features/workspace/task-deep-link.tsx` and `.test.tsx`; `apps/e2e/tests/scheduling.spec.ts`.
- `apps/api/src/modules/realtime/realtime.test.ts`: only the synthetic contributor name changed to `test-private-unread`, preserving its denied-account assertions now that real scheduling owns its name.
- Append-only `docs/build/decisions.md` and this report. Root baseline fix b7e805b was cherry-picked as 768257e (`apps/api/src/modules/internal/internal.test.ts`, `apps/api/test/platform.test.ts`, root progress note); those were not independently changed.

## Commit checkpoints

- `2399aab`: versioned schedules and fenced reminder delivery.
- `3e98dca`: calendar, editor, settings and notification UI; explicit pre-D2 placeholder-test update.
- `29a3f6c`: retry/delivery review fixes, native tool/search seams, API/worker contracts; explicit pre-D2 realtime-fixture update.
- `ad50ae6`: stable task links, first-use timezone detection and authored browser journeys.
- `a2ed114`: preserve retryable unsubscribe failures.
- `c4c2833`: keep preflight keys within their ownership scope and show custom relative offsets accurately; 26 focused core and 23 scheduling UI regressions passed afterward.
