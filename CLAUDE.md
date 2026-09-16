# Symplist

A calm, personal task workspace. Every task has one editable Markdown document and one persistent
AI conversation (the assistant is **Simon**). Closed beta, free for admitted users. MIT, by Tejas
Parthasarathi Sudarshan.

Founding idea, and the tie-breaker for design arguments: **the most productive thing is often the
most simple.**

---

## Status — read this first

**Last updated 2026-09-16, after a session crash mid-merge.**

| Phase | State |
| --- | --- |
| 0 · Scaffold | Done |
| A · Research | Done — `docs/build/research/` |
| B · Architecture | Done — `docs/build/architecture.md`, revised after a 56-issue review |
| C · Foundation | Done — 39/43 independent checks; 4 deferred by design |
| **D1 · Feature wave 1** | **Merged, NOT yet verified** — see below |
| D2 · Feature wave 2 | **Not started** |
| E · Integration & visual | Not started |
| F · Adversarial review | Not started |
| G · Docs, self-hosting, PR | Not started |

### Exactly where D1 stands

All four feature branches are **merged and committed** onto `feat/symplist-build`:

```
e5420c1  Close the three cross-branch items the merge had to fix
71bb464  Merge the documents feature into the D1 build branch
9557fcb  Merge the access feature into the D1 build branch
8e4807f  Merge the search feature into the D1 build branch
6533ec1  Merge the workspace feature into the D1 build branch
```

`wip/workspace`, `wip/access`, `wip/documents` and `wip/search` are each **0 commits ahead** of the
build branch — fully absorbed. Nothing was lost in the crash.

**What the crash cost:** the merge agent was on its *final full verification run before committing*
and never finished. So:

- **93 files are uncommitted**: 79 regenerated e2e evidence screenshots, 12 modified source/doc
  files, and one new file (`apps/e2e/src/helpers/identity.ts`).
- Those 12 files are real cross-feature e2e fixes (`access.spec.ts`, `search.spec.ts`,
  `shell.spec.ts`, the e2e helpers, `documents.test.ts`, `access-paused.tsx`) plus part-written
  updates to `progress.md`, `coverage.md` and `decisions.md`.
- **The merged tree has never passed a full gate run.** Treat it as unverified until it does.

### The next action

Run the gates on the merged tree, fix what fails, commit. In order:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
pnpm install
pnpm lint          # zero errors AND zero warnings
pnpm typecheck
pnpm test
pnpm build && pnpm build:web:clean
pnpm e2e           # slowest by far: cold-starts web + api, 3 viewports
node scripts/check-api-deploy.mjs
python3 scripts/check_docs.py
```

Then an independent pass that proves no branch lost work in the conflict resolutions
(`git diff feat/symplist-build...wip/<branch>` for each of the four), and only then D2.

Merge notes from all eight D1 stages, including the known conflict hotspots, were collected during
the merge — regenerate them from the stage reports if needed.

### After that

1. **D2** — Simon/executors/Composio/quick chat, scheduling/notifications/calendar, Vault,
   sharing/handoff, connections/MCP, analytics/consent. The biggest wave.
2. **E** — cross-feature E2E, visual verification at 1440/1024/390 across all six themes.
3. **F**, then **G**.

---

## Trigger.dev — what is actually wired

`DURABLE=true` is the **only** production value. `DURABLE=false` exists solely in the throwaway
local harness (`apps/e2e/src/helpers/local-api.ts`, `scripts/lib/local-api-env.mjs`), which has no
Trigger connection.

The repo is **linked to Trigger.dev**, so a push to `main` auto-deploys. No `TRIGGER_ACCESS_TOKEN`
PAT is needed, and no CI deploy job should be built — the secret matrix already marks that token
CI-only, and the GitHub integration replaces it.

**Tasks that exist today** (`apps/worker/src/trigger/`):

| Task | Machine | Queue |
| --- | --- | --- |
| `symplist-healthcheck` | micro | none (uses no D1) |
| `account-purge` | micro | `d1` |
| `document-git` | small-1x | `d1-git` |
| `documents-maintenance` | micro | `d1` |
| `search-index` | micro | `d1` |

**Tasks the architecture specifies that do NOT exist yet — all D2:**

- **`simon-run`** — the chat run. §8 and §3 define it: the api dispatcher calls
  `tasks.trigger('simon-run', { runId }, { idempotencyKey: runId })` when `DURABLE=true`, stores
  `trigger_run_id`, and never runs model or tool code in the api itself. The dispatcher, the
  `DURABLE` branch, the internal-event relay and the run-output controller are all built and tested
  in Phase C — **the task on the other end is not written.**
- `reminder-scan` (queue `reminder-scan`, concurrency 1), `cleanup-hourly`, `connections-reconcile`.

So: **Simon chat does not run on Trigger yet.** The scaffolding is correct and waiting; the task is
D2 work.

---

## Stack (locked — see architecture §1)

pnpm 12.4.2 workspaces · Node 24 LTS · TypeScript 7.0.2 (`skipLibCheck: true`) · Biome 2.5.13 ·
Next.js 16.3.5 / React 19.3.0 / Tailwind 4.3.3 / shadcn 4.21.0 on Base UI · NestJS 12.0.3 (ESM on
Express) · Trigger.dev 4.6.0 (`runtime: "node-24"`).

ESLint and typescript-eslint do not support TS 7 — use Biome. The Nest CLI refuses TS 7 — build the
api with `tsc -b`.

**Data:** Cloudflare D1 over REST only (`{batch:[{sql,params}]}`), R2 via `@aws-sdk/client-s3`.
The account-wide Cloudflare limit is ~1,200 requests / 5 min, so D1 access runs in budget lanes
(api 2 req/s, worker ≤1 req/s) behind a circuit breaker.

## Layout

```
apps/      api (NestJS) · web (Next.js) · worker (Trigger.dev) · e2e (Playwright)
packages/  contracts config crypto db core storage email analytics search docs
           integrations agent testing
