# D2 Sharing / Analytics stream

Status: implementation in progress, not ready to merge. Sole writer in `symplist-wt/sharing`, branch `wip/d2-sharing`.

## Backend checkpoint

- Migration 0800 creates artifacts, grants, sessions, proposals, audit and durable password limits, all STRICT and expand-only.
- Encrypted immutable snapshots come from existing document head objects. Selected sections, private prompt artifacts, owner previews, bounded lists, trusted-UI token release/replacement, explicit revocation and proposal-only Simon entry point are implemented.
- Release folds idempotency into the deciding access/source-guarded batch; one-time URLs are redacted from the recorded outcome.
- Separate artifact hostname routes serve script-free sanitized HTML or protected Markdown with no-store/referrer/robots/CSP headers. Password forms use a grant-bound nonce, shared Argon2 semaphore, durable limits and generation-bound Secure HttpOnly sessions.
- Restriction and bounded purge contributors are filled. Analytics consent lives on the existing users columns; random analytics identity never reaches responses. Client events use a first-party consent-checking relay.
- UI implementation is underway; no end-to-end or visual completion claimed.

## Decisions

D2D.1–D2D.3 in the append-only ledger explain the R9 identity relay, exact section selection and password capacity reservations.

## Verification so far

- Frozen dependency install passed in this isolated worktree.
- Core analytics tests: 4 passing.
- API and web TypeScript checks passed after backend/UI scaffolding.
- Sharing API tests: 7 passing, covering full snapshot/release/read journeys, one-time secret scans, cross-user/host/CSRF rejection, expiry/revocation, stale proposals, distinct public grants and password session/raw access.
- Focused backend lint: 32 files, zero errors and warnings. This is not the full repository gate.
- Baseline API fixture correction cherry-picked from integrator b7e805b as c9505cd. Its progress-log change is inherited, not independently edited.
- Full lint/test/build and adversarial review remain pending. No live credentials or migrations used.

## Exported integration seams

- `SharingRepository.snapshot(actor, taskId, input, requestId)`, `list`, `preview`: actors reuse `DocumentActor` and fold run/grant guards into snapshot mutations.
- `SharingGrants.propose(actor, { artifactId, expectedHead, mode, expiresAt }, requestId)` returns proposal id/status only; `release` is never a tool and belongs exclusively to the app-class owner endpoint.
- `SharingGrants.revoke(actor, artifactId, grantId)` supports trusted scoped actors.
- Web `setHandoffDraftHandler`: ordinary user-initiated Simon drafting, no external launch or background summarization.
- Web analytics `track(name, properties)` is consent-gated, never queues, never sends identity. Existing server `capture` remains the server-owned event seam; `captureClient` is reserved for the authenticated relay.

## Shared files / overlaps to audit

Current additions outside feature directories: migration 0800; `packages/docs/src/markdown/artifact.ts` and markdown export; Sharing restriction/purge contributors; API route-class cookie allowlist and logger redaction; analytics server emitter; web Account Privacy slot; web privacy and handoff route pages; appended globals.css block; decisions ledger and this report. Final report will enumerate every changed path before merge.
