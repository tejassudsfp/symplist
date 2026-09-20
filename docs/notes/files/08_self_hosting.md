# Self-hosting Symplist

Symplist is MIT licensed and ships as a runnable monorepo. The maintained installation and
operations manual is the root [self-hosting guide](../../../SELF_HOSTING.md); this note records the
product requirements that guide implements.

## Simplest deployment

The smallest installation runs the Next.js frontend and NestJS API with local SQLite/filesystem
drivers, console OTP delivery and `DURABLE=false`. It requires no Cloudflare, Resend, Trigger,
Composio, PostHog or Symplist billing account. Simon still needs one configured model provider.

Production uses the same application with Cloudflare D1 and private R2 storage. The checked-in
deployment defaults place the web app on Vercel, the API and isolated artifact hostname on one
always-on Render service, and durable background/model execution on Trigger.dev. Other Node and
container hosts remain supported when they preserve the documented hostname, proxy, TLS, storage,
queue and shutdown contracts.

`BILLING_ENABLED=false`, `PAYWALL_ENABLED=false` and `AI_USAGE_LIMITS_ENABLED=false` are binding for
the free beta. Self-hosting changes who operates the services; it does not eliminate provider or
infrastructure charges. Operators should use a dedicated AI-provider project with an enforced hard
spend limit in addition to Symplist's per-run output, history, step, connector-result and request
burst bounds.

## Configuration and operations

The release includes:

- pinned Node and pnpm versions, a frozen lockfile and clean-checkout install/build commands;
- `.env.example` plus separate API, worker and web templates with enforced secret placement;
- local development and production startup commands, Docker configuration and `/healthz` liveness;
- expand-only D1 migrations, an idempotent migration runner and a main-branch migration CI job;
- exact Resend, Composio, MCP and artifact callback/webhook paths;
- admin bootstrap, invite, relock and executor-mode-switch procedures;
- local smoke, deployment validation, browser, provider-contract and troubleshooting commands;
- backup/restore, upgrade/rollback and versioned-secret operational guidance.

Backup and restore are provider/operator procedures. Symplist does not ship a backup orchestrator,
an account-wide export endpoint, down migrations or a production bulk-rewrap command. A local
backup must consistently capture both `d1.sqlite` and the object directory while writers are
stopped. A production backup must cover D1 and R2 together. Code rollback must remain compatible
with the forward schema. Old content and Vault recovery key versions must remain configured until
all material has been rewrapped by a future supported facility.

## Git document history

Document versioning uses a hermetic Git runtime. API and worker images include Git, use private
bounded temporary workspaces and store only encrypted bundles in private object storage. D1 tracks
publication heads and indexed commits. No Git hosting subscription or agent shell is required.
Startup and hourly maintenance check the executable and remove bounded stale/orphan state.

## Reminders and executor mode

Local mode runs reminders, cleanup and document maintenance in the always-on API and makes no
Trigger calls. Durable mode disables those local jobs and runs the registered Trigger schedules:
reminders at `:00`, `:15` and `:30` UTC, cleanup at `:05`, and document maintenance at `:35`.
Changing mode requires the generation-safe executor switch command before restart; flipping the
environment variable alone is not supported.

Resend is optional. When its webhook secret is absent, `/webhooks/resend` returns 404 and accepted
outbox rows remain at that state. When configured, webhook signatures and receipt ids are verified
before the six supported delivery events are processed.

## Artifact sharing

Production requires an HTTPS `ARTIFACT_ORIGIN` on a hostname distinct from both the web and API
hosts. It serves only `/artifact/*`, receives no application cookies and uses restrictive CSP,
referrer, cache and indexing headers. R2 remains private; grants, password sessions, expiry,
revocation and orphan cleanup are enforced by the API.

## Analytics and privacy

Analytics is optional and defaults off. The browser has no PostHog SDK: after consent it sends only
schema-allowlisted events to the first-party API relay. API and worker capture are server-side,
re-check consent and become no-ops when disabled or unconfigured. Private content, arbitrary URLs,
identity-derived analytics ids, session replay and automatic capture are forbidden.

Stored product content is encrypted, but this is not a blanket end-to-end-encryption claim. Model,
email and integration providers receive the plaintext required for requested work under their own
retention policies. Vault recovery is service-managed and must never be described as inaccessible
to the service.

## Release boundary

The repository contains the application, 46 expand-only migrations, Vercel/Render/Trigger
configuration, runnable operations guide and automated gates. Publishing still requires the owner
to configure provider projects, secrets, domains, spend limits and backups; merge the reviewed
feature branch; and run the post-deploy durable/API/artifact/MCP smoke checks. No shared default
secret or unpublished hosted component is required.
