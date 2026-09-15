# Closed beta access and future billing

Current specification; not implemented. Closed beta supersedes the earlier Free/Pro launch proposal.

## Current behavior

Anyone can register and verify an email, but an account must be unlocked before accessing application features. Every unlocked beta account receives all configured features free, including chat and AI. No payment, plan selection, tier metering, weekly allowance, or credit balance is active during beta.

Fast and Smart remain model choices configured through environment variables. They are not subscription tiers and do not require separate beta allowances.

## Signup and onboarding

1. Enter email. Existing users receive a Resend OTP. Unknown emails show “No account found. Create one?”
2. On affirmative signup consent, create a pending account and send an OTP. Verification activates the login identity but leaves beta access locked.
3. Locked users see “Symplist is in closed beta. Enter an invite code to unlock your account.” They can redeem a code, sign out, or manage/delete their account; no task, document, vault, connector, chat, or MCP access is available.
4. A valid code or an administrator's direct unlock grants beta access.
5. First-time unlocked users provide their name and optionally connect services. Connectors can be skipped. No plan screen appears.
6. Returning unlocked users go directly to the application or resume unfinished onboarding.

Keep email verification, beta access, onboarding progress, and administrative suspension as separate states. An invite does not verify an email, and OTP login does not unlock beta access. Account lookup intentionally reveals existence as requested; apply throttling and purpose-separated, expiring, single-use OTP challenges.

## Invite mechanism

See [BETA-ACCESS.md](04_beta_access.md) for generation, redemption, admin management, and usage tracking. Default to single-use codes, with optional email binding or multi-use campaigns. Codes grant continuing account access; they are not required at each login.

## Current configuration

```dotenv
BETA_ACCESS_REQUIRED=true
BILLING_ENABLED=false
PAYWALL_ENABLED=false
AI_USAGE_LIMITS_ENABLED=false
AI_ENABLED=true
AI_TELEMETRY_ENABLED=false
```

These are proposed names, not implemented settings. In this phase, startup should reject enabling payment, paywall, or plan quota flags because those modules are deferred. No Razorpay credentials, paid plans, or quota configuration are required. When future billing is implemented, plan quota enforcement must remain off whenever billing/paywall is inactive, matching the current requirement.

Invite issuance/redemption tracking remains active so administrators can manage beta access. Optional operational AI telemetry can record run success, duration, token counts, and estimated provider cost if the operator enables it. It does not assign tiers, debit credits, or gate user access. Default it off for beta; per-run time/step/output bounds and ordinary API throttling still prevent runaway execution.

## Future billing — deferred

Retain the earlier proposal only as a future design: Free without AI/chat, Pro $10 (monthly assumed), Razorpay card subscriptions, configurable weekly allowance, and audited administrator quota adjustments that preserve usage history. Do not implement or expose it in the beta flow. Live merchant capabilities, pricing interval, credit units, and policies require validation before that phase.

## Verification before beta release

Cover explicit signup consent, OTP verification without automatic beta unlock, locked-account route denial, skipped connectors, no plan/chat paywall for unlocked users, and startup without Razorpay or quota credentials. Check that both execution modes and incoming MCP enforce beta status. Invite-specific tests are in [BETA-ACCESS.md](04_beta_access.md).
