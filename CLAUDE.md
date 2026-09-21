# Symplist

A calm, personal task workspace. Every task has one editable Markdown document and one persistent
AI conversation (the assistant is **Simon**). Closed beta, free for admitted users. MIT, by Tejas
Parthasarathi Sudarshan.

Founding idea, and the tie-breaker for design arguments: **the most productive thing is often the
most simple.**

---

## Status — read this first

**Last updated 2026-09-20, after the final release-candidate audit and evidence gate.**

| Phase | State |
| --- | --- |
| 0 · Scaffold | Done |
| A · Research | Done |
| B · Architecture | Done, revised after a 56-issue review |
| C · Foundation | Done; the four deferred provider/executor checks landed in D2/E |
| D1 · Feature wave 1 | Done and verified |
| **D2 · Feature wave 2** | **Done and verified** |
| **E · Integration & visual** | **Done and verified** |
| F · Adversarial review | Done for the release candidate |
| G · Docs, self-hosting, PR | Repository work done; owner merge/publish pending |

### Exactly where D2/E stand

All D2 feature areas are merged on `feat/symplist-build`: Simon/executors/Quick Chat, scheduling and
notifications, Vault, Sharing/handoff, Connections/incoming MCP, analytics/consent and the Resend
webhook. The Trigger tasks, cross-feature browser flows, six-theme visual matrix, environment split,
live migrations and bounded provider contracts exist.

The final adversarial pass found and fixed real integration defects: Strict Mode stores that stayed
disposed after remount, artifact password navigation carrying `Origin: null`, responsive Simon
document navigation, consent mutation timing, concurrent scheduling assertions, a stale global
smoke skip and missing browser proof for Quick Chat expiry, share expiry and handoff release.
The final Playwright run passed 212 cases with 16 intentional skips across the three viewports, and
the regenerated evidence is committed as release evidence.

### Final D2/E verification

Confirmed on the merged current head: Biome checked 1,453 files with zero errors or warnings; all 17
projects typechecked; 4,767 Vitest tests and 61 script tests passed; both production builds passed;
Playwright passed 212 cases with 16 intentional skips; `pnpm smoke:local`, the API deploy check and
the documentation check passed. All 46 live D1 migrations were already applied.

Reproduce the complete release gate with:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
pnpm install --frozen-lockfile
pnpm lint          # zero errors AND zero warnings
pnpm typecheck
pnpm test
pnpm build && pnpm build:web:clean
pnpm e2e           # slowest by far: cold-starts web + api, 3 viewports
pnpm smoke:local
node scripts/check-api-deploy.mjs
python3 scripts/check_docs.py
```

D2/E and the repository-side F/G release work are complete. The owner still controls the feature-branch merge, production provider settings and post-deploy smoke.

---

## Trigger.dev — what is actually wired

`DURABLE=true` is the **only** production value. `DURABLE=false` exists solely in the throwaway
local harness (`apps/e2e/src/helpers/local-api.ts`, `scripts/lib/local-api-env.mjs`), which has no
Trigger connection.

The repo is **linked to Trigger.dev**, so a push to `main` auto-deploys. No `TRIGGER_ACCESS_TOKEN`
PAT is needed, and no CI deploy job should be built — the secret matrix already marks that token
CI-only, and the GitHub integration replaces it. Trigger runtime variables are bootstrapped and
rotated through a credentialed local CLI deploy; linked image builds intentionally receive no
runtime secrets and preserve the environment already managed by Trigger.

**Tasks that exist today** (`apps/worker/src/trigger/`):

| Task | Machine | Queue |
| --- | --- | --- |
| `symplist-healthcheck` | micro | none (uses no D1) |
| `account-purge` | micro | `d1` |
| `document-git` | small-1x | `d1-git` |
| `documents-maintenance` | micro | `d1` |
| `search-index` | micro | `d1` |
| `simon-run` | micro | `d1` |
| `reminder-scan` | micro | `reminder-scan` (concurrency 1) |
| `cleanup-hourly` | micro | `d1` |
| `connections-reconcile` | micro | `d1` |

With `DURABLE=true`, Simon model/tool work runs in `simon-run`; the API only accepts, claims and
dispatches. Trigger payloads/outputs/tags stay ids/enums/counts only, and encrypted content returns
through the signed worker-to-API relay. Trigger Sessions and `chat.agent` remain forbidden by R2.

### The executor rule (owner, 2026-09-16)

> If durable, then everything on Trigger. If not, then no Trigger.

This is already what §8 specifies and what the config enforces:

- `DURABLE=true` — **all** model and tool execution happens in `simon-run` on Trigger. The api only
  accepts the message, claims the conversation and dispatches; it never runs model or tool code, and
  it **rejects `OPENAI_API_KEY`** at boot so it cannot.
- `DURABLE=false` — the api runs the same loop in process and makes **zero** Trigger calls, needing
  no Trigger credentials. This mode exists only for local development and the Playwright harness.

**Execution location and content retention are separate questions.** Decision R2 keeps all execution
on Trigger while the *content* returns to Symplist as signed, encrypted chunks, so Trigger holds
only ids, enums and counts. **Trigger Sessions / `chat.agent` are therefore not used** — their input
and output streams would retain user messages and Simon's output in plaintext on Trigger, which
breaks §8.3 and the R12 promise that account deletion is a true crypto-shred ("Trigger holds no
content"). Note 07 originally sketched sessions but flagged "Trigger streams, logs, and provider
retention remain in the threat model"; R2 acted on that caveat. Revisiting it is a one-decision
change to R2, §8.3 and R12 — do not drift into it.

**Simon's prompts stay in code** (owner, 2026-09-16), versioned with git and changed only by deploy.
Trigger managed prompts (`prompts.define()`) are not used: prompt changes must not bypass review, and
the prompt behind any run must be recoverable from the commit.

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
docs/notes/files/  17 product notes
```



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

- Never commit or push `main`, and never open a PR without being asked. Only the owner merges.
- Push `feat/symplist-build` only when the owner explicitly asks for a remote snapshot or handoff.
- All work goes on `feat/symplist-build` or a `wip/*` branch.
- Commit in logical chunks with plain messages and no attribution or credit trailers.

**Secrets**

- Never commit `.env*`, `symplist_env_and_decisions.csv`, or the original build prompt. The root
  `.env.example` is the sole tracked `.env*` exception and contains no real values; per-runtime
  checked-in templates are named `apps/*/env.example`.
- The master env lives at `.env.local` (git-ignored, mode 600). On 2026-09-20 it was distributed
  into ignored mode-600 `apps/{api,worker,web}/.env` files and validated with `pnpm env:check`.
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

## Credentials

Verified live on 2026-09-20 without printing credentials: D1 15/15, R2 10/10, Trigger 15 passing
checks (three intentional target-control skips), OpenAI 13/13 including a real prompt-cache read,
Composio 7 passing checks (five target-capability skips), and PostHog 1/1. All 46 expand-only
migrations are present in the live D1 database (`applied: 0`, `alreadyApplied: 46`,
`outOfOrder: 0`). Resend delivery/webhook remains an honestly documented live-provider gap; the
optional-secret 404 path and signed webhook contracts are verified locally.

## Brand

The mark is three rows — dots plus lines stepping down 11.0 / 7.4 / 3.8 on a 24-unit grid, 2.2
stroke, round caps. Drawn in `currentColor` so it inherits all six themes in light and dark; it
never carries a colour of its own. Wordmark is lowercase. The component and web/PWA/social assets
live under `apps/web/src/components/brand/` and `apps/web/public/brand/`.
