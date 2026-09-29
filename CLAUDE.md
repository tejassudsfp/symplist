# CLAUDE.md

Guidance for Claude Code (and any coding agent) working in this repository.

# Symplist

A calm, personal task workspace. Every task has one editable Markdown document with real Git history. The assistant (**Simon**) is a desktop application over this workspace, not part of it. Hosted as a free closed beta; fully self-hostable. MIT, by Tejas Parthasarathi Sudarshan.

Founding idea, and the tie-breaker for design arguments: **the most productive thing is often the most simple.**

## Direction — read `docs/notes/files/18_local_first_desktop.md` first

**The assistant is leaving the browser.** A web agent that cannot run a command is a chat window with
opinions: to do work it needs a CLI, a filesystem and a process, and a tab has none of those. So
Simon moves to a desktop app on the DeepSeek Harness, and the cloud becomes what Obsidian's sync is
— a place your data lives, not a place work happens.

Four phases: **(1)** strip chat from the cloud, **(2)** Electron shell with `dsh` over ACP, **(3)**
local SQLite mode, **(4)** local→cloud promotion. Note 18 is binding and supersedes the parts of
notes 07 and 12 that put Simon on the server.

## Status

**Released, and mid-phase-1.** Everything the cloud still owns shipped and was verified: workspace,
documents over a real Git engine, scheduling/notifications, Vault, sharing/handoffs, connection
links and incoming MCP, search, analytics/consent, access, and self-hosting. All 46 expand-only
migrations were verified live.

Phase 1 removed the agent from the server: `packages/agent`, `core/src/simon`, `core/src/ai`, the
Simon and AI contracts, the web chat feature, the api's Simon module and the `simon-run` /
`simon-chat` Trigger tasks are gone, and with them approvals, transcripts, run authority and
deployment model keys. Their tables stay — migrations are expand-only — and simply stop being
written.

New work is features, fixes, and docs — not catch-up. Verify claims with the commands below before reporting anything as passing.

## Stack (locked)

pnpm 12.4.2 workspaces · Node 24 LTS (`>=24.15.0 <25`) · TypeScript 7.0.2 (`skipLibCheck: true`) · Biome 2.5.13 · Next.js 16.3.5 / React 19.3.0 / Tailwind 4.3.3 / shadcn 4.21.0 on Base UI · NestJS 12.0.3 (ESM on Express) · Trigger.dev 4.6.0 (`runtime: "node-24"`).

- ESLint and typescript-eslint do not support TS 7 — use Biome.
- The Nest CLI refuses TS 7 — build the api with `tsc -b`.
- **Data:** Cloudflare D1 over REST only (`{batch:[{sql,params}]}`), R2 via `@aws-sdk/client-s3`. The account-wide Cloudflare limit is ~1,200 requests / 5 min, so D1 access runs in budget lanes (api 2 req/s, worker ≤1 req/s) behind a circuit breaker.
- **A D1 request on the worker lane costs about seven seconds.** `D1_BUDGET.worker` is 1 req/s for all runtimes, divided by the D1 queue family's total concurrency (7), so each task process gets 0.143 req/s after a burst of 4. Every Trigger run is its own container, so the bucket cannot be shared and the divisor cannot be dynamic. That makes **round trips, not statements, the thing to count**: D1 takes `{batch:[{sql,params}]}`, so independent reads belong in one batch. Adding a sequential read to a task is adding seven seconds to it.

## Layout

```
apps/      api (NestJS) · web (Next.js) · worker (Trigger.dev) · e2e (Playwright)
packages/  contracts config crypto db core storage email analytics search docs
           integrations testing
docs/notes/files/  18 numbered product notes (binding product decisions)
```

## Commands

Node 24 must be first on `PATH` for every shell command.

```bash
pnpm dev            # web + api + worker supervisor
pnpm lint           # biome ci — zero errors AND zero warnings
pnpm typecheck
pnpm test
pnpm build          # production web build + api build
pnpm e2e            # slowest: cold-starts web + api, 3 viewports
pnpm smoke:local
pnpm secrets:generate
```

## Executor rule — Durable vs local

> If durable, then everything on Trigger. If not, then no Trigger.

The rule outlived the thing it was written for. It arrived to keep model and tool execution out of
the api; the cloud runs neither any more (note 18), and what it governs now is the background work
the workspace still needs — Git commits, index rebuilds, reminder scans, purges, reconciliation.

- `DURABLE=true` — every background job runs as a Trigger task. The api decides that a job is due,
  records the intent and dispatches; it does not do the work itself.
