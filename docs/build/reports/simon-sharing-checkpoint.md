# Simon Sharing tools — incomplete checkpoint

Checkpoint requested before completion. Base: `ee05885`; branch: `wip/d2-maintenance`;
worktree: `/Users/tejassuds/projects/symplist-wt/maintenance`.
Do not count this integration as verified or complete.

## Implemented, pending regression verification

- New core SimonSharingSession delegates snapshots, proposals, listing, revocation and handoff drafts to existing Sharing services using the trusted SimonDocumentSession actor getter.
- Agent registers five tools for task conversations, list only for quick chat. Model results exclude titles/content/capability URLs. Share creation proposes only; it never releases a token.
- Both local API and durable worker register the same tools. The agent receives the existing document session through an optional context seam. API local handler takes the existing global ObjectStore; no cross-feature Nest service import.
- Revoke uses encrypted folded idempotency with exact arguments, retained-run sentinel lifetime and a fresh authority read before replay. Quick deletion removes this native receipt scope but preserves HTTP replay receipts.
- Sharing-owned internal event handler reloads owner-authorized artifact identity before relaying a worker `share_grant.changed` hint.

## Verification at checkpoint

- Production changes: all 17 project typechecks passed **before** the newly added test file.
- Biome format/check passed over the 11 production files selected at that point (zero diagnostics); this was not a full repository lint run.
- New core test file contains local/Trigger cases for snapshots, handoff redaction, proposal-only behavior, exact replay, revocation, stale authority, ownership and quick-chat expiry. It has **not run**: the first attempt failed import resolution at `../documents/durable.ts`. Actual DurableDocumentGit implementation is `../documents/git-jobs.ts` (or use documents/index.ts). Stop/checkpoint instruction arrived immediately afterward, so no further feature edits or verification were performed.
- No full suite, build, browser, live, migration or credentials work in this task. No active task processes remain.

## Exact unfinished work / resume order

1. Fix the test-only DurableDocumentGit import; format the new test file, run focused core suite, and resolve any genuinely failing assertions/implementation defects. The test has not been typechecked yet; do not assume its preview method or output expectations are correct.
2. Add revocation mismatched-argument coverage and a race where cancellation/time change occurs before the deciding folded batch. Validate no duplicate audit/effect and no stale replay. Confirm sentinel receipt cleanup with quick-delete tests.
3. Add real scripted agent/model-loop parity tests under both executors, including quick tool omission and no raw capability exposure. Current coverage exists only as an unexecuted core test draft.
4. Add API internal-event tests for canonical task id, cross-owner/relocked rejection and malformed hints; verify worker factory registration with existing worker tests.
5. Review callbacks: native tool options currently wire grant events but not optional Sharing `onConfirmed` analytics. Determine appropriate existing analytics seam before claiming integration complete.
6. Run focused core/agent/API/worker tests, full lint (zero warnings), all project typechecks; coordinate full tests/build/browser with root and visual stream.
7. Separate follow-up requested by root: preserve SimonModelError `ai.unavailable` and persist stable provider outcome codes rather than unconditional `ai.provider_failed`/`executor_error`. **Not started**, do not mix it into this incomplete Sharing checkpoint.

## Decisions

- Worker lacks ARTIFACT_ORIGIN by design. Native SharingRepository is constructed with an empty origin because this seam never calls release or constructs links; do not add that API-only configuration to workers. Review this boundary before final acceptance.
- Handoff uses the existing encrypted artifact snapshot/handoffTemplate service, not a parallel document surface. It returns draft/reference metadata only; owner review remains necessary for release.
- Revocation receipts use the existing retained-run lifetime convention (`Number.MAX_SAFE_INTEGER` expiry) and only the `simon.native.sharing` scope is added to quick cleanup.
- No decisions table row yet: these choices are recorded here pending completed tests/adversarial review.

## Changed paths and overlaps

New feature files:

- `packages/core/src/simon/sharing.ts`
- `packages/core/src/simon/sharing.test.ts`
- `packages/agent/src/sharing.ts`
- `apps/api/src/modules/sharing/sharing.events.ts`

Shared/integration files:

- `packages/core/src/simon/index.ts`
- `packages/core/src/simon/quick-delete.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/turn.ts`
- `apps/api/src/modules/sharing/sharing.module.ts`
- `apps/api/src/modules/simon/simon.local.ts`
- `apps/api/src/modules/simon/simon.module.ts`
- `apps/worker/src/trigger/simon/simon-run.ts`
- `docs/build/reports/simon-sharing-checkpoint.md`

No root tree, UI, contracts, views, environment, migration, progress or coverage files changed.
