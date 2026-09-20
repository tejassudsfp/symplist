# Self-hosting Symplist

This guide deploys the current Symplist application from a clean checkout. The simplest supported
setup runs the Next.js web app and the NestJS API with `DURABLE=false`; Simon and scheduled work then
run inside the always-on API process and no Trigger.dev account is required. A durable Trigger.dev
deployment is an optional second topology.

Symplist is MIT licensed, but a deployment still incurs the costs of the infrastructure and external
providers you choose. Billing, paywalls, and Symplist-managed AI quotas are not part of this release.

## 1. Know the topology

Production needs three HTTPS hosts under a domain you control:

| Purpose | Example shape | Runtime |
| --- | --- | --- |
| Web app | `https://app.example.com` | Vercel |
| API and WebSocket | `https://api.example.com` / `wss://api.example.com` | Render |
| Artifact viewer | `https://artifacts.example.com` | The same Render API service, on a different hostname |

Use sibling hosts under the same registrable domain. The API sets a host-only secure session cookie;
the browser app makes credentialed requests directly to the API. `WEB_ORIGIN`, `API_ORIGIN`,
`WS_ORIGIN`, and `ARTIFACT_ORIGIN` are exact origins: include the scheme, include a non-default port
when applicable, and do not include a path or trailing slash.

The separate artifact hostname is a security boundary, not cosmetic DNS. The API serves
`/artifact/*` only when the request host matches `ARTIFACT_ORIGIN`, and app session cookies must never
reach it. Keep the R2 bucket private; the Nest service is the only public object reader.

Vercel preview URLs are not automatically allowed by the production API. Do not point previews at
production. Give previews a separate backend and origins, or leave them without authenticated data.

## 2. Prerequisites and clean checkout

Install:

- Node.js 24 (`>=24.15.0 <25`; `.nvmrc` pins the major).
- Corepack and pnpm 12.4.2.
- Git 2.x. Git is the document-history engine, not just a source-control prerequisite.
- Python 3 for the documentation check.
- Docker only if you want to verify the production API image locally.

From the repository root:

```sh
corepack enable pnpm
corepack install --global pnpm@12.4.2
pnpm install --frozen-lockfile
node --version
pnpm --version
git --version
```

