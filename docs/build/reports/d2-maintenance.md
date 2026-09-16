# D2 cross-feature maintenance integration

Branch `wip/d2-maintenance`, isolated sole-writer tree `symplist-wt/maintenance`, base `7915bc5`.

## Implemented

- Local API and durable worker hourly adapters invoke the same Vault/share cleanup. No new task or queue; worker helper remains under `infra`.
- Every Vault/share expiry and existing hourly retention mutation carries its executor mode/generation guard inside the deciding SQL statement. Aborted or stale passes refuse feature callbacks and search recovery.
- Migration 0604 adds an expand-only `cleanup_cursors` table. A five-minute conditional lease protects a persisted artifact owner/R2 cursor, so task process restarts do not keep revisiting the first page. One owner page and at most 100 keys per pass; every expiry table is independently bounded to 100 rows.
- The object collector excludes live references, young objects, foreign prefixes and malformed artifact keys. At most ten single-object deletes are in flight, with a fresh executor/lease check before each group. A stale or interrupted pass does not advance the cursor; a crash leaves a reclaimable lease.
- Logout/revocation/access loss announces the canonical content-free Vault lock event immediately before socket close. The frame is socket-targeted, including a pending snapshot, so logout of one login does not lock another login's Vault. Existing owner filters, denied-upgrade handling, identity-level behavior and close codes remain intact.

## Decisions

Append-only D2M.1 and D2M.2 record the durable cursor/lease, bounded cleanup and socket-targeted invalidation. The first full suite caught that a new `maintenance/` directory would violate the fixed core-domain inventory; the shared helper was moved to `packages/core/src/maintenance-fence.ts`. The existing structural test was retained unchanged.

R2 cannot atomically share a D1 generation transaction: a mode change after a delete group starts cannot recall its up-to-ten in-flight requests. The 24-hour orphan grace and ten-minute publication cutoff make those already-authorized deletions safe; the next group and cursor write are fenced. Cursor retention is operational metadata only, with no plaintext contents or secrets.

## Verification

- Frozen dependency installation passed.
- All 13 new shared-core cleanup contracts passed, including both executor labels, stale generations, SQL-write races, abort/lease expiry, restart cursors, concurrent lease contention, age/reference exclusion and the 100-key/100-row limits. A full 100-orphan page takes at most 20 underlying D1 batches.
- API adapter plus realtime contracts passed (32 tests); worker adapter and imported-queue declarations passed (6 tests). Existing realtime tests gained exact last-frame assertions; no assertions were removed or weakened.
- `pnpm lint`: 1,264 files, zero errors/warnings. `pnpm typecheck`: all 17 projects passed.
- `pnpm test`: full default-concurrency workspace suite and all 47 script tests passed. Core 539, API 450 (six existing credential-gated skips), worker 88, web 1,547; all remaining packages passed, with existing live D1/R2 skips unchanged.
- Production web build passed.
- Documentation link/44-brief check and `git diff --check` passed. No browser, live provider, credential or deployment actions were performed.

## Exported integration seams

`cleanupHourly` retains `cleanupFeatureExpiries(input, context)`, now with `CleanupContext {db, now, fence}`. `now` is a clock function, not a stale timestamp; `fence.current()` checks before external effects, and `fence.guard()` supplies trusted `{sql, params}` for the deciding SQL. The current adapters call `cleanupSharedFeatures(context, objects)` there. Root should compose its quick-chat expiry and incoming-MCP/connection-drain work alongside that call, keeping each bounded and generation-fenced. The existing Simon pause reconciler is preserved.

`cleanupVault(db, now, limit, guard?)` and `SharingMaintenance.sweep(now, guard?)` accept a trusted optional guard without breaking standalone callers. `SharingMaintenance.collectOwner(owner, now, cursor?, authorize?)` returns `interrupted: true` when authority/lease expires, so a caller must not advance that page. Documents maintenance remains the sole owner of document Git/job/orphan cleanup.

## Every touched file / overlap

- `packages/db/migrations/0604_cleanup_cursor.sql`.
- `packages/core/src/maintenance-fence.ts`.
- `packages/core/src/scheduling/{cleanup.ts,cleanup.test.ts,feature-cleanup.ts,index.ts}`.
- `packages/core/src/vault/maintenance.ts` and `packages/core/src/sharing/maintenance.ts`.
- `apps/api/src/modules/scheduling/{scheduling.module.ts,cleanup.api.test.ts}`.
- `apps/worker/src/infra/{scheduling-runtime.ts,scheduling-runtime.test.ts}`.
- `apps/api/src/modules/realtime/{topic-hub.ts,session-control.ts,access-sweep.ts,realtime.test.ts}`.
- `docs/build/decisions.md` (D2M append only) and this report.

No progress/coverage, frontend feature, Simon implementation, connection implementation, document maintenance, lockfile or secret file changes.

## Checkpoints and review

- `8b75925`: fenced shared cleanup, durable cursor migration, local/worker adapters and contracts.
- Final checkpoint adds socket-targeted lock-before-close ordering, strengthened realtime tests and this report.
- Reviewed all changed production code for owner isolation, stale executor/lease writes, transient object-store failures, ciphertext handling, D1 parameter/request bounds and late snapshot disclosure. Fixed the new helper's unsupported domain directory instead of changing its structural test. Added a post-D1 clock check so a lease expiring while validation awaits D1 cannot start another R2 delete group. The artifact collector never reads/decrypts object bodies.