- `DURABLE=false` — the api runs the same jobs in process and makes **zero** Trigger calls, needing
  no Trigger credentials. Used for local development and the Playwright harness; also the simplest
  self-hosted topology.

The dispatcher framework in `apps/api/src/infra/executors` is what makes those two paths one
implementation. It is not chat machinery and did not leave with the agent.

**Execution location and content retention are separate questions.** Trigger payloads/outputs/tags
stay ids/enums/counts only; encrypted content returns through the signed worker-to-API relay.

Trigger tasks (`apps/worker/src/trigger/`): `symplist-healthcheck`, `account-purge`, `document-git`,
`documents-maintenance`, `search-index`, `reminder-scan` (concurrency 1), `cleanup-hourly`,
`connections-reconcile`. There is no chat task: `simon-run` and `simon-chat` are gone, and with them
the `chat.agent` transcript-storage argument, the `sessions.start` / `.in` wake protocol and the
prompts-in-code rule. Anything that needs a model belongs in the desktop app.

## Secret placement (enforced by config; wrong file = refuses to boot)

With `DURABLE=true`:

| Secret | api | worker |
| --- | --- | --- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GOOGLE_VERTEX_*`, `TOGETHER_API_KEY` | **rejected** | **rejected** |
| `TRIGGER_SECRET_KEY` | yes | **platform-injected, do not set** |
| `RESEND_WEBHOOK_SECRET`, `COMPOSIO_WEBHOOK_SECRET`, `POSTHOG_PERSONAL_API_KEY` | yes | **rejected** |
| `COMPOSIO_API_KEY`, `RESEND_API_KEY`, `POSTHOG_PROJECT_KEY` | yes | yes |

## The cloud runs no models

There is no `AI_*` configuration left. `AI_ENABLED`, `AI_DEFAULT_TIER`, the `AI_FAST_*` /
`AI_SMART_*` pairs, `AI_PROVIDER_MODE`, `AI_TELEMETRY_ENABLED`, `AI_USAGE_LIMITS_ENABLED`,
`QUICK_CHAT_TTL_HOURS` and `SIMON_CHAT_SESSIONS` configured an executor that no longer exists and
were removed from `packages/config`, the env templates and `render.yaml`.

The six model credentials in the table above stay **rejected on both runtimes** rather than being
dropped from the inventory. An instance upgrading from the version that ran Simon still has them
set, and failing to boot with the variable named is how its operator learns that the assistant — and
the key it spends — moved to the desktop app. Silently ignoring a set `OPENAI_API_KEY` would leave
them believing the server was still using it.

## Hard rules

**Git**

- Never commit or push `main`, and never open a PR without being asked. Only the owner merges.
- Work on a feature or `wip/*` branch; push remote snapshots only when the owner asks.
- Commit in logical chunks with plain messages and no attribution or credit trailers.

**Secrets**

- Never commit `.env*` (the root `.env.example` and `apps/*/env.example` templates are the sole tracked exceptions and contain no real values).
- The master env lives at `.env.local` (git-ignored, mode 600), distributed by `pnpm env:distribute` into ignored mode-600 per-app `.env` files and validated with `pnpm env:check`.
- `CONTENT_KEK_1` and `VAULT_RECOVERY_KEY_1` need an offline backup. Lose the first and every encrypted field is unrecoverable; lose the second and no vault can be recovered.

**Code**

- **Migrations are expand-only.** No `DROP TABLE`, no `RENAME`, no `ALTER ... COLUMN` on an existing table — add a table or a nullable column and dual-read. `packages/db/src/migrations.test.ts` enforces this structurally; never weaken it.
- **Never weaken, skip, or delete a test to reach green**, and never add a `biome-ignore` to reach zero lint. Fix the code.
- **Inside `packages/contracts`, import `z` only from `src/common/zod.ts`.** That module configures `jitless`, which the browser needs because the CSP has no `unsafe-eval`. `zod.test.ts` fails on any contracts module importing `"zod"` directly — the fix is the import, never the test.

## Definition of done

All four, from the repo root, plus whatever the change touches:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @symplist/web build
```

Browser-touching changes also need `pnpm e2e`; docs changes need `python3 scripts/check_docs.py`. A check that did not pass is reported as not passing — never claimed.

## Brand

The mark is three rows — dots plus lines stepping down 11.0 / 7.4 / 3.8 on a 24-unit grid, 2.2 stroke, round caps. Drawn in `currentColor` so it inherits all six themes in light and dark; it never carries a colour of its own. Wordmark is lowercase. Assets live under `apps/web/src/components/brand/` and `apps/web/public/brand/`.
