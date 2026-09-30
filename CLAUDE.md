# CLAUDE.md

Guidance for Claude Code (and any coding agent) working in this repository.

# Symplist

A calm, personal task workspace. Every task has one editable Markdown document with real Git history. **Symplist publishes its tools over MCP and runs no agent** — the assistant is whichever MCP client you already use. Hosted as a free closed beta; fully self-hostable. MIT, by Tejas Parthasarathi Sudarshan.

Founding idea, and the tie-breaker for design arguments: **the most productive thing is often the most simple.**

## Direction — read `docs/notes/files/18_local_first_desktop.md` first

**Symplist is a list, and the assistant is not ours.** A web agent that cannot run a command is a
chat window with opinions — but the answer was never to ship our own agent. Claude Code *is* the CLI.
So the api publishes 20 tools over `/mcp` with the full OAuth flow, and the person points the client
they already use at Symplist: it gets the task document, the section editor and search, plus their
real shell in their real repository. We never hold a model key.

An embedded agent (`dsh` over ACP, in Electron) was built and deleted. It cost a 258MB vendored tree,
an RC dependency, and a screen asking people to paste an OpenAI key into our app — for something
strictly less capable than the client they already had open.

**Two modes, no third:** cloud mode is the list everywhere (web + desktop, one account, MCP over
OAuth); local mode is the list fully offline (local SQLite, no account, MCP over stdio).

Phases: **(1)** strip chat from the cloud — done. **(2)** desktop shell — done. **(3)** local mode —
next, and the reason `apps/desktop` exists. **(4)** local→cloud promotion. Note 18 is binding and
supersedes the parts of notes 01, 07 and 12 that put Simon on the server, plus note 14's connectors.
Note 19 specifies labels.

## Status

**Released; phases 1 and 2 done.** Everything the cloud owns shipped and was verified: workspace,
labels, documents over a real Git engine, scheduling/notifications, Vault, sharing, search, the MCP
endpoint with OAuth, analytics/consent, access, and self-hosting. All 51 expand-only migrations were
verified live. `apps/desktop` installs as a DMG, signs in and shows the workspace.

**Admission stays closed.** `BETA_ACCESS_REQUIRED` defaults to true and the hosted launch is invite
only; opening it is a deliberate decision, not a default to drift into.

Three removals, all of them deliberate, all of them leaving their tables behind because migrations
are expand-only:

- **The cloud agent** — `packages/agent`, `core/src/simon`, `core/src/ai`, the web chat feature, the
  api's Simon module, `simon-run` / `simon-chat`, approvals, transcripts, run authority, BYOK.
- **The desktop agent** — `desktop/main/harness` (`dsh` over ACP), the loopback MCP relay, the local
  transcript store, the device keychain for model keys, `vendor-harness.mjs`.
- **The connector layer** — `packages/integrations`, `core/src/connections`, the connector screens,
  `connections-reconcile`, the `integration.*` errors. Its executor had been dead code since the
  cloud agent left. The feature that survives under that name is MCP, and is called `mcp` now.

New work is features, fixes, and docs — not catch-up. Verify claims with the commands below before reporting anything as passing.

## Stack (locked)

pnpm 12.4.2 workspaces · Node 24 LTS (`>=24.15.0 <25`) · TypeScript 7.0.2 (`skipLibCheck: true`) · Biome 2.5.13 · Next.js 16.3.5 / React 19.3.0 / Tailwind 4.3.3 / shadcn 4.21.0 on Base UI · NestJS 12.0.3 (ESM on Express) · Trigger.dev 4.6.0 (`runtime: "node-24"`).

- ESLint and typescript-eslint do not support TS 7 — use Biome.
- The Nest CLI refuses TS 7 — build the api with `tsc -b`.
- **Data:** Cloudflare D1 over REST only (`{batch:[{sql,params}]}`), R2 via `@aws-sdk/client-s3`. The account-wide Cloudflare limit is ~1,200 requests / 5 min, so D1 access runs in budget lanes (api 2 req/s, worker ≤1 req/s) behind a circuit breaker.
- **A D1 request on the worker lane costs about seven seconds.** `D1_BUDGET.worker` is 1 req/s for all runtimes, divided by the D1 queue family's total concurrency (7), so each task process gets 0.143 req/s after a burst of 4. Every Trigger run is its own container, so the bucket cannot be shared and the divisor cannot be dynamic. That makes **round trips, not statements, the thing to count**: D1 takes `{batch:[{sql,params}]}`, so independent reads belong in one batch. Adding a sequential read to a task is adding seven seconds to it.

## Layout

```
apps/      api (NestJS) · web (Next.js) · worker (Trigger.dev) · desktop (Electron) · e2e (Playwright)
packages/  contracts config crypto db core storage email analytics search docs testing
docs/notes/files/  18 numbered product notes (binding product decisions)
```

`apps/desktop` is an Electron shell and nothing more: a window, the staged Next server, and the cloud
session held in main so the renderer holds no token. It hosts no agent. Local mode (phase 3) is what
it is for.

The MCP endpoint is in `apps/api/src/modules/mcp/` — 20 tools (16 in `mcp-tools.ts`, 4 contributed by
features through `mcp-extensions.ts`), grants, and the OAuth flow (dynamic client registration,
authorize, consent). It is how an assistant reaches Symplist and the only way.

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
`documents-maintenance`, `search-index`, `reminder-scan` (concurrency 1), `cleanup-hourly`. There is no
chat task and no connector task: `simon-run`, `simon-chat` and `connections-reconcile` are gone, and
with them the `chat.agent` transcript-storage argument, the `sessions.start` / `.in` wake protocol and
the prompts-in-code rule. **Nothing here runs a model, and nothing here can.**

## Secret placement (enforced by config; wrong file = refuses to boot)

With `DURABLE=true`:

| Secret | api | worker |
| --- | --- | --- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GOOGLE_VERTEX_*`, `TOGETHER_API_KEY` | **rejected** | **rejected** |
| `TRIGGER_SECRET_KEY` | yes | **platform-injected, do not set** |
| `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SECRET` | **rejected** | **rejected** |
| `RESEND_WEBHOOK_SECRET`, `POSTHOG_PERSONAL_API_KEY` | yes | **rejected** |
| `RESEND_API_KEY`, `POSTHOG_PROJECT_KEY` | yes | yes |

## Nothing here runs a model, and nothing here calls a connector

There is no `AI_*` configuration left. `AI_ENABLED`, `AI_DEFAULT_TIER`, the `AI_FAST_*` /
`AI_SMART_*` pairs, `AI_PROVIDER_MODE`, `AI_TELEMETRY_ENABLED`, `AI_USAGE_LIMITS_ENABLED`,
`QUICK_CHAT_TTL_HOURS` and `SIMON_CHAT_SESSIONS` configured an executor that no longer exists.
`LIVE_COMPOSIO` and `LIVE_OPENAI` named live suites that no longer exist. All of them were removed
from `packages/config`, the env templates and `render.yaml`.

The eight credentials marked rejected in the table above stay **in the inventory** rather than being
dropped from it. An instance upgrading from a version that ran the assistant, or that had connectors,
still has them set — and failing to boot with the variable named is how its operator learns the
assistant moved to their own MCP client and the connectors went with it. Silently ignoring a set
`OPENAI_API_KEY` or `COMPOSIO_API_KEY` would leave them believing the server was still spending it.

The model key is now the sharpest version of this: it is not in D1, and it is not in a device keychain
either. The client that calls the provider holds it. That stops being a property we enforce and becomes
one we cannot violate.

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
