# D2 Vault — work in progress

Branch: `wip/d2-vault`. Sole worktree: `symplist-wt/vault`. Integration base: `bc138ea`; root fixture repair `b7e805b` was cherry-picked as `9989373`.

## Implemented

- Migration 0700: Vault wraps, encrypted/versioned items, token-digest sessions, reset authorizations, durable unlock counters, scoped grants, redacted reset audit and pending security notices.
- Core setup/unlock with existing shared Argon2id semaphore, random data key, layered account-key envelopes, five-minute idle and one-hour absolute expiry, fresh owner/login authorization, optimistic item writes and guarded idempotency.
- Fresh purpose/session-bound OTP recovery preserving contents; all old sessions/grants revoked in the deciding batch; generic security notification retried by an audit-backed bounded api sweep.
- Cookie-only app routes, Origin/CSRF classification, fresh admitted guards, per-IP unlock/OTP limits, no item/token/passphrase replay in responses or persistence.
- Worker-safe task/tool/JSON-pointer grant resolver and result redactor; restriction, logout, archive, deletion and expiry contributors.
- Five Vault screen flows, protected route group without analytics, list/detail, masked reveal/copy, editor conflicts and discard-on-lock, three-step OTP reset. UI/review tests are continuing.

## Decisions

Append-only rulings D2V.1–D2V.5 record wrapper crypto-shred, draft disposal, passphrase policy, JSON Pointer grants and shared OTP infrastructure.

## Verification so far

- Frozen dependency install passed in the isolated tree.
- Core Vault tests: 13 passed.
- Vault HTTP plus feature-module structural tests: 12 passed.
- Vault web component tests: 8 passed, no unhandled errors.
- API/web/core typechecks passed before the latest test additions; final full gates still pending.
- First full test run found and fixed an unused SQL parameter in the restriction contributor and a pre-D2 Search fixture that created its own `vault_items`. The updated Search test uses migration 0700 with the same plaintext-canary exclusion assertion, not a weakened test. Two Documents tests hit their existing 5-second timeout under parallel load; isolated rerun pending.

## Exported integration seams

- `@symplist/core/vault`: `VaultRepository`, `VaultSessions`, `VaultItems`, `VaultReset`, `VaultGrants`, `resolveVaultArguments`, `cleanupVault`, `disposeOpenVault`.
- `resolveVaultArguments(db, policy, context, arguments)` requires `kind: 'task'`, owner/task/conversation/tool, account key, time, and a trusted current-run/generation SQL guard. It returns `{ arguments, redact }`; Simon must apply `redact` to both results and errors before *any* model/checkpoint/stream/log sink.
- `cleanupVault(db, now, limit = 100)`: bounded expiry/clear/prune for the scheduling cleanup task. Resolver rejects expiry even before cleanup runs.
- `VaultGrantPicker` in web `features/vault/grant-picker.tsx`: trusted approval UI receives explicit task/conversation/tool/argumentPath, deliberately selects an item and returns only `{$vault: id}`. It never grants from a chat reply or quick chat.

## Shared-file overlaps

- `packages/db/migrations/0700_vault.sql` (reserved Vault allocation).
- `packages/core/src/access/restrict-contributors/vault.ts`, `access/session-revoke-contributors/vault.ts`, `tasks/archive-contributors/vault.ts`, `account/purge-contributors/vault.ts`.
- `packages/core/src/search/writer.test.ts`: pre-D2 fixture upgraded, original exclusion assertion retained.
- `apps/api/src/common/platform.module.ts`: shared OTP providers/exported tokens.
- `apps/api/src/infra/email/otp.ts`: extracted shared OTP infrastructure.
- Access `access.providers.ts`, `access.tokens.ts`, `test-otp.controller.ts`; old access-only `otp-mailer.ts` and `otp-test-outbox.ts` moved into shared infrastructure. Existing token values and behavior retained.
- `apps/web/src/app/(vault)/**`: real protected screens.
- `apps/web/src/app/globals.css`: one appended, labelled D2 Vault block only.
- `docs/build/decisions.md`: appended D2V rows; this report. Integrator owns progress/coverage.

## Adversarial review

In progress. Not yet ready to merge; final full gates, whole-diff review and additional security races remain.
