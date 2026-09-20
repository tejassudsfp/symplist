# D2 Sharing / Analytics stream

Current status: merged and Phase E verified. `sharing.spec.ts` passes private/password/public release,
signed-out HTML/raw reads, revoke, relock, deterministic expiry and manual handoff release at all
three viewports. The original `symplist-wt/sharing` branch checkpoint and remaining-integration
language below are retained as implementation history.

## Backend checkpoint

- Migration 0800 creates artifacts, grants, sessions, proposals, audit and durable password limits, all STRICT and expand-only.
- Encrypted immutable snapshots come from existing document head objects. Selected sections, private prompt artifacts, owner previews, bounded lists, trusted-UI token release/replacement, explicit revocation and proposal-only Simon entry point are implemented.
- Release folds idempotency into the deciding access/source-guarded batch; one-time URLs are redacted from the recorded outcome.
- Separate artifact hostname routes serve script-free sanitized HTML or protected Markdown with no-store/referrer/robots/CSP headers. Password forms use a grant-bound nonce, shared Argon2 semaphore, durable limits and generation-bound Secure HttpOnly sessions.
- Restriction and bounded purge contributors are filled. Analytics consent lives on the existing users columns; random analytics identity never reaches responses. Client events use a first-party consent-checking relay.
- Filled the existing D1 artifact-surface seam: saved-document/section selection, owner snapshot previews, share review, exact proposal review, one-time release, replacement/revocation, independently paged grants and empty/loading/error states. The handoff editor saves private prompts with artifact placeholders; current release URLs are assembled only in browser memory for explicit copy/download. Manual and Simon replacement drafts require confirmation before overwriting edited text.
- Added command-palette and task-menu actions, selected-link revocation, dirty-navigation protection, accessible confirmation/error states and responsive theme-token styles. The isolated script-free recipient viewer includes raw/download access and a password form; no app shell, analytics or remote media.
- Mandatory equally styled Accept/Decline choices and Account Privacy controls share one consent store. Browser analytics have no SDK, persistent queue or identity; appearance/search events use the strict consent-checking relay. A public privacy notice states service access, US analytics and retention/deletion limitations without claiming end-to-end encryption.

## Decisions

D2D.1–D2D.6 in the append-only ledger explain the R9 identity relay, exact section selection, password capacity reservations, bounded orphan collection, independent inventory cursors and self-hosted viewer fonts.

## Verification

- Frozen dependency install passed in this isolated worktree.
- Full `pnpm lint`: 1,170 files, zero errors/warnings. Full `pnpm typecheck`: all 17 projects passed.
- Full `pnpm test`: passed across all packages/apps and 47 script tests. Includes 399 API tests (6 existing live skips), 1,508 web tests before the final additional prompt-preservation test, 370 core tests and 105 analytics-wrapper tests. No live skips were removed or bypassed. One earlier bounded analytics queue timing failure passed unchanged on focused and full reruns.
- Sharing API: 16 passing real HTTP/SQLite/R2 contracts; analytics API: 4 passing; sharing/consent UI and runtime: 24 passing before the additional prompt-preservation regression. Core analytics: 4 passing; export filtering and sanitized Markdown have separate tests.
- `pnpm build:web:clean` passed, including the artifact, handoff, proposal and privacy routes.
- Final prompt-preservation regression: all 12 sharing UI tests passed; final web typecheck and repository lint passed. `pnpm build`, `node scripts/check-api-deploy.mjs` (12 runtime packages, 34 migrations, boot/shutdown), and `python3 scripts/check_docs.py` all passed.
- API test probe routes were moved to `/artifact/_probe/:id` because their old pre-D2 routes collided with real controllers; all original security assertions remain. The pre-D2 empty consent-slot assertion now checks the fail-closed loading error and retry button. Both changes have explicit separate commit messages.
- Baseline API fixture correction cherry-picked from integrator b7e805b as c9505cd. Its progress-log change is inherited, not independently edited.
- Authored a Playwright saved-document → snapshot → trusted release → isolated viewer → revocation flow. Not run here: the integrator owns combined e2e, live suites, smoke, visual matrix and live migrations. No live credentials or migrations used.

## Exported integration seams

