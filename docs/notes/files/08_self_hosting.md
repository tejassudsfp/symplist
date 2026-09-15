# Self-hosting Symplist

Symplist is MIT licensed. This is the deployment preparation guide; application packages, migrations, and runnable setup commands do not exist yet. Do not treat this as a completed installation manual. The release must include a tested walkthrough from a clean checkout.

## Intended simplest deployment

Next.js frontend + NestJS backend + D1 via REST + R2 objects. Set `BILLING_ENABLED=false`, `PAYWALL_ENABLED=false`, `AI_USAGE_LIMITS_ENABLED=false`, and `DURABLE=false`: no Razorpay account, paid Symplist subscription, or Trigger account is required. Supply your own provider credentials for AI and Composio configuration for integrations. Email OTP uses Resend.

Set `BETA_ACCESS_REQUIRED=false` for an open self-hosted installation, or keep it true to use locally managed invite codes. Multi-user authorization and encryption remain enabled. Invite tracking is separate from optional AI telemetry; plan monitoring stays disabled when billing/paywall is off. Self-hosting changes who operates the services; it does not remove their infrastructure/API costs.

## Prepare service configuration

1. Create D1 and an R2 bucket. Store Cloudflare account/database IDs, scoped D1 REST credentials, and scoped R2 S3 credentials server-side.
2. Set up Resend with a verified sending domain, sender address, and API key for login/signup/vault-reset OTPs.
3. Configure Fast/Smart provider and model IDs and their credentials. Beta has no weekly paid quota or tier monitoring; see [ACCESS-AND-BILLING.md](03_access_and_billing.md).
4. Configure Composio and the deployment's approved connector authentication/callback settings. Users connect their own accounts during onboarding or later.
5. Generate deployment-specific auth/session, OTP-digest, content-encryption, and vault-recovery secrets using the release's documented tooling. Keep them out of Git and separate from ciphertext storage. Back up recovery material securely.
6. Configure frontend/API origins, cookies, CORS/CSRF rules, public URLs, and HTTPS. Host Nest on Render initially or another suitable Node/container host; avoid dependencies on local persistent files.
7. If enabling durable execution, configure and deploy the Trigger executor with the required secrets and storage access. Billing is deferred for beta; no Razorpay setup is required. Trigger must not be required when durable execution is off.

## Required runnable release documentation

Ship a complete `.env.example`, pinned runtime/package-manager versions, installation/build commands, D1 migration/seed commands, local development instructions, production startup/health-check settings, and Docker instructions suitable for Render and later AWS.

Include exact callback/webhook URLs, admin bootstrap instructions, invite generation/redemption and admin unlock/relock instructions, example billing-disabled and durable-disabled setups, and a smoke test covering signup, OTP, task editing, AI/MCP section reads, and vault reset. Include upgrade, rollback, export, backup/restore, secret rotation, and troubleshooting steps.

Verify that a clean self-hosted installation can use AI without Razorpay credentials and can run locally in Nest without Trigger credentials. Never publish a setup guide that depends on unpublished hosted components or shared default encryption keys.

## Git document-history runtime

The selected versioning engine is actual Git. The eventual Nest and Trigger deployment images must include the supported Git runtime, a private temporary directory, resource limits, and cleanup/recovery behavior. Store only encrypted Git bundles durably in R2; D1 tracks indexed commits and publication heads. No Git hosting subscription or agent shell is required. The tested installation guide must include Git-version verification, encryption-key setup, D1 migrations, and a commit/diff/restore smoke test. See [11_document_versioning.md](11_document_versioning.md). These are build requirements, not commands already implemented.

## Reminder deployment requirements

Configure the [reminder settings and delivery contract](15_deadlines_reminders_calendar.md), Resend sender/webhook verification, and timezone defaults. Durable deployments must deploy the reconciliation schedule and delivery tasks. Local mode requires an always-running Nest process and no Trigger credentials. Document late-delivery behavior, queue recovery, safe executor-mode switching, email suppression, and diagnostics without private contents. These remain requirements for the future runnable guide.

## Artifact sharing configuration

Add a configured HTTPS artifact origin, server-held share-digest key/version, link lifetime limits, protected password-session settings, proxy log redaction, cache bypass, and encrypted snapshot cleanup. Document [grant expiry/revocation](16_simon_handoffs_and_artifact_sharing.md) independently of cron health, plus anonymous HTML/raw smoke tests. Keep R2 private. These are build requirements, not configured live services.

## Product analytics

Use optional PostHog analytics following [note 17](17_analytics.md). Default off until configured with user opt-in; no private contents, automatic URL capture, replay, or billing dependency. No PostHog account is needed for analytics-disabled self-hosting. SDK integration remains to be built.
