# What each remaining phase needs

Written 2026-09-16, the day Phase D1 was merged and verified; completion status updated
2026-09-20. Companion to
[progress.md](progress.md) (the checkpoint), [architecture.md](architecture.md) (binding design)
and [decisions.md](decisions.md) (numbered rulings that override instinct).

**Done so far:** phases 0 through F, plus every repository-side Phase G deliverable. The requirements
below remain the audit trail; exact current-head gate results live in [progress.md](progress.md).

**Left:** the owner-controlled merge/publish and post-deploy smoke boundary.

---

## Phase D2 — feature wave 2

**Status: Done.** Every feature area, screen, task registration and carried Phase C contract listed
below is integrated. Completed release evidence and current-head repository checks are recorded in
[progress.md](progress.md) and [coverage.md](coverage.md).

At the 2026-09-16 D1 checkpoint, every area below was a **seam only** — between 4 and 36 lines per
feature, against 34–72 files each for the D1 features. This table is the pre-D2 baseline, not the
current implementation state.

| Feature | web | api | core |
| --- | --- | --- | --- |
| `simon` | 3 files / 36 lines | 1 | 1 |
| `scheduling` | 3 / 27 | 1 | 1 |
| `vault` | 2 / 13 | 1 | 1 |
| `sharing` | 1 / 4 | 1 | 1 |
| `connections` | 1 / 4 | 1 | 1 |
| `analytics` | 2 / 13 | 1 | 1 |

### D2a · Simon, executors and quick chat — architecture §8

The centrepiece, and the largest single piece of work in D2.

- **`simon-run` Trigger task.** Machine `micro`, queue `d1`. The api dispatcher calls
  `tasks.trigger('simon-run', { runId }, { idempotencyKey: runId })`, the reconciler polls it and the
  registered task starts with a conditional claim
  (`queued` → `running` at the current executor generation); a failed claim exits as a no-op.
- **The owner's executor rule**: if durable, everything on Trigger; if not, no Trigger. Already
  enforced — the api rejects `OPENAI_API_KEY` when `DURABLE=true`, so it cannot call a model.
- **Approvals are Symplist-owned, not the AI SDK's.** `parallelToolCalls: false`, at most one
  approval-requiring action per `execute_tools`, the run ends `awaiting_approval`, and a
  *continuation run* performs the action. Approval binds to exact tool arguments, user, account and
  expiry. A chat reply is never an approval.
- **`user_ask`** is answered only through `POST /v1/user-asks/:id/answer` or dismissed through
  `/dismiss`, each one conditional update verified by write id so exactly one takes effect.
- **Git never runs inside `simon-run`** (decision R6). Document tools call `document-git` through
  `triggerAndWait` with an ids-only payload; input and output travel as encrypted R2 job objects.
  This is why `document-git` has its own `d1-git` queue — `simon-run` must never hold the slot its
  own child needs.
- **§8.3 Trigger hygiene.** Payloads, outputs, metadata and tags carry only ids, enums and counts.
  Marker-string tests prove no plaintext reaches a Trigger-hosted sink.
  `TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0`. No Trigger Sessions, no `chat.agent`, no `AgentChat` —
  see the R2 note in [CLAUDE.md](../../CLAUDE.md).
- **Quick chat**: task-less conversation from the bottom-right button, shown only when no task is
  selected, opening from the button itself and full-screen on mobile. Temporary — deleted on close,
  24-hour expiry (`QUICK_CHAT_TTL_HOURS`). "Save as task" converts it. Scope is "workspace helper".
- **Meta tools** (note 12) operate behind the interface: show concise human-readable activity
  ("Reading Requirements"), never a meta-tool dashboard or hidden chain-of-thought.
- Briefs: `task_chat`, `agent_approval`, `agent_connections`, `system_states`.

### D2b · Scheduling, notifications and calendar — architecture §12

- **`reminder-scan`** on its own queue (concurrency 1, so sweeps never overlap). Scans at
  **:00, :15 and :30 UTC** — the quarter-hour offsets exist because UTC+5:45, +8:45 and +12:45 zones
  need :15 to hit their local top of the hour (decision D3). Getting this to `:45` is the bug that
  was caught in review; don't reintroduce it.
- **Reminders are due-date notices, not alarms** — they fire at the top of the hour in local time.
- D1 due queue and outbox, conditional leases with fencing tokens, bounded batches, delivery in
  process (no per-occurrence child runs, so the D1 queue family stays fixed).
  `REMINDERS_ENABLED=false` cancels pending work on sight.
- **`cleanup-hourly`** and the outbox reconciliation.
- Email through Resend with `REMINDER_UNSUBSCRIBE_SECRET`.
- Briefs: `task_schedule`, `notifications`, `settings_notifications`, `calendar`,
  `transactional_emails`.

### D2c · Vault — architecture §11

- Argon2id passphrase derivation (via `crypto.argon2`, 2-slot semaphore), wrapped random data keys
  — never the plaintext custom key.