Verify the clean checkout before adding credentials:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:local
node scripts/check-api-deploy.mjs
pnpm build:web:clean
python3 scripts/check_docs.py
```

`pnpm smoke:local` boots an isolated local API and production web build, checks `/healthz`, an
unauthorized WebSocket upgrade, browser HTML, and graceful shutdown. It does not call live providers.
The full browser suite is `pnpm e2e`. Run it after a normal `pnpm build`; the clean-web build removes
workspace package outputs to prove Next can build from source, so it belongs after API-dependent
smoke/deploy checks or should be followed by another normal build.

## 3. Create and distribute configuration

The root [`.env.example`](.env.example) is the complete variable map. The authoritative per-runtime
templates are [`apps/api/env.example`](apps/api/env.example),
[`apps/worker/env.example`](apps/worker/env.example), and
[`apps/web/env.example`](apps/web/env.example). Never commit `.env.local`, any app `.env`, or a
provider credential.

1. Copy `.env.example` to the ignored `.env.local` at the repository root and immediately restrict it
   to the owner (`chmod 600 .env.local` on Unix-like systems).
2. Run `pnpm secrets:generate` in a private terminal. It prints twelve freshly generated secret
   families and does not write a file. Replace the corresponding empty family assignments in
   `.env.local`; do not paste the output into logs, chat, an issue, or shell history.
3. Set the mode, origins, provider identifiers, and credentials in `.env.local`. Empty values count
   as unset.
4. Run `pnpm env:distribute`. It validates placement, atomically writes the three ignored app `.env`
   files with mode 600, and reports names/counts only.
5. Run `pnpm env:check` whenever configuration changes.

The distributor deliberately keeps CI-only values such as `CLOUDFLARE_D1_MIGRATE_API_TOKEN` and
`TRIGGER_ACCESS_TOKEN` only in the private source file. It never writes them into an application
environment.

### Secret placement invariants

| Material | API | Trigger worker | Web |
| --- | --- | --- | --- |
| Twelve generated families | All | Only `CONTENT_KEK`, `INTERNAL_EVENT_SECRET`, and `REMINDER_UNSUBSCRIBE_SECRET` | Never |
| AI provider credential | Only when `DURABLE=false` | When durable work is deployed | Never |
| `TRIGGER_SECRET_KEY` | Only when `DURABLE=true` | Injected by Trigger.dev; never put it in `apps/worker/.env` | Never |
| D1 token | API-specific token | Separate worker token | Never |
| Webhook secrets and PostHog personal key | API only | Rejected | Never |
| `NEXT_PUBLIC_*` values | No | No | Public, compiled into the browser bundle |

The three shared secret families must have identical versions and values in the API and worker.
Different values can both pass standalone startup validation but produce ciphertext/signatures the
other runtime cannot read. Back up every version of `CONTENT_KEK` and `VAULT_RECOVERY_KEY` offline
before accepting user data. Losing either key has permanent consequences.

The web app must contain only public values. Anything named `NEXT_PUBLIC_*` is visible to every
visitor.

## 4. Run locally without Trigger.dev

Start with the defaults in `.env.example`, then make these choices in `.env.local` before distributing
it:

- `NODE_ENV=development`
- `DATA_DRIVER=local`
- `EMAIL_DRIVER=log`
- `DURABLE=false`
- `ANALYTICS_ENABLED=false`
- `BILLING_ENABLED=false`, `PAYWALL_ENABLED=false`, and `AI_USAGE_LIMITS_ENABLED=false`
- Local origins from the template: web on `localhost:3000`, API on `localhost:4000`, and artifacts on
  `127.0.0.1:4000`. The different artifact hostname is intentional.

Add the credential for the selected Fast/Smart AI provider to `.env.local` if you want Simon. With
`DURABLE=false`, the distributor places provider credentials in the API, where model and tool code
runs. Do not set `TRIGGER_SECRET_KEY` or create a Trigger project. If provider credentials are absent,
the rest of the product still boots and Simon reports that it is unavailable.

Then run:

```sh
pnpm env:distribute
pnpm env:check
pnpm dev
```

Open `http://localhost:3000`. The local driver stores SQLite plus encrypted object files under
`.local-data/` unless `LOCAL_DATA_DIR` is an absolute path. Local migrations run automatically at API
startup. `EMAIL_DRIVER=log` prints development OTP messages to the API terminal instead of sending
mail.

`pnpm dev` reads the process environment before `apps/api/.env`. A stray exported `DURABLE` or
provider variable can override the file; unset conflicting shell variables when a mode appears wrong.
The command starts Trigger development only when the API's effective `DURABLE` value is `true`.

For an open private installation, set `BETA_ACCESS_REQUIRED=false`. For an invite-gated installation,
leave it `true` and follow the administrator bootstrap below. Authorization and per-account encryption
remain active in either mode.

## 5. Provision production storage and email

### Cloudflare D1

Create one D1 database and three narrowly scoped credentials:

- an API token for `CLOUDFLARE_D1_API_TOKEN`;
- a different worker token for `CLOUDFLARE_D1_WORKER_API_TOKEN` when using Trigger.dev;
- a migration token for `CLOUDFLARE_D1_MIGRATE_API_TOKEN` in CI/operator configuration.

Set `CLOUDFLARE_ACCOUNT_ID` and `D1_DATABASE_ID`. Do not reuse one token across lanes. Symplist's D1
client enforces separate rate budgets, and migrations run sequentially.

Production startup does not apply migrations. From a prepared checkout, apply every checked-in,
expand-only migration with the private master environment explicitly loaded:

```sh
node --env-file=.env.local packages/db/src/cli/migrate.ts --driver d1
```

The runner is idempotent and records applied filenames in `d1_migrations`. There is no seed step;
the first identity is created through the normal sign-up flow. Never edit an applied migration or run
a down migration. The Render pre-deploy command repeats the same runner as a safety net:

```sh
node node_modules/@symplist/db/dist/cli/migrate.js --driver d1
```

### Cloudflare R2

Create a private R2 bucket and S3-compatible credentials scoped to that bucket. Configure
`R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`; the application derives the account
endpoint and uses region `auto`. Do not add a public R2 URL or bind the artifact hostname directly to
R2.