- `SharingRepository.snapshot(actor, taskId, input, requestId)`, `list`, `preview`: actors reuse `DocumentActor` and fold run/grant guards into snapshot mutations.
- `SharingGrants.propose(actor, { artifactId, expectedHead, mode, expiresAt }, requestId)` returns proposal id/status only; `release` is never a tool and belongs exclusively to the app-class owner endpoint.
- `SharingGrants.revoke(actor, artifactId, grantId)` supports trusted scoped actors.
- `SharingOptions.onGrantChanged(owner, taskId, artifactId)` runs after a confirmed deciding batch. The API publishes `share_grant.changed` on the owner's realtime topic. Worker callers must relay the same ids-only event through the existing internal event path.
- Worker constructions of `SharingRepository` must pass `privateOrigins: [WEB_ORIGIN, API_ORIGIN]` so exported clickable links cannot lead back into the private application. No Git or plaintext Trigger payload is involved in snapshots.
- `SharingMaintenance.sweep(now)` and `collectOwner(owner, now, cursor?)` are bounded cleanup seams for `cleanup-hourly`; the Scheduling integration must register/call these, without another D1 task/queue.
- Web `setHandoffDraftHandler`: ordinary user-initiated Simon drafting, no external launch or background summarization.
- Web analytics `track(name, properties)` is consent-gated, never queues, never sends identity. Core `AnalyticsService.capture(owner, event, properties, eventId)` privately reads fresh admission/consent/id for server-owned events; `captureClient` is reserved for the authenticated relay. Simon must wire quick-chat start/save at confirmed lifecycle transitions.
- `sharingTools` provides strict snapshot, proposal-only share creation, list, revoke and private handoff contracts. Simon registers execution with its existing actor/run fencing. Owner release is deliberately not a tool. Proposal review route: `/share-proposals/:proposalId`.

## Adversarial review fixes

- Preserved redacted exact idempotency replays after a requested expiry has passed, without minting another token or creating a recorded success when access/source guards fail.
- Fenced concurrent revoke responses to the generation read, invalidated generation-bound password sessions and kept revoke errors inside the active confirmation dialog.
- Reserved password attempts before Argon2, bounded durable windows across reader/process restarts, added per-IP process limits and marked share-host D1 reads unauthenticated.
- Applied private/no-store, no-referrer, robots and CSP defaults before early middleware/guard/validation failures. Malformed artifact ids receive the same generic unavailable screen, not owner metadata.
- Removed private object URLs/capabilities from export text and inerted private-origin/relative clickable links; remote images never load in the viewer.
- Added a 24-hour orphan grace period and a ten-minute publication cutoff, bounded D1 batches/cursors, coalesced realtime reloads and guarded late UI completions.
- Made failed initial consent saves retain the mandatory choice; failed withdrawal stays locally off. No analytics identity appears in API settings/events responses or structured logs.
- Explicitly denied MCP share proposals, kept trusted-UI release exclusive, and added prompt replacement confirmation so drafting cannot silently erase reviewed text.

## Integration / Phase E remaining

Register the Simon tool/draft callbacks, worker realtime/analytics callbacks and Scheduling cleanup seams described above. Run the authored browser flow after merges and capture 1440/1024/390 evidence across six themes/light/dark. Run configured live PostHog verification and verify the project's 30-day retention/provider deletion configuration; no deployment-level retention claim is made by this stream. All service-managed account purge/deletion behavior uses the existing foundation contributors and provider deletion flow.

## Shared files / overlaps to audit

Every path outside the Sharing/Analytics feature directories (including tests/config) follows; feature-owned paths under `apps/{api,web}/src/{modules,features}/{sharing,analytics}`, `packages/{core,contracts}/src/{sharing,analytics}` are not repeated.

- `apps/api/package.json`; `pnpm-lock.yaml` (Geist asset dependency).
- `apps/api/src/common/errors/api-error.ts`; `apps/api/src/common/http/host-surface.ts`; `apps/api/src/common/guards/route-class.guard.ts`; `apps/api/src/common/guards/route-class.guard.test.ts`; `apps/api/src/common/logging/redact.ts`; `apps/api/src/common/logging/logging.test.ts`; `apps/api/src/infra/limits/limits.test.ts`.
- `apps/api/test/probes/limits.probe.ts`; `apps/api/test/probes/logging.probe.ts`; `apps/api/test/probes/route-classes.probe.ts`.
- `apps/web/src/app/globals.css` (one appended block); `apps/web/src/app/(app)/layout.test.tsx`; `apps/web/src/app/(app)/tasks/[taskId]/handoff/page.tsx`; `apps/web/src/app/(app)/share-proposals/[proposalId]/page.tsx`; `apps/web/src/app/privacy/page.tsx`.
- `apps/web/src/features/access/settings/account-settings.tsx`; `apps/web/src/features/workspace/preferences-store.ts`; `apps/web/src/features/workspace/telemetry.ts`.
- `apps/e2e/tests/sharing.spec.ts`.
- `packages/analytics/src/server.ts`; `packages/analytics/src/server.test.ts`.
- `packages/core/src/access/restrict-contributors/sharing.ts`; `packages/core/src/account/purge-contributors/sharing.ts`.
- `packages/db/migrations/0800_sharing.sql`.
- `packages/docs/src/markdown/artifact.ts`; `packages/docs/src/markdown/artifact.test.ts`; `packages/docs/src/markdown/index.ts`.
- `docs/build/decisions.md` (D2D append only); `docs/build/reports/d2-sharing.md`.
- Inherited only from c9505cd: `apps/api/src/modules/internal/internal.test.ts`; `apps/api/test/platform.test.ts`; `docs/build/progress.md`.
