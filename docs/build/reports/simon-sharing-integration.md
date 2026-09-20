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