Cloudflare documents the [D1 REST/backup model](https://developers.cloudflare.com/d1/) and the
[R2 S3-compatible API](https://developers.cloudflare.com/r2/api/s3/api/). Symplist intentionally uses
direct REST for D1 and the S3 API for R2.

### Resend

Verify a sending domain, create a Resend API key, and set real `EMAIL_FROM_SECURITY` and
`EMAIL_FROM_REMINDERS` senders on that domain. Production requires `EMAIL_DRIVER=resend`.

`RESEND_WEBHOOK_SECRET` is optional. Without it, `/webhooks/resend` deliberately returns 404,
outbox rows stop at `accepted`, bounce/complaint suppressions are not learned automatically, and the
API logs one startup warning. Sending OTP and reminder email still requires `RESEND_API_KEY`.

## 6. Choose the production executor

### Simpler: `DURABLE=false`

Use an always-on Render instance. Configure the selected provider credential in the API and omit
Trigger credentials. Simon, document Git jobs, indexing, reminders, cleanup, and reconciliation run
inside Nest. Restart recovery is database-backed, but no work runs while the API is offline.

### Durable: `DURABLE=true`

The API receives `TRIGGER_SECRET_KEY` and `TRIGGER_PROJECT_REF` but must contain no OpenAI, Bedrock,
Vertex, or Together credential. Those credentials belong in the worker environment. Startup rejects a
provider key in the durable API so the API cannot call a model by accident.

Trigger hosts execution metadata containing IDs, enums, and counts only. Symplist does not use
Trigger Sessions or Trigger chat streams; encrypted worker-to-API output is the durable path.

### Control AI cost and prompt caching

Use a dedicated provider project and credential for Symplist. For OpenAI, configure an enforced hard
project spend limit plus lower notification thresholds in the project Limits page; an alert-only
budget does not stop requests. The provider remains the authoritative billing meter. See OpenAI's
[project controls](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform)
and [spend-limit troubleshooting](https://help.openai.com/en/articles/6614457).

The application adds these independent safety bounds:

- at most 4,096 requested output tokens per model step and 8,192 for a whole run;
- at most ten model/tool steps, one tool call per step, and no automatic model retries;
- the newest 40 conversation messages and 64 KiB of encrypted-history plaintext enter a prompt;
- provider-controlled connector results have a cumulative 96 KiB model-visible budget;
- Simon message submissions are limited to 12 per authenticated session within its client network
  per minute before D1/model work; only a one-way session digest enters the limiter key;
- Fast and Smart resolve only to the explicitly configured models; there is no silent expensive
  fallback.

OpenAI GPT-5.6 receives `prompt_cache_options` for implicit 30-minute prefix caching. Stable Simon
instructions, tools, and earlier turns can therefore be reused when a prefix is eligible; provider
cache-read and cache-write token counts are persisted as content-free run telemetry. A live contract
test repeats an eligible prefix and requires a real cache read. Symplist does not memoize completed
answers or use `previous_response_id`, because a later turn must re-check access, task revisions,
tools, and approvals. Prompt caching is provider-side and `store: false` does not disable it; review
the provider's [prompt-caching retention and pricing](https://developers.openai.com/api/docs/guides/prompt-caching)
as part of the deployment's privacy notice.

`AI_USAGE_LIMITS_ENABLED` remains `false`: free beta has no plan allowance or per-owner billing
quota. The application bounds each run and accidental request bursts; the provider hard spend limit
is the deployment-wide financial circuit breaker. Start with Fast only or point both aliases at the
lower-cost model until real cache-hit and usage telemetry justifies Smart access.

## 7. Deploy the API on Render

The repository's [`render.yaml`](render.yaml) and [`apps/api/Dockerfile`](apps/api/Dockerfile) define
the reference service. Review every public field in the Blueprint before applying it: branch, region,
plan, web/API/artifact domains, senders, executor mode, and analytics choice. Keep secrets as
`sync: false`; enter them in Render's secret UI, never in the YAML.

The reference Blueprint uses durable execution and analytics. For the simpler topology, change its
public mode to `DURABLE=false`, set `ANALYTICS_ENABLED=false` unless PostHog is configured, leave the
Trigger values unset, and add the selected AI provider credential to the Render service. For durable
mode, leave all AI provider credentials out of Render.

If configuring the service manually, use:

- Runtime: Docker.
- Repository root/build context: `.`.
- Dockerfile: `apps/api/Dockerfile`.
- Health check: `/healthz`.
- Pre-deploy command: `node node_modules/@symplist/db/dist/cli/migrate.js --driver d1`.
- Start command: leave empty so Render uses the Dockerfile `CMD`.
- Maximum shutdown delay: 60 seconds.
- Both the API and artifact custom domains attached to this one service.

Render's [Docker](https://render.com/docs/docker),
[monorepo](https://render.com/docs/monorepo-support), and
[pre-deploy](https://render.com/docs/deploys#pre-deploy-command) documentation describe these
settings. The image runs as a non-root user, includes Git and CA certificates, listens on Render's
`PORT`, and uses `tini` for signal forwarding.

Set `TRUST_PROXY_HOPS` to the measured number of trusted proxy hops in the real deployment. The
reference Render topology uses one hop. If the topology changes, verify Render's `X-Forwarded-For`
chain and update the value; guessing can weaken IP throttling or attribute every visitor to a proxy.

`/healthz` is deliberately a liveness check and does not query D1. A green health check is not a
substitute for an authenticated post-deploy smoke test.

## 8. Deploy the web app on Vercel

Create a Vercel project from the same repository and choose `apps/web` as the application root. The
checked-in [`apps/web/vercel.json`](apps/web/vercel.json) pins the workspace install/build commands and
enables Corepack. Select Node.js 24.x and confirm the first build log uses pnpm 12.4.2; Vercel explains
the [monorepo root setting](https://vercel.com/docs/monorepos) and
[Corepack package-manager selection](https://vercel.com/docs/package-managers).

In the Root Directory setting, keep **Include source files outside of the Root Directory in the Build
Step** enabled. The web package imports the repository's shared workspace packages and the install
command uses the root lockfile.

Set only:

- `NEXT_PUBLIC_API_URL` to the production API origin;
- `NEXT_PUBLIC_WS_URL` to the same host with `wss`;
- `ENABLE_EXPERIMENTAL_COREPACK=1`.

Leave `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` empty. The current browser sends
consented, allowlisted events to the first-party API relay; it does not initialize a PostHog browser
client. The public variables remain reserved for compatibility and CSP construction, not required
production configuration.

Attach the web custom domain and make its exact origin equal `WEB_ORIGIN` in the API and worker.
Redeploy after changing any `NEXT_PUBLIC_*` variable because it is compiled into the browser bundle.
Never put an API key, encryption key, webhook secret, or server token in Vercel.

## 9. Deploy the optional Trigger.dev worker

Skip this entire section when `DURABLE=false`.

1. Create a Trigger.dev project and production environment.
2. Put the production worker configuration in ignored `apps/worker/.env` by running
   `pnpm env:distribute`. Confirm `NODE_ENV=production`, `DATA_DRIVER=d1`, `EMAIL_DRIVER=resend`, and
   `DURABLE=true` before deploying.
3. Confirm the worker contains its own D1 token, the R2/Resend/Composio/provider credentials it uses,
   and exactly the three shared secret families. It must not contain API-only digest/recovery/webhook
   secrets or `TRIGGER_SECRET_KEY`.
4. Authenticate the pinned CLI with `pnpm --filter @symplist/worker exec trigger login`.
5. Export your own project ref in the private shell environment, then deploy from the repository:

   ```sh
   pnpm --filter @symplist/worker exec trigger deploy --project-ref "$TRIGGER_PROJECT_REF" --env prod
   ```

The CLI option overrides the public project ref in `trigger.config.ts`. For repository-linked
automatic deploys, replace that public ref with your own in your fork. The first deployment and
every environment change must use the credentialed CLI command above: its `syncEnvVars` extension
reads `apps/worker/.env`, validates the complete worker allowlist and syncs only permitted values.
Linked GitHub image builds receive no runtime secrets and preserve those Trigger-managed values
instead of trying to resync them. Trigger.dev injects its environment `TRIGGER_SECRET_KEY` into task
processes itself.

After deploy, confirm these schedules and queue families appear:

- `reminder-scan`: `:00`, `:15`, and `:30` UTC, queue `reminder-scan`, concurrency 1;
- `cleanup-hourly`: minute `:05` UTC;
- document maintenance: minute `:35` UTC;
- `connections-reconcile`: daily at `03:20` UTC;
- D1 work uses only the checked-in `d1`, `d1-git`, and `reminder-scan` queues.

The API's `TRIGGER_PROJECT_REF` must name the same project, and its Trigger secret must come from the
same environment. Deploying worker code is not enough; restart the API after its durable environment
has been validated.

## 10. Configure callbacks, webhooks, and MCP

Substitute the exact production origins. Paths in this table are literal:

| Provider/surface | URL | Notes |
| --- | --- | --- |
| Composio OAuth completion | `<API_ORIGIN>/v1/connections/callback` | Symplist appends a single-use attempt and nonce; enable callback identity verification in Composio |
| Composio webhook | `<API_ORIGIN>/webhooks/composio` | No `/v1`; signed with `COMPOSIO_WEBHOOK_SECRET` |
| Resend webhook | `<API_ORIGIN>/webhooks/resend` | No `/v1`; signed with `RESEND_WEBHOOK_SECRET` |
| Incoming MCP | `<API_ORIGIN>/mcp` | Bearer `sym_` key or Symplist OAuth access token; cookies are ignored |
| MCP protected-resource metadata | `<API_ORIGIN>/.well-known/oauth-protected-resource/mcp` | Resource/audience is exactly `<API_ORIGIN>/mcp` |
| OAuth authorization-server metadata | `<API_ORIGIN>/.well-known/oauth-authorization-server` | Issuer is exactly `API_ORIGIN` |
| OAuth consent UI | `<WEB_ORIGIN>/oauth/consent` | Opened from the API authorization flow |

The actual Composio callback adds `?attempt=<generated-id>&n=<generated-nonce>` to the base URL. Never
configure a fixed nonce or accept an arbitrary redirect destination.

Subscribe the Resend endpoint to exactly `email.delivered`, `email.bounced`, `email.complained`,
`email.failed`, `email.suppressed`, and `email.delivery_delayed`. Only a permanent bounce or complaint
causes Symplist suppression. Both webhook handlers verify the raw body, reject a bad signature with
400, and deduplicate provider receipt IDs.

Composio is optional. Without its API key and webhook secret, connections remain unavailable; do not
invent connector records in D1. The catalogue is fetched live and is not persisted.

The incoming MCP server is usable without Composio. OAuth access tokens last 15 minutes. MCP clients
can also use an owner-created `sym_` bearer key and grant from Settings → Agents.

## 11. Bootstrap the administrator and admission

Choose the first administrator email in `ADMIN_BOOTSTRAP_EMAIL` before that account verifies. Start
the deployment, sign up that address through the normal UI, and complete the OTP. The bootstrap runs
at startup and after OTP verification; it promotes only a verified, non-suspended, non-relocked
account and is consumed once. Remove `ADMIN_BOOTSTRAP_EMAIL` from the runtime after success and
redeploy.

If an eligible verified account already exists, build first and run the explicit CLI from the
repository root:

```sh
node --env-file=apps/api/.env apps/api/dist/modules/access/admin-bootstrap.cli.js
```

Inside the deployed Render image, use its shell and platform environment:

```sh
node dist/modules/access/admin-bootstrap.cli.js
```

Re-bootstrap after the one-time event only as a break-glass action. It requires
`--force-rebootstrap`, an accountable actor user ID, and a recorded reason.

When `BETA_ACCESS_REQUIRED=true`, the administrator creates one-time invite codes at
`/admin/invites/new`, audits them at `/admin/invites`, and unlocks/relocks accounts at
`/admin/accounts`. Codes are shown once; transfer them privately. A verified but locked user redeems
one on the access screen. `BETA_ACCESS_REQUIRED=false` admits all verified, non-suspended accounts,
but it does not bypass an explicit administrative relock.

## 12. Post-deploy smoke test

Run the automated checks against the same commit before deploying. Then verify the live deployment
without logging private content or tokens:

1. Request `<API_ORIGIN>/healthz` and the web origin over HTTPS. Confirm the web app connects to
   `wss://<api-host>/v1/ws` after sign-in.
2. Create a test identity, receive an OTP through Resend, sign in, and exercise the intended invite
   or open-admission path.
3. Create, rename, move, complete, restore, and archive a task. Refresh and reconnect; state must
   persist.
4. Edit a task's Markdown, save two revisions, inspect Changes, compare them, and restore the first.
   Run `git --version` in the Render shell and, in durable mode, confirm the Trigger build installed
   Git. No external Git host is involved.
5. Send a Simon message. If an action requires approval, verify the exact arguments and approve it
   through the approval control; a chat reply is not approval. Stop another run and confirm it does
   not continue after reconnect.
6. Set up the Vault, allow it to idle-lock, unlock it, create an item, and perform the fresh-OTP reset
   flow. Ordinary login must not unlock the Vault.
7. Create an artifact snapshot and expiring share. Open HTML and Raw Markdown in a signed-out private
   browser on the artifact host, then revoke it and confirm the same URL becomes generically
   unavailable.
8. Set the account timezone, schedule a test task for the next local top of hour, and verify the
   in-app notice and (when enabled) reminder email. Test snooze and email opt-out separately.
9. Fetch both MCP metadata documents, create a narrow MCP grant/key, read its allowed task from a
   client, and confirm another task is rejected. Revoke the grant and retry.
10. If analytics is enabled, withhold consent and confirm no events, grant consent and confirm only
    allowlisted events, then withdraw and confirm sending stops immediately.

Run `pnpm smoke:local` again after changes to the deployment scripts. `pnpm check:api-image` builds
and boots the real Docker image when Docker is available.

## 13. Feature operations

### Git document history

The durable source of document history is encrypted Git bundles/snapshots in R2 plus heads/indexes in
D1. `GIT_TMP_DIR` is only a private scratch directory. If set, it must be an absolute, writable path
with adequate space; do not back it up and do not place it on a shared public volume. Cleanup and
reconstruction are automatic. Check `git --version` first when saves or history fail.

### Reminders and cleanup

Reminders are due-date notices, not exact alarms. The scanner runs at `:00`, `:15`, and `:30` UTC so
quarter-hour-offset time zones reach their local top of hour. Notices later than
`REMINDER_MAX_LATENESS_HOURS` expire instead of surprising the user. Quiet hours, snooze, and per-user
email preferences are applied during claim/delivery.

With `DURABLE=false`, the API must remain running continuously. With `DURABLE=true`, Trigger owns the
schedules and the API must not run local copies. `REMINDERS_ENABLED=false` cancels pending reminder
work on sight; `REMINDER_EMAIL_ENABLED=false` leaves in-app notifications enabled. Inspect structured
outbox/scan events by IDs and counts only—never log titles, email bodies, or addresses.

### Artifact sharing

Share expiry and revocation are checked on every read, even if hourly cleanup is delayed. Do not put a
cache/CDN in front of `/artifact/*`, rewrite the artifact host to the web app, or expose R2. A revoked
link cannot recall a copy a recipient already downloaded.

The artifact host exposes only `GET /artifact/:id`, `GET /artifact/:id/raw`,
`POST /artifact/:id/password`, `GET /artifact/:id/public/:publicationId`, the corresponding `/raw`
route, and self-hosted fonts under `/artifact/_assets/`. The same paths on the API hostname, and
non-artifact paths on the artifact hostname, return 404.

### Analytics

Analytics is optional. Leave `ANALYTICS_ENABLED=false` and all PostHog variables empty to send
nothing and hide the consent banner. To enable it, configure the same project ingest key/host in API
and worker, and the API-only personal key plus numeric project ID needed for account-deletion
cleanup. Leave the web PostHog variables empty and redeploy the server runtimes.

Use PostHog US Cloud. The current account-deletion client targets PostHog's US management API; an EU
or self-hosted management endpoint is not configurable in this release.

The implementation uses an explicit event/property allowlist. Autocapture, automatic page/URL
collection, session replay, task/document/chat text, emails, share URLs, and Vault content remain
excluded. The browser posts allowed events to `POST /v1/analytics/events`; identity stays on the
server. User consent is still required after the operator enables PostHog.

## 14. Backup, restore, and export

These are provider/operator procedures. Symplist does not ship a backup/restore orchestrator, so
the commands below must be reviewed against the current provider documentation and rehearsed in an
isolated environment before they are used on production data.

### What must be backed up

A usable backup is a set:

1. D1 at a recorded point in time;
2. every encrypted R2 object referenced by that D1 state;
3. every versioned secret needed to unwrap or verify that data, especially `CONTENT_KEK` and
   `VAULT_RECOVERY_KEY`;
4. the deployed commit SHA and non-secret configuration.

Database-only or bucket-only recovery is incomplete. Store key backups separately from ciphertext
backups and test recovery to an isolated environment.

### Local data

Stop `pnpm dev` (and Trigger development, if used), then copy the entire resolved `LOCAL_DATA_DIR`,
including `d1.sqlite` and `objects/`, to protected backup storage. Restore only while all writers are
stopped, into an empty directory, with the exact historical key versions present. Start the API and
let the idempotent migration runner bring an older schema forward.

### Production data

Cloudflare D1 Time Travel is the short-term point-in-time mechanism; retention depends on the D1
plan. Record a bookmark with Wrangler and consult Cloudflare's current
[Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/). For
retention beyond that window, schedule D1 exports to separate protected storage.

After authenticating Wrangler and setting the non-secret database name in your shell, record the
current bookmark with:

```sh
npx wrangler d1 time-travel info "$D1_DATABASE_NAME"
```

R2 does not become a backup merely because it is durable. Copy the private bucket to a different
bucket/account or backup provider through its S3-compatible API; tools such as `rclone` can copy all
objects. Preserve object bytes and metadata, and verify counts/checksums. Do not decrypt content as
part of backup.

For a coordinated snapshot, stop new web/API writes, pause durable schedules/dispatch, wait for
active runs to settle, record the D1 bookmark/export, and complete the R2 copy before resuming. Record
the corresponding key-version inventory and commit.

Restore to a new isolated D1 database and R2 bucket from long-term exports when possible, configure
the preserved key families, run current expand-only migrations, and execute the full smoke test before
changing DNS. A D1 Time Travel restore overwrites the selected database in place and cancels in-flight
queries; use it only with an explicit recovery decision and record the pre-restore bookmark. Restore
D1 and R2 to compatible points, not independently.

The destructive provider command is:

```sh
npx wrangler d1 time-travel restore "$D1_DATABASE_NAME" --bookmark="$D1_BOOKMARK"
```

Do not run it until writers are stopped, the target and bookmark are independently verified, and a
pre-restore bookmark plus compatible R2 backup are recorded.

Symplist does not currently ship a general per-account export CLI/API. Do not promise one. Owners can
download the reviewed Markdown of released artifacts; that is not a complete account export. An
operator-level full export is the encrypted D1/R2 backup set above and should remain encrypted.

Deletion is a crypto-shred in the live application, but provider backups can retain previously
wrapped data until their retention window expires. Document that residual window in your privacy
notice.

## 15. Rotate secrets and credentials

There is no one-command bulk rewrap or secret-retirement tool. Rotation is additive:

1. Generate a fresh 32-byte base64url value with a cryptographically secure generator. Do not reuse
   `pnpm secrets:generate` output blindly for rotation because that command labels every value `_1`.
2. Add `<FAMILY>_2` while keeping `<FAMILY>_1` and leave `<FAMILY>_CURRENT=1`.
3. Distribute, validate, and deploy all readers with both versions. For a shared family, deploy the
   API and worker before changing the current version.
4. Set `<FAMILY>_CURRENT=2`, redistribute, and deploy the API before or together with the worker. Both
   still understand version 1 during the rollout.
5. Keep old versions until every stored wrap/digest/token that names them is gone or explicitly
   rewrapped and verified. Long-lived content and Vault recovery wraps mean old KEK versions may need
   indefinite retention.

To generate one rotation value without placing it in a command argument:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url") + "\n")'
```

Treat the output exactly like every other secret. For `INTERNAL_EVENT_SECRET`, first deploy both
versions to the API and worker, then switch the shared current version; this preserves verification
during a rolling deploy. Do not retire an OAuth signing/digest key merely because access JWTs are
short-lived—refresh tokens and persisted digests can outlive them.

Rotate provider credentials in their provider console, update only the permitted runtime(s), verify
the new credential, and revoke the old one last. For D1 and R2, create overlapping replacement
credentials so API and worker deployments can move independently. Never rotate an encryption family
by replacing the value under an existing version number.

## 16. Upgrade, executor changes, and rollback

Before an upgrade:

1. Record the current commit and runtime configuration names/versions; take and test a backup.
2. Keep all historical generated-secret versions.
3. Fetch the intended release into a review branch and run the clean-checkout gates from section 2.
4. Apply new migrations before new code. Migrations are expand-only and safe to repeat.
5. Deploy Trigger tasks (if used), API, and web from the same reviewed commit, then run the live smoke
   test. Do not mix production web/API contracts across unrelated commits for longer than the
   rolling-deploy window.

Changing `DURABLE` while work is active is an operator operation, not an environment-variable edit.
After `pnpm build`, run the switch CLI against the current database:

```sh
pnpm --filter @symplist/api executor:switch --to durable
pnpm --filter @symplist/api executor:switch --to local
```

Run only the command for the target mode. It advances the executor generation, interrupts old active
work, cancels Trigger runs when leaving durable mode, and rebinds pending intents. If Trigger
cancellation reports failures, rerun it before restarting. Then change `DURABLE`, move provider
credentials to the correct runtime, and restart the API. Keep the API's Trigger credential available
while switching away from durable mode so old runs can be cancelled.

In the deployed image the equivalent is:

```sh
node dist/infra/executors/executor-switch.cli.js --to local
```

Rollback code to the previous compatible commit but never reverse or delete a migration. The newer
schema remains in place. Preserve newly introduced key versions even if the old code does not create
new data with them. If rollback requires data recovery, restore the coordinated D1/R2/key set to an
isolated deployment first; do not improvise an in-place partial restore.

Trigger.dev can promote a previously built worker version with its pinned CLI, but still verify that
the version's contracts match the API commit before promotion.

## 17. Troubleshooting

| Symptom | Checks |
| --- | --- |
| Configuration fails before boot | Run `pnpm env:check`. Look for a variable in the wrong runtime, an empty required value, a reused credential, or API/worker shared-family mismatch. Errors name variables but should never print values. |
| Local mode unexpectedly starts Trigger or rejects a provider key | Remove an exported shell `DURABLE`, set `DURABLE=false` in the master file before distribution, and put the selected provider key in the API. Process variables override `.env`. |
| Durable API rejects `OPENAI_API_KEY` or another model credential | This is intentional. Remove every provider credential from Render, put it in `apps/worker/.env`, deploy Trigger, and retain only the API's Trigger secret/project ref. |
| Sign-in works at the API but not from the web app | Verify HTTPS custom domains, exact `WEB_ORIGIN`, public API/WS build variables, credentialed CORS, and that the web/API hosts share the intended site. Redeploy Vercel after public-variable changes. |
| Unsafe API call returns 403 | Browser requests need an exact `Origin` plus the session-bound CSRF header. Do not proxy authenticated API calls through Next or disable the check. |
| WebSocket never connects | Verify `NEXT_PUBLIC_WS_URL`, `WS_ORIGIN`, `wss`, proxy upgrade support, and exact web-origin allowlisting. |
| Artifact URL returns generic unavailable | Request it on the configured artifact hostname, not the API hostname; verify DNS/TLS and `ARTIFACT_ORIGIN`, then check expiry/revocation. Generic 404-style output intentionally hides whether private content exists. |
| OTP email is missing | In development, read the API console with `EMAIL_DRIVER=log`. In production, verify Resend domain/sender/API key. The webhook is delivery tracking, not the sender. |
| Reminder did not fire | Confirm an IANA timezone, top-of-hour semantics, quiet hours/snooze, max lateness, email preference, and that exactly one scheduler owner is running. Local mode requires an always-on API; durable mode requires deployed schedules. |
| Simon is unavailable | Check `AI_ENABLED`, provider/model names, and the credential in the executor runtime. In durable mode also check the Trigger project/environment and worker-to-API origin/signing family. |
| Worker output cannot decrypt/verify | Stop retries and compare the names, versions, and offline fingerprints of the three shared families. Do not print values. Restore the missing historical version instead of generating a replacement under the same number. |
| D1 returns 429 | Honor `Retry-After`; the client opens a circuit intentionally. Check that API/worker use separate scoped tokens and that no extra workers or inline Trigger queues bypass the fixed concurrency. |
| Document saves/history fail | Run `git --version`; check private temp-directory permissions/free space and R2 access. `GIT_TMP_DIR` is disposable and must not be restored as durable state. |
| Vault appears locked after login | Expected: ordinary authentication never unlocks the Vault, and idle sessions lock after the configured interval. Use the Vault passphrase or the fresh-OTP reset backed by the recovery key. |
| Consent banner is absent | Analytics is disabled unless the server flag and server-side PostHog project configuration are present. The current browser uses the first-party API relay, so public PostHog build variables should remain empty. This does not affect product functionality. |

Do not work around a failed security check by weakening cookies, CORS, CSRF, signature verification,
encryption, or runtime secret placement. The full design rationale is in
[`docs/notes/files/08_self_hosting.md`](docs/notes/files/08_self_hosting.md) and the binding details are
in [`docs/build/architecture.md`](docs/build/architecture.md).
