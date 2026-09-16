# Sharing trusted actor freshness audit

## Findings and fixes

1. `SharingRepository.list` checked actor scopes in memory but omitted the trusted actor's SQL conditions from its deciding account-key read. A cancelled run, obsolete executor generation, switched executor mode, or expired quick conversation could still receive sharing metadata. The read now combines owner access and `actorGuards` in the same bounded batch that reads artifacts and grants.
2. `SharingGrants.propose` loaded an artifact and could return an existing proposal before any SQL actor condition was applied. `loadArtifact` now accepts additional trusted conditions, and both `propose` and `revoke` pass their actor conditions at the initial read. Duplicate proposal replies therefore require current run authority, not just retained task scope and account access.
3. Snapshot publication used the actor guard assembled before asynchronous object storage work. It now reacquires actor guards immediately before constructing the deciding write, after upload. This allows the trusted executor's dynamic guards to use the current clock for expiry checks. The existing write-time run-status, access, generation, mode and source-head fences remain intact.

Snapshot replay already requires the guarded initial account-key read. Proposal creation and revocation already repeat actor guards on their deciding writes. The audit retains these defenses and adds explicit races exercising them. Native operations still cannot mint share tokens; owner-UI release remains separate.

## Tests

`packages/core/src/sharing/actor-freshness.test.ts` adds 28 tests using real local SQLite, document publication, account encryption, Simon claims and run guards:

- Stop, generation change, mode switch, account relock, task archive and time-bounded capability expiry reject list, snapshot replay/new snapshot, proposal replay/new proposal and revocation; no rows/audit effects are added and active grants are unchanged.
- Cancellation inserted immediately before the deciding read rejects list, proposal replay and snapshot replay.
- A real quick conversation can list referenced-task artifacts before expiry and cannot after its TTL.
- Every invalidation during encrypted snapshot upload prevents artifact/audit publication.
- Run-state changes immediately before the proposal deciding batch prevent insertion.
- Every invalidation after revocation's preliminary read prevents grant mutation, generation increment and audit insertion.
- Capability expiry after proposal's preliminary read prevents insertion.

The pre-existing duplicate proposal success and list paths are exercised before invalidation, so these are not tests that merely assert every operation fails. The synthetic expiry condition used for task-scoped write races models a time-bounded trusted capability without violating the database constraint that ordinary task conversations have no TTL. The quick-chat test separately exercises actual conversation expiry.

## Decisions and integration seam

- Keep `DocumentActor` unchanged. Its trusted `guards` property can be a getter; Sharing invokes `actorGuards` again after external work. The parent owns the corresponding `SimonDocumentSession.actor()` getter change and its executor integration tests. This branch does not claim to have changed Simon's guard construction.
- Treat a failed initial authority read as generic `not_found`, matching existing owner-access behavior. A lost deciding write remains `sharing.stale`.
- Keep encrypted uploads that lose their publication race unpublished; existing bounded orphan cleanup owns their eventual removal. Do not delete objects speculatively across a race.
- Preserve bounded batches, expand no schema, and add no queue or task.

## Exact files and overlaps

- `packages/core/src/sharing/repository.ts`
- `packages/core/src/sharing/grants.ts`
- `packages/core/src/sharing/actor-freshness.test.ts` (new)
- Outside the feature directory: only this report, `docs/build/reports/sharing-actor-freshness.md`.

No Simon/native adapters, document actor types, UI, migrations, secrets, progress or coverage files changed.

## Verification

- Focused actor-freshness suite: 28 tests passed.
- `pnpm lint`: 1,276 files, zero errors and warnings.
- `pnpm typecheck`: all 17 projects passed.
- `pnpm test`: passed in full, including core 581, API 473 (6 existing live skips), worker 93, web 1,558 and scripts 47.
- `pnpm --filter @symplist/web build`: passed.
- Docs/link checks and `git diff --check`: passed.
- The first full attempt timed out at the unchanged `documents/tools.test.ts:336` five-second limit. That entire file passed focused (14 tests), and the full default-concurrency suite then passed unchanged. No timeout, concurrency, assertion or test selection was changed for the successful full rerun.
