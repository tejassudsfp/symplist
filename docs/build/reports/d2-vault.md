# D2 Vault — implemented and stage-verified

Branch: `wip/d2-vault`. Sole worktree: `symplist-wt/vault`. Integration base: `bc138ea`; root fixture repair `b7e805b` was cherry-picked as `9989373`.

## Implemented

- Migration 0700: Vault wraps, encrypted/versioned items, token-digest sessions, reset authorizations, durable unlock counters, scoped grants, redacted reset audit and pending security notices.
- Core setup/unlock with existing shared Argon2id semaphore, random data key, layered account-key envelopes, five-minute idle and one-hour absolute expiry, fresh owner/login authorization, optimistic item writes and guarded idempotency.
- Fresh purpose/session-bound OTP recovery preserving contents; all old sessions/grants revoked in the deciding batch; generic security notification retried by an audit-backed bounded api sweep.
- Cookie-only app routes, Origin/CSRF classification, fresh admitted guards, per-IP unlock/OTP limits, no item/token/passphrase replay in responses or persistence.
- Worker-safe task/tool/JSON-pointer grant resolver and result redactor; restriction, logout, archive, deletion and expiry contributors.
- Five Vault screen flows, protected route group without analytics, responsive list/detail, masked reveal/copy, secure Markdown notes, version-conflict drafts and discard-on-lock, three-step OTP reset, keyboard focus management and scoped grant picker with embedded unlock.

## Decisions

Append-only rulings D2V.1–D2V.6 record wrapper crypto-shred, draft disposal, passphrase policy, JSON Pointer grants, shared OTP infrastructure and byte-safe 15-item pagination.

## Verification actually run

- Frozen dependency install passed in the isolated tree.
- `pnpm lint`: 1,152 files, zero errors/warnings; rerun after final accessibility/scan additions.
- `pnpm typecheck`: all 17 projects passed, including authored browser tests; rerun after final additions.
- `pnpm test`: full workspace and 47 script tests passed. Relevant totals: core 394, web 1,494, API 389 (6 existing live skips), contracts 164. Vault-specific coverage: core 33, HTTP 10, UI 10, contracts 13. Final HTTP/UI reruns passed after extra secret scans and accessible error association.
- `pnpm --filter @symplist/web build`: production build passed.
- First full test run found and fixed an unused SQL parameter in the restriction contributor and a pre-D2 Search fixture that created its own `vault_items`. The Search canary exclusion assertion is retained. The pre-D2 shell test asserting an empty Vault slot now asserts the implemented safe status text. No tests or lint rules were weakened. Two early Documents timeouts under contention did not recur in the green full run.
- Browser journey/evidence is **authored but unrun**, per the integrator's no-concurrent-e2e instruction: real API setup, secret edit, Markdown note, lock/unlock, purpose-bound OTP recovery and retained contents; accessibility checks and 36 populated-list theme/mode/viewport frames when the three-project suite runs. No screenshot or browser-pass claim is made here.
- Live D1/R2 and other credential-dependent suites are not verified by this isolated stream. Parent owns final live/deployment/combined browser gates.

## Exported integration seams

- `@symplist/core/vault`: `VaultRepository`, `VaultSessions`, `VaultItems`, `VaultReset`, `VaultGrants`, `resolveVaultArguments`, `cleanupVault`, `disposeOpenVault`.
- `resolveVaultArguments(db, policy, context, arguments)` requires `kind: 'task'`, owner/task/conversation/tool, account key, time, and a trusted current-run/generation SQL guard. It returns `{ arguments, redact }`; Simon must apply `redact` to both results and errors before *any* model/checkpoint/stream/log sink.
- `cleanupVault(db, now, limit = 100)`: bounded expiry/clear/prune for the scheduling cleanup task. Resolver rejects expiry even before cleanup runs.
- `VaultGrantPicker` in web `features/vault/grant-picker.tsx`: trusted approval UI receives explicit task/conversation/tool/argumentPath, deliberately selects an item and returns only `{$vault: id}`. It never grants from a chat reply or quick chat.
- `vault.locked` uses the architecture's canonical `idle | logout | reset | revoked` reasons; manual lock maps to `revoked`.

## Shared-file overlaps

- `packages/db/migrations/0700_vault.sql` (reserved Vault allocation).
- `packages/core/src/access/restrict-contributors/vault.ts`, `access/session-revoke-contributors/vault.ts`, `tasks/archive-contributors/vault.ts`, `account/purge-contributors/vault.ts`.
- `packages/core/src/search/writer.test.ts`: pre-D2 fixture upgraded, original exclusion assertion retained.
- `apps/api/src/common/platform.module.ts`: shared OTP providers/exported tokens.
- `apps/api/src/infra/email/otp.ts`: extracted shared OTP infrastructure.
- Access `access.providers.ts`, `access.tokens.ts`, `test-otp.controller.ts`; old access-only `otp-mailer.ts` and `otp-test-outbox.ts` moved into shared infrastructure. Existing token values and behavior retained.
- `apps/web/src/app/(vault)/**`: real protected screens.
- `apps/web/src/app/globals.css`: one appended, labelled D2 Vault block only.
- `apps/web/src/app/(app)/layout.test.tsx`: explicitly updates the pre-D2 empty-slot expectation.
- `apps/e2e/tests/vault.spec.ts`: authored browser journey and evidence matrix.
- `docs/build/decisions.md`: appended D2V rows; this report. Integrator owns progress/coverage.
- The cherry-picked root fixture repair also touches `apps/api/src/modules/internal/internal.test.ts`, `apps/api/test/platform.test.ts`, and `docs/build/progress.md`; these are root's unchanged repair, not new Vault edits.

## Adversarial review

Reviewed the branch implementation and tests for authority, concurrency, encryption, SQL bounds and UI retention. Fixed:

- Access-generation fencing stops relock/restore races committing under old admission; login expiry is refreshed after expensive Argon2 work.
- Conditional idempotency misses remove their claim rather than recording false success; expired replay records no longer shadow fresh claims.
- Distinct unlock-limit write IDs prove the deciding reservation, not the initial insert/window reset.
- Outer account-key envelopes make service recovery impossible after crypto-shred; grant paths reject missing account keys too.
- Edits/deletes, reset, archive and restriction clear grant ciphertext in the deciding batch. Resolution checks item version, exact tool/path/task/conversation, expiry and run guard.
- Redaction covers plain/base64/base64url/URL/JSON-escaped forms, labels containing credentials, and cyclic/deep tool output.
- Late reads/saves/deletes/pagination cannot restore plaintext after lock; dirty editors cannot be replaced by another selection. Lock clears names, drafts, selection and busy state. Picker clears on expiry/hidden tab/realtime lock.
- Maximum-size encrypted notes cannot exceed D1's response limit: 15 items plus one cursor probe, with pagination continuity tested.
- Visible labels, associated errors, keyboard submit/reveal, focus placement, masked defaults, no secret-bearing copy notices, mobile single-pane layout and reduced motion.

## Integration tail / open verification

- Parent must wire the exported picker/resolver into Simon's trusted approval/tool path and invoke `cleanupVault` from the existing hourly task. No parallel Simon/scheduling implementation was created.
- Access/Realtime already emit `session.ended`/`access.changed` and close affected sockets; Vault contributors revoke their rows atomically. For strict §11.1 event coverage, parent should add the additional canonical `vault.locked` frame before logout/restriction socket closure in the shared notifier integration. Manual lock/reset publish it here.
- Run the authored browser suite and inspect all theme/viewport frames; shared-token styling is implemented but visual verification is not claimed without those runs.