docs/build/  architecture.md  decisions.md  progress.md  coverage.md  research/  reviews/
design/      mockups/ (44 screen briefs)  "UI sample/"
docs/notes/files/  17 product notes
```

`docs/build/progress.md` is the resume anchor. Read it before doing anything.

## Commands

Every shell command needs `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` first.

```bash
pnpm dev            # web + api + worker supervisor
pnpm lint           # biome ci — must be zero errors AND zero warnings
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
pnpm smoke:local
pnpm secrets:generate
```

---

## Hard rules

**Git**

- Never push. Never commit to `main`. Never open a PR without being asked. Only the owner merges.
- All work goes on `feat/symplist-build` or a `wip/*` branch.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

**Secrets**

- Never commit `.env*`, `symplist_env_and_decisions.csv`, or the original build prompt.
- The master env lives at `.env.local` (git-ignored, mode 600) and is **not** distributed into
  `apps/*/.env` yet — doing so turns on live suites that would hit real providers.
- `CONTENT_KEK_1` and `VAULT_RECOVERY_KEY_1` need an offline backup. Lose the first and every
  encrypted field is unrecoverable; lose the second and no vault can be recovered.

**Secret placement is enforced by config and differs per app.** With `DURABLE=true`:

| Secret | api | worker |
| --- | --- | --- |
| `OPENAI_API_KEY`, `AWS_*`, `GOOGLE_VERTEX_*`, `TOGETHER_API_KEY` | **rejected** | yes |
| `TRIGGER_SECRET_KEY` | yes | **platform-injected, do not set** |
| `RESEND_WEBHOOK_SECRET`, `COMPOSIO_WEBHOOK_SECRET`, `POSTHOG_PERSONAL_API_KEY` | yes | **rejected** |
| `COMPOSIO_API_KEY`, `RESEND_API_KEY`, `POSTHOG_PROJECT_KEY` | yes | yes |

Put one in the wrong file and the app refuses to boot.

**Code**

- **Migrations are expand-only.** No `DROP TABLE`, no `RENAME`, no `ALTER ... COLUMN` on an existing
  table — add a table or a nullable column and dual-read. `packages/db/src/migrations.test.ts`
  enforces this structurally; never weaken it.
- **Never weaken, skip or delete a test to reach green**, and never add a `biome-ignore` to reach
  zero lint. Fix the code.
- **Inside `packages/contracts`, import `z` only from `src/common/zod.ts`.** That module configures
  `jitless`, which the browser needs because the CSP has no `unsafe-eval`. `zod.test.ts` fails on any
  contracts module importing `"zod"` directly — the fix is the import, never the test.
- `docs/build/decisions.md` is append-only (`merge=union`). Add rows; never rewrite existing ones.

## Credentials

Verified live: **D1** (database `symplist`, 30 migrations not yet applied), **R2** (bucket
`symplist-r2`, write-tested), **Trigger** (prod key, authenticated).
Stored but untested: OpenAI, Composio, Resend.
Outstanding, not blocking: the four PostHog vars (analytics is enabled), and the two webhook signing
secrets, which the providers only issue once those endpoints exist in D2.

## Brand

The mark is three rows — dots plus lines stepping down 11.0 / 7.4 / 3.8 on a 24-unit grid, 2.2
stroke, round caps. Drawn in `currentColor` so it inherits all six themes in light and dark; it
never carries a colour of its own. Wordmark is lowercase. Assets are cut but **not yet added to
`apps/web`** — that was queued behind the merge.