- **Service-managed recovery**: a fresh Resend OTP authorizes a new key while preserving contents.
  Never claim "only you can decrypt this" — the service *can* recover the vault data key, and the
  briefs are explicit that this must not be over-promised.
- Vault session: 32-byte token in `__Host-sym_vault` (Secure, HttpOnly, SameSite=Strict, Path=/),
  vault key re-wrapped under `HKDF(token, …)`, 5-minute idle lock (`VAULT_IDLE_LOCK_MINUTES`).
  Ordinary login does not unlock the vault. **The Vault never enters the search index.**
- Briefs: `vault_setup`, `vault_unlock`, `vault_items`, `vault_item_editor`, `vault_reset`.

### D2d · Sharing and handoff — architecture §13

- Artifact share links and grants, served from `ARTIFACT_ORIGIN` (a **different hostname** from the
  web origin — that separation is load-bearing for the CSP).
- Share digest and share-session digest secret families are already generated.
- **This unblocks D1's deliberate gap**: `apps/web/src/features/documents/artifact-surface.ts` is
  the seam the documents feature left for exactly this. The artifact viewer, the share-creation
  dialog and the grant list were left unbuilt in D1 because their contracts and these routes did not
  exist. D2 filled that seam rather than building a parallel surface.
- Briefs: `artifact_share`, `artifact_shares`, `artifact_viewer`, `handoff`.

### D2e · Connections and incoming MCP — architecture §14

- **Composio shared/managed OAuth**, with **all** connectors fetched live on demand and never
  stored. Switching to own-OAuth later forces every user to reconnect — decided, and recorded.
- `POST /webhooks/composio` (note: **no `/v1` prefix** — `global-prefix.ts` exempts `webhooks`),
  verified with `composio.triggers.parse` on the raw body, deduplicated on `webhook-id` in
  `webhook_receipts` inside the same batch as its effect. Maps
  `composio.connected_account.expired` to Needs attention.
- **`connections-reconcile`** Trigger task on the `d1` queue.
- **Incoming MCP server at `/mcp`**: OAuth 2.1 (issuer = `API_ORIGIN`, audience = `API_ORIGIN/mcp`,
  15-minute JWTs) plus `sym_` bearer keys. Signing-key and token-digest secret families already
  exist.
- Briefs: `connections`, `agent_connections`, `onboarding_connections`.

### D2f · Analytics and consent — architecture §15

- PostHog **US** cloud. The cookie consent banner is **mandatory**.
- Event allowlist and property schemas from note 17, plus `quick_chat_started` and
  `quick_chat_saved`. `analytics_id` is a random id, never derived from identity, never exposed in
  responses or logs (decision R9).
- The four PostHog variables are present in the ignored live environment, and the bounded live
  PostHog contract passed 1/1 without private content.

### D2g · Resend webhook — decision R14, architecture §12.5

- `POST /webhooks/resend` (again, no `/v1`). Verified with `resend.webhooks.verify` on the raw body,
  rejects failures with 400 **without logging the body**, records `svix-id` in `webhook_receipts`.
- Subscribe to exactly six events: `email.delivered`, `email.bounced`, `email.complained`,
  `email.failed`, `email.suppressed`, `email.delivery_delayed`. Only a **permanent** bounce or a
  complaint adds a suppression.
- `RESEND_WEBHOOK_SECRET` is **optional**. Unset, the route returns 404, outbox rows stop at
  `accepted`, no automatic suppressions are added, and startup logs one warning.

### Also carried into D2 (deferred from Phase C)

- AI provider and Composio wrapper **contract suites**.
- **Per-endpoint one-time secret scans** (§6.1).
- The **Simon Trigger marker-string test** (§8.3).
- The **D1 load test** (§3.1) — D2 or E.

### D2 is done when

Every brief above has a screen and component tests; `simon-run`, `reminder-scan`,
`cleanup-hourly` and `connections-reconcile` are registered with the right machines and queues; the
marker-string test proves no plaintext reaches Trigger; and the full gate set is green.

---

## Phase E — integration, end-to-end and visual

**Status: Done.** The 20-flow ledger, both-executor contracts, restart/no-replay proof, D1 load
contract, 36-frame theme/mode/viewport matrix, environment placement, 46 live migrations and the
required bounded live suites are recorded in [coverage.md](coverage.md). A browser against the
deployed durable stack remains a publish smoke boundary, not a substitute for executor parity.

Cross-feature work that only makes sense once D2 exists.

- **The 20 flows in [coverage.md](coverage.md)**, end to end, not per-feature.
- **Executor parity.** Note 07 is explicit: run the same chat, tool and document contract tests
  under **both** executors, and verify that durable mode makes **no** model or tool calls in Nest
  and local mode makes **no** Trigger calls. Also: locked-account and cross-user rejection, page-edit
  conflicts, duplicate message submission, disconnect and replay without duplicate output, stop and
  approval flows, restart during a side effect, and an environment mode change with active work.
