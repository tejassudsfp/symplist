# CLAUDE.md

Guidance for Claude Code (and any coding agent) working in this repository.

# Symplist

A calm, personal task workspace. Every task has one editable Markdown document and one persistent AI conversation (the assistant is **Simon**). Hosted as a free closed beta; fully self-hostable. MIT, by Tejas Parthasarathi Sudarshan.

Founding idea, and the tie-breaker for design arguments: **the most productive thing is often the most simple.**

## Status

**Released.** The full specification is implemented and verified: workspace, documents (real Git engine), Simon with approvals and Quick Chat, scheduling/notifications, Vault, sharing/handoffs, connections/incoming MCP, analytics/consent, and self-hosting. The release gate passed with zero lint errors, all projects typechecked, 4,767 Vitest + 61 script tests, 212 Playwright cases (16 intentional skips) across three viewports, both production builds, and the local smoke/deploy checks. All 46 expand-only migrations were verified live.

New work is features, fixes, and docs — not catch-up. Verify claims with the commands below before reporting anything as passing.

## Stack (locked)

pnpm 12.4.2 workspaces · Node 24 LTS (`>=24.15.0 <25`) · TypeScript 7.0.2 (`skipLibCheck: true`) · Biome 2.5.13 · Next.js 16.3.5 / React 19.3.0 / Tailwind 4.3.3 / shadcn 4.21.0 on Base UI · NestJS 12.0.3 (ESM on Express) · Trigger.dev 4.6.0 (`runtime: "node-24"`).

- ESLint and typescript-eslint do not support TS 7 — use Biome.
- The Nest CLI refuses TS 7 — build the api with `tsc -b`.
- **Data:** Cloudflare D1 over REST only (`{batch:[{sql,params}]}`), R2 via `@aws-sdk/client-s3`. The account-wide Cloudflare limit is ~1,200 requests / 5 min, so D1 access runs in budget lanes (api 2 req/s, worker ≤1 req/s) behind a circuit breaker.

## Layout

```
apps/      api (NestJS) · web (Next.js) · worker (Trigger.dev) · e2e (Playwright)
packages/  contracts config crypto db core storage email analytics search docs
           integrations agent testing
docs/notes/files/  17 numbered product notes (binding product decisions)
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

- `DURABLE=true` — **all** model and tool execution happens in the `simon-run` Trigger task. The api only accepts the message, claims the conversation, and dispatches; it never runs model or tool code. It used to prove that by rejecting `OPENAI_API_KEY` at boot; model keys are now per account (see BYOK below), so **no** runtime holds one and that variable is refused everywhere.
- `DURABLE=false` — the api runs the same loop in process and makes **zero** Trigger calls, needing no Trigger credentials. Used for local development and the Playwright harness; also the simplest self-hosted topology.

**Execution location and content retention are separate questions.** Trigger payloads/outputs/tags stay ids/enums/counts only; encrypted content returns through the signed worker-to-API relay.

**`chat.agent` is allowed, under three conditions that are the whole reason it is allowed.** It was previously forbidden outright, because its default persistence writes the accumulated conversation to Trigger's own object storage after every turn — plaintext, overwritten rather than expired, and outside the account-deletion crypto-shred promise. Registering a transcript storage replaces that write entirely, so:

1. **A transcript storage is mandatory.** `simon-chat` stores the conversation in D1 under the account data key (`chat_transcript_messages`, `chat_transcript_state`), and the Simon purge contributor deletes both. `purge-coverage.test.ts` fails if any owner-scoped table is left uncovered.
2. **Approvals stay ours.** A connector action is gated by an `approvals` row bound to exact arguments, connection and expiry, one pending per run. That row is the authorization; the gate is never delegated to Trigger's human-in-the-loop mechanism.
3. **Delivery stays Nest.** Chunks reach the browser through the signed relay. Direct Trigger-to-browser streaming remains an evaluated alternative (note 07), not the route.

What still rests on Trigger is the session's `.in` / `.out` streams, which carry turn content in plaintext for the platform's realtime retention window. That is a narrowing of the at-rest promise and is deliberate; it is not the unbounded snapshot the original prohibition was about. Do not remove the transcript storage to "simplify" the agent — that single change reinstates the snapshot.

**Simon's prompts stay in code**, versioned with git and changed only by deploy. Trigger managed prompts are not used: prompt changes must not bypass review, and the prompt behind any run must be recoverable from the commit.

Trigger tasks (`apps/worker/src/trigger/`): `symplist-healthcheck`, `account-purge`, `document-git`, `documents-maintenance`, `search-index`, `simon-run`, `simon-chat` (durable chat session), `reminder-scan` (concurrency 1), `cleanup-hourly`, `connections-reconcile`.

## Secret placement (enforced by config; wrong file = refuses to boot)

With `DURABLE=true`:

| Secret | api | worker |
| --- | --- | --- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GOOGLE_VERTEX_*`, `TOGETHER_API_KEY` | **rejected** | **rejected** |
| `TRIGGER_SECRET_KEY` | yes | **platform-injected, do not set** |
| `RESEND_WEBHOOK_SECRET`, `COMPOSIO_WEBHOOK_SECRET`, `POSTHOG_PERSONAL_API_KEY` | yes | **rejected** |
| `COMPOSIO_API_KEY`, `RESEND_API_KEY`, `POSTHOG_PROJECT_KEY` | yes | yes |

## Model access is bring-your-own-key

Simon runs on the **account's** provider key, not the deployment's. An account stores its own OpenAI
and/or Anthropic key in Settings → Models; it is a `sym1` envelope under that account's data key,
bound to its provider, decrypted only in the executor about to call the provider, and never returned
by any route. There is no server-side fallback: an account without a key is told to add one.

- Providers are **OpenAI and Anthropic only**. Bedrock, Vertex and Together were removed with the
  environment credentials that configured them.
- `AI_FAST_PROVIDER` / `AI_FAST_MODEL` / `AI_SMART_*` remain, as the **defaults** a tier falls back
  to until an account chooses its own. They configure model ids, never credentials.
- The suggested model ids in `packages/core/src/ai/service.ts` are a convenience, not an allowlist —
  a typed id is accepted, so a new model works without a deploy.
- Storage is `ai_provider_keys` and `ai_model_choices` (migration `1100`), both covered by the AI
  purge contributor. Never add a column holding any part of a key, including a last-four hint.
- `verified_at` answers "has this key ever worked", not "when was it last used". Only the provider
  can say a key is live, so it is set from a real accepted call and written **once** — re-stamping
  it every turn would spend a D1 write per model call. Replacing a key clears it.
- A run that stops for want of a key ends `ai.key_required`, not `ai.provider_failed`. It travels
  intact to the browser, which offers the way to Settings → Models instead of a Retry that can only
  fail again. Keep the three AI outcomes distinct: the deployment cannot run models
  (`ai.unavailable`), this account has no key (`ai.key_required`), something broke
  (`ai.provider_failed`).

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
