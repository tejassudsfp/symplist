# Closed beta invites

Proposed implementation contract. No live codes or admin interface exist yet.

## Generate codes

An authenticated administrator creates invites through a Beta access screen or an equivalent authenticated management command. Bootstrap the first administrator from an explicit operator-selected, verified account; never promote the first person who signs up.

Generate each code using a cryptographically secure random source: 20 random bytes encoded as 32 human-readable Base32 characters, displayed in groups with a `SYM-` prefix. This provides 160 random bits. Normalize casing, spaces, and separators consistently before digesting or redeeming.

Default: one redemption, valid for seven days. Allow an administrator to change expiry, set a redemption cap, optionally bind the invite to a normalized email, and add a private campaign/note. A batch request generates independent codes; a shared campaign code is a separate explicit choice.

Show/copy each raw code once so the operator can keep it privately and share it personally. Store an HMAC-SHA-256 digest under a deployment secret with a version identifier, plus a short non-secret display hint. Do not put raw codes in logs, analytics, URL query strings, or recoverable admin listings. Users paste the code after email verification. A lost unused code can be revoked and replaced. Invite codes are never automatically sent or granted to signups; signup emails contain only verification OTPs. Distribution is manual, controlled by the operator.

## Records and usage

- `beta_invites`: ID, digest, digest-key version, hint, created-by, created-at, expiry, maximum redemptions, redemption count, optional email binding, revoked-at, and note/campaign.
- `beta_redemptions`: invite ID, user ID, redeemed-at, unique request ID. Enforce uniqueness for invite/user.
- `beta_access_grants`: user ID, source (invite/admin), source ID, granted-at, revoked-at, actor, and reason. Enforce one current grant per account for the initial model.
- `beta_admin_events`: immutable event ID, actor, action, target, timestamp, reason, and relevant before/after values. Keep secrets out of this log.

Invite usage means claimed seats, with a list of verified accounts that redeemed them. It is independent of AI token usage and any future paid quota system.

The admin screen lists active/expired/revoked/exhausted invites, uses versus cap, expiry, and redeemed accounts. It supports generation, increasing a cap, extending expiry, revoking future redemption, directly unlocking an account, and relocking an account. Ordinary users cannot access these actions.

## Redeem atomically

Require an authenticated, verified, nonsuspended account. Throttle by account and IP. An already-unlocked account returns its current access state without consuming another invite.

Validate digest, revocation, expiry, optional email binding, and remaining capacity. Then claim a seat, insert the redemption and access grant, and record the event as one atomic operation with enforced constraints. A concurrent claim for the final seat must yield only one unlock. Two different code submissions for the same locked user must not consume two seats. Replaying a successful request returns success without incrementing counters.

D1 is accessed through REST: the implementation must demonstrate an atomic conditional SQL/batch design supported by that API. Do not use a read-then-increment sequence or assume a transaction can stay open across separate HTTP requests. This is an implementation verification requirement, not a tested query design yet.

Invalid, expired, or exhausted codes return a concise failure without revealing the bound email. An unlock response takes the user into onboarding. A declined or failed redemption leaves account data and state intact.

## Revoke and manage usage

Revoking or expiring a code stops future redemptions; it does not relock accounts already admitted. Relocking a particular account is a separate explicit action. For an affected campaign, an admin may preview and confirm revocation of its current account grants.

Do not reset redemption counters to zero: doing so would lose their meaning while accounts remain unlocked. To admit more people, increase the cap or generate a new batch. To remove access, revoke the relevant grant. Relocking does not automatically refund a code seat; restoring access should normally be an admin grant with an audit record.

This supplies invite usage management during beta. Paid AI allowance resets remain deferred with billing. Optional diagnostic totals can be filtered by time window without deleting their underlying records.

## Enforcement and session behavior

Nest checks account access for every protected request, WebSocket subscription/control, connector authorization initiation, object download, and MCP call. A signed-in cookie is not proof of beta access. Check access again before agent dispatch and tool execution in both Nest and Trigger modes; cached grants require a bounded invalidation policy.

Relocking rejects new work, invalidates backend grants, disconnects protected subscriptions, and requests cancellation of active work. It cannot undo completed external side effects or recall downloaded data. A locked account cannot simply redeem another invite to bypass an administrative relock: flag invite redemption as blocked until an admin explicitly restores eligibility/access.

If direct Trigger output is eventually selected, short-lived output tokens need an explicit expiry/revocation policy. Do not promise immediate stream revocation from a token that remains valid until expiry. Backend-only output remains the currently confirmed route.

## Self-hosting

Operators can set `BETA_ACCESS_REQUIRED=false` to allow all verified, nonsuspended accounts to proceed into onboarding. This disables the invite requirement, not authentication or ownership checks. Explicit account suspension/revocation still blocks access. There is no central Symplist license check or hosted unlock dependency.

## Release checks

Test final-seat concurrency, simultaneous different-code redemption by one user, idempotent retries, digest normalization, expiry, revocation, email binding, already-unlocked users, admin authorization, relock bypass attempts, both agent executors, direct REST storage atomicity, and isolated self-hosting with beta access disabled.

## Read-only share exception

An anonymous recipient may read only an artifact authorized by a valid [share grant](16_simon_handoffs_and_artifact_sharing.md). This never unlocks the app or exposes task APIs. Relocking/suspending/deleting the owner disables all affected grants on the next read; re-unlock does not silently revive them.
