# Phase E: current-route one-time-secret scans

Worktree `symplist-wt/maintenance`, branch `wip/d2-maintenance`, updated from build checkpoint `9e63cfc` before this slice. Tests only; no production, contract, migration or shared harness changes.

## Exact route inventory and coverage

All paths below are exercised against the real local Nest HTTP application, SQLite database and local R2 adapter with newly issued test-only secrets.

| Surface | Issuance routes / variants | Reads and duplicates checked |
| --- | --- | --- |
| Administrator invite codes | `POST /v1/admin/invites`, independent batch and shared campaign | Two duplicate requests; redacted `secret.already_issued` results; changed-input mismatch; `GET /v1/admin/invites`, `/:id`, and `/v1/admin/activity`; one batch of invites remains |
| Login/signup OTP and session token | `POST /v1/auth/signup`, `/v1/auth/otp`, `/v1/auth/otp/verify` | Consumed challenge returns exact 410 `otp.expired` with no cookie; `/v1/me` contains neither OTP nor raw session token |
| Account-deletion OTP | `POST /v1/account/deletion/otp`, `/v1/account/deletion/verify` | Verification response, duplicate consumed-challenge error and all persistence/log sinks exclude the OTP and login token |
| Vault session cookies | `POST /v1/vault/setup`, `/v1/vault/unlock` | Setup and unlock replay have no `Set-Cookie`; issued cookies differ; changed-input mismatch; `GET /v1/vault` and `/v1/vault/items` exclude both tokens and passphrase |
| Vault item/grant mutations | `POST /v1/vault/items`, `/v1/vault/grants` | Exact mutation replay contains ids/version or a scoped `{$vault:id}` handle, never the item value; item summary list excludes value; explicit authenticated item read proves the real value exists |
| Vault recovery | `POST /v1/vault/reset/otp`, `/v1/vault/reset/verify`, `/v1/vault/reset` | Consumed-OTP rejection; exact reset replay and status exclude old/new passphrases, OTP and old Vault cookie |
| Artifact release | `POST /v1/artifacts/:artifactId/grants`, link/password/public/proposal-release/replacement variants | Two exact retries return redacted grant-only responses; changed-input mismatch; `/v1/tasks/:taskId/artifacts` inventory; replacement rotates URL and revokes the previous grant |
| Recipient share session | `POST /artifact/:artifactId/password` on the artifact host | Real form nonce, successful cookie issuance and authenticated `/artifact/:id/raw`; body, persistence and logs never contain the issued recipient-session token or password |

## Scan strength

- Every non-internal D1 table is scanned, not just the feature's tables. Every object body and local metadata sidecar is scanned. Operational logs are captured from the real app.
- Non-minting response **bodies and headers** are scanned, catching a replay that leaked through `Set-Cookie` even with a safe JSON body.
- Every persisted idempotency response is required to be a `sym1` envelope and decrypted using its real owner/scope/key AAD. Its plaintext must also exclude all issued secrets. Raw-byte-only persistence scans would miss a wrongly replayable encrypted secret.
- Minted codes/tokens must be real nonempty values with expected length/shape. Invite code scans check display and canonical forms; shares check complete URL plus the raw key; each sensitive mutation asserts a real successful response and expected record counts.
- Seven positive controls intentionally leak a fake canary into D1, an object body, object metadata, logs, encrypted replay state, response body or response headers. Each must fail with the **specific scanner's** assertion message, including the encrypted-only case where the raw database scan correctly finds nothing.

## Decisions and intentional distinctions

- R11's replayable redacted outcome applies to invite/share issuance. OTP verification instead consumes its challenge and rejects reuse with the existing `otp.expired` contract; Vault setup/unlock replays safe status but never the cookie. Tests preserve these established contracts rather than inventing a new common response shape.
- Owner-bound authorization ids, Vault grant handles and public publication ids are not raw credentials. They may be persisted and replayed under their existing authorization checks. Vault item/grant values remain encrypted by design; only explicit authorized item reads return a value. These tests do not call that required read a leak.
- The artifact password form necessarily carries the **presented** share key in its hidden field (§13.3); this is not a new owner release. The form may not contain the password or recipient-session token. Issued OTPs necessarily reach the captured security-email transport, which is a delivery sink, not an operational log.
- No production defect was found in this slice. Existing tests were not changed, weakened, skipped or removed; no lint suppressions were added.

## Remaining gaps — not claimed complete

- Connections/MCP is not yet merged at this checkpoint. MCP API-key creation and OAuth authorization-code issuance still need the same per-route scans, plus access/refresh token handling and hosted connection credentials once their routes land. This slice must not close the global carried Phase C item until those routes are covered.
- These are local contract suites, not live D1/R2/provider, browser, deployment or provider-retention verification. They do not replace the Simon Trigger marker test, executor parity tests or a full realtime/analytics sink audit.

## Verification

- Focused new suites: **21 tests passed** across four files (14 endpoint cases plus seven scanner positive controls).
- `pnpm lint`: 1,274 files, zero errors/warnings. `pnpm typecheck`: all 17 projects passed.
- `pnpm test`: full default-concurrency workspace and all 47 script tests passed. API: 471 passed plus six existing credential-gated skips; core 553, worker 93, web 1,558, and every other package passed with its original live skips unchanged.
- The first full run encountered one pre-existing Sharing fixture returning 500 while creating its document, before the password test began. That unchanged 16-test suite passed on a focused rerun, and the unchanged full suite passed next. No production fix, test weakening or timeout increase was used.
- Documentation links/44-screen brief check and `git diff --check` passed.
- `pnpm --filter @symplist/web build`: production build passed.
- No real credentials, provider calls, live database migrations or browser servers were used.

## Every changed path / overlaps

- `apps/api/test/secret-scan.ts` — new shared test-only scanner.
- `apps/api/test/secret-scan.test.ts` — seven positive controls.
- `apps/api/test/access-secret-scans.test.ts` — invite, login/signup and deletion-OTP contracts.
- `apps/api/test/vault-secret-scans.test.ts` — Vault capability/passphrase/value contracts.
- `apps/api/test/sharing-secret-scans.test.ts` — share release/replacement/proposal/recipient-cookie contracts.
- `docs/build/reports/e-one-time-secrets.md` — this report.

No edits to existing feature files, shared harness, progress, coverage, decisions ledger, manifests, lockfile or secrets.

## Commit checkpoints

- `cebdf67`: reusable scanner, positive controls and Access route contracts.
- Final checkpoint adds Vault/share endpoint contracts and this route inventory/report.