- **Visual verification at 1440 / 1024 / 390** across all six themes in light and dark. D1 captured
  evidence at studio/light only (plus one meadow/dark appearance journey); Phase E added, reran and
  inspected all 36 populated-list theme × mode × viewport frames.
- **The D1 load test** (§3.1) if it has not already landed in D2.
- **Live suites** against the real providers — D1, R2, Trigger, OpenAI, Composio, PostHog. All six
  required bounded suites passed with credentials on 2026-09-20; they still skip deliberately when
  credentials are absent.
- **Distribute `.env.local` into `apps/*/.env`** along the secret-placement matrix in
  [CLAUDE.md](../../CLAUDE.md). Distribution and `pnpm env:check` are complete: the durable api
  rejects `OPENAI_API_KEY`, the worker does not carry `TRIGGER_SECRET_KEY`, shared families match and
  all three ignored runtime files are mode 600.
- **Apply the migrations** to the live D1 database. The current tree has 46 expand-only migrations;
  the live run reported `applied: 0`, `alreadyApplied: 46`, `outOfOrder: 0`.

---

## Phase F — adversarial review

**Status: Done for this release candidate.** Independent backend, frontend, cost/privacy,
self-hosting and final-release passes read the integrated diff and fixed the defects they found.
The findings, fixes and exact release gates are recorded in
[the release audit](reports/f-release-audit.md).

The pattern that paid for itself in D1: a reviewer that reads the whole diff, hunts real defects,
**fixes them**, and returns a verdict. In D1 this caught a task tree with no tab stop at all, a
parent-complete that silently archived every subtask, a statement binding 101 parameters against
D1's 100 limit, and an unpruned detail map that fired ~60 concurrent reads at a 2 req/s lane.

Dimensions worth a pass each:

- **Correctness** — races, stale closures, wrong state transitions, unhandled rejections.
- **Security** — the §5 CSRF matrix, authorization that trusts client input, XSS through user
  content, secrets or plaintext in logs. `/security-review` covers part of this.
- **Encryption** — anything stored or sent without an envelope where §4 requires one; AAD that is
  not frozen; key material held longer than needed. Note the one known deviation already recorded:
  preference envelopes for the `panels` group carry `"t":"user_preferences"` in their AAD while the
  ciphertext lives in `user_preferences_panels`.
- **D1 budget (§3)** — unbatched queries in loops, unbounded reads, missing `LIMIT`, requests
  exceeding their lane. Two known items are already logged: the archive members read silently caps a
  group at 50 with no `truncated` flag, and `GET /v1/tasks` had no pagination before the merge fixed
  the schema.
- **Idempotency (§6)** — a recorded success with no access condition; a claim folded before its
  effect.
- **Accessibility and brief fidelity** — focus order, keyboard reachability, and the empty, error
  and loading states each brief specifies.
- **Tests that assert nothing**, are skipped, or were weakened to pass.

---

## Phase G — documentation, self-hosting and the pull request

**Status: repository work done; owner merge/publish pending.** The runnable guide, deployment
configuration, CI migration job, brand assets, README, About screen, updated specifications and
release evidence are committed on `feat/symplist-build`. The standing rule forbids this builder from
opening or merging the pull request; the owner performs that final external action and the
post-deploy smoke.

- **Self-hosting guide** from note 08 — the whole point of the MIT licence.
- **Deploy configuration**: Vercel (web) and Render (api, basic paid always-on). Domains
  `symplist.tejassuds.com` and `api.symplist.tejassuds.com`, with `/mcp` supporting OAuth 2.1 and
  bearer tokens.
- **CI**: add the `migrate` job. **Do not build a `deploy-trigger` job** — the repo is linked to
  Trigger.dev, so a push to `main` auto-deploys, and `TRIGGER_ACCESS_TOKEN` is marked CI-only in the
  secret matrix precisely for a job that is no longer needed.
- **Brand assets into `apps/web`**: `app/icon.svg`, `apple-icon.png`, manifest entries, and the
  `SymplistLogo` lockup in the shell and sign-in screens. The mark is cut and waiting.
- **README and the About screen** — MIT, by Tejas Parthasarathi Sudarshan, `tejassuds.com`.
  Attribution belongs in About and the footer, never as a workspace watermark.
- **Spec updates** so architecture and decisions match what was actually built.
- **The pull request** into `main` — which is also what triggers the Trigger.dev deploy. Only the
  owner merges it.

---

## Standing rules for every phase

The full set is in [CLAUDE.md](../../CLAUDE.md) and [AGENTS.md](../../AGENTS.md). The four that get
violated most:

1. **Migrations are expand-only.** No `DROP TABLE`, `RENAME` or `ALTER ... COLUMN`. A structural
   test enforces it.
2. **Never weaken a test to reach green**, and never add a `biome-ignore` to reach zero lint.
3. **Inside `packages/contracts`, import `z` only from `src/common/zod.ts`** — the browser CSP has
   no `unsafe-eval`, so that module's `jitless` configuration must load first.
4. **`decisions.md` is append-only** (`merge=union`). Add rows; never rewrite them.
