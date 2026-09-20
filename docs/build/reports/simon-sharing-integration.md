# Simon Sharing and handoff integration

Supersedes the unfinished-code status in `simon-sharing-checkpoint.md`; its checkpoint history remains intact.

## Implementation

- Both executor factories register the same five native tools, using the existing claimed SimonDocumentSession and refreshed actor predicates. Quick chat exposes only artifact_share_list; direct core mutation attempts remain forbidden.
- Snapshots, handoff drafts and share proposals reuse the encrypted Sharing repository and existing immutable artifact surface. The model sees ids, enums, counts and saved revision references, not content, titles, passwords, publication ids or raw share URLs. Proposal creation never calls release.
- Revocation uses exact-argument encrypted folded receipts, fresh authority inside the deciding batch, a safe integer retained-run sentinel and scoped quick-history cleanup. Replay never repeats audit/effects; changed arguments fail without touching the other grant.
- Worker share_grant.changed events are reloaded against canonical artifact owner/access before publication. The supplied task id and unexpected hint contents are ignored.
- Local and worker handoff analytics use AnalyticsService, preserving current consent/access checks and random private analytics identity. The worker emitter is immediate/bounded and cached once per runtime, with stable-code-only logging.

## Review and tests

- Corrected the checkpoint's unexecuted test import and fixture schema mistakes; no existing test was weakened.
- Core: 22 new Sharing cases plus existing actor freshness/review regressions: **64 passed**. Coverage includes both modes, snapshot/proposal exact replay and argument mismatch, revoke mismatch, cancellation immediately before first-write/replay batch, generation/mode/relock rejection, cross-owner and cross-task rules, quick expiry and native-scope deletion without deleting HTTP receipts.
- Agent: **4 model-loop parity tests passed**, running real core services, encrypted checkpoints and all five tools under local/Trigger task chat; quick mode exposes only listing. Cross-owner listing is rejected, no raw public capability enters model history, no Git child runs occur, and handoff/grant callbacks fire exactly once.
- Worker: analytics consent/access/immediate-delivery test and durable factory registration test pass; existing task-registration and marker-leak tests pass.
- All **17 project typechecks passed**, including the newly added test imports; worker typecheck was rerun after its final registration test.
- Full lint: zero errors/warnings (1296 files at that run; rerun with final report changes pending).
- API event integration test is present and unchanged, but this sandbox rejects `bootTestApp`'s `listen(0)` with EPERM before assertions. It must run in root's socket-enabled gate environment. No sockets were bypassed or tests skipped to manufacture green.
- Broader non-API suite and final gates are being run; final results will be appended below. No live/browser/environment/migration changes.

## Decisions

See append-only decision D2M4. A worker-only blank artifact origin is an intentionally unusable release URL base; this seam never invokes release, and tests verify proposal-only behavior. Existing handoff templates retain artifact placeholders for owner review rather than embedding live URLs.

## Changed paths outside new Sharing feature files

Relative to checkpoint e61264b:

- `apps/api/src/modules/simon/simon.local.ts`
- `apps/api/src/modules/simon/simon.module.ts`
- `apps/worker/src/trigger/simon/simon-run.ts`
- `apps/worker/src/infra/analytics.ts`
- `apps/worker/src/infra/analytics.test.ts`
- `apps/worker/src/infra/simon-sharing-registration.test.ts`
- `packages/agent/src/sharing.test.ts`
- `packages/core/src/simon/sharing.test.ts`
- `apps/api/src/modules/sharing/sharing.events.test.ts`
- `docs/build/decisions.md`
- This report.

The earlier checkpoint report inventories the original production wiring, exports, optional agent context and quick-delete overlap. No root checkout, UI, contracts, views, progress or coverage edits.

## Final verification and handoff

- Full core suite: **52 files / 645 tests passed**. Full agent suite: **9 files / 88 tests passed**. Full worker suite: **24 files / 97 tests passed**. Initial overlapping core/worker/build runs exceeded a 5-second test timeout; isolated full-suite reruns passed without any timeout/assertion changes.
- Added `apps/api/src/modules/sharing/sharing.events.unit.test.ts`: **1 passed**, exercising the production registry/handler with real migrated SQLite, encrypted artifact creation and ownership checks. Canonical ids are published; foreign/missing/deleted/relocked records and malformed hints do not publish. This supplements, not replaces, the retained HTTP integration test.
- All **17 project typechecks passed** after the provider fix; API typecheck was rerun after the final relay test. Final lint: **1298 files, zero errors and warnings**. Docs checker passed; staged whitespace checks passed.
- Sandbox limits: API `listen(0)` and the existing R2 emulator cannot bind (EPERM). The broader recursive suite stopped on the emulator; no tests were weakened or marked skipped. The scripts suite also encountered loopback permission failures and was interrupted while websocket-upgrade.test.mjs was running. The normal web build remained at its optimization stage without completion and was explicitly interrupted, so no successful build is claimed here.
- Web unit suite: 1557 passed and one pre-existing deterministic archive-date fixture failure (expected Today for a September 16 fixture on September 20). Root reports that its tree now contains the clock fix; this branch deliberately does not edit root-owned web files.
- Root accepted the scoped verification and all-project typecheck as sufficient for branch merge; socket-enabled/full-product gates remain root integration work. No live services or credentials were used.
- Separate provider follow-up is implemented in `ecac017`; see `simon-provider-outcomes.md`. Sharing implementation and analytics verification are in `c3df398`, atop the original `e61264b` checkpoint.

Adversarial review rechecked deciding-batch authority and exact replay, safe-integer receipt lifetime, scoped deletion, task/owner binding, R2-only snapshot behavior, capability-free model projections, proposal-only release boundary, event hint reauthorization, and consent-aware analytics. The missing analytics adapter callback and terminal provider-code persistence were fixed. No further defect was found in the scoped production diff.

Merge overlap: retain both this branch's Sharing registration and any newer Connections tool registration in the local/worker executor factories. Retain the optional trusted document session in agent tool context. Do not discard the provider checkpoint outcome assignment when merging root's newer repository work.
