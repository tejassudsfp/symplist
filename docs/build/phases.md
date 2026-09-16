# What each remaining phase needs

Written 2026-09-16, the day Phase D1 was merged and verified. Companion to
[progress.md](progress.md) (the checkpoint), [architecture.md](architecture.md) (binding design)
and [decisions.md](decisions.md) (numbered rulings that override instinct).

**Done so far:** phases 0, A, B, C and D1. The build branch is one clean checkout, every gate green:
lint over 1,102 files with zero warnings, every project typechecking, ~3,500 tests, both builds,
92 e2e tests, the api deploy check and the docs check.

**Left:** D2, E, F, G.

---

## Phase D2 — feature wave 2

The larger of the two waves. Every area below is currently a **seam only** — between 4 and 36 lines
per feature, against 34–72 files each for the D1 features. Effectively none of it is written.

| Feature | web | api | core |
| --- | --- | --- | --- |
| `simon` | 3 files / 36 lines | 1 | 1 |
| `scheduling` | 3 / 27 | 1 | 1 |
| `vault` | 2 / 13 | 1 | 1 |
| `sharing` | 1 / 4 | 1 | 1 |
| `connections` | 1 / 4 | 1 | 1 |
| `analytics` | 2 / 13 | 1 | 1 |

### D2a · Simon, executors and quick chat — architecture §8

The centrepiece, and the largest single piece of work left in the project.

- **`simon-run` Trigger task.** Machine `micro`, queue `d1`. The api dispatcher already calls
  `tasks.trigger('simon-run', { runId }, { idempotencyKey: runId })` and the reconciler already
  polls it — **the task itself does not exist.** It starts with a conditional claim
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
  Needs the **marker-string test** that proves no plaintext reaches a Trigger-hosted sink.
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
  exist. Fill the seam rather than building a parallel surface.
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
- **Needs the four PostHog variables** — the only credentials still outstanding.

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

Cross-feature work that only makes sense once D2 exists.

- **The 20 flows in [coverage.md](coverage.md)**, end to end, not per-feature.
- **Executor parity.** Note 07 is explicit: run the same chat, tool and document contract tests
  under **both** executors, and verify that durable mode makes **no** model or tool calls in Nest
  and local mode makes **no** Trigger calls. Also: locked-account and cross-user rejection, page-edit
  conflicts, duplicate message submission, disconnect and replay without duplicate output, stop and
  approval flows, restart during a side effect, and an environment mode change with active work.
- **Visual verification at 1440 / 1024 / 390** across all six themes in light and dark. D1 captured
  evidence at studio/light only (plus one meadow/dark appearance journey), so the populated-list
  frames per theme are still missing.
- **The D1 load test** (§3.1) if it has not already landed in D2.
- **Live suites** against the real providers — D1, R2, Trigger, OpenAI, Composio, PostHog. D1, R2
  and Trigger credentials are verified working; these suites currently skip themselves when
  credentials are absent.
- **Distribute `.env.local` into `apps/*/.env`** along the secret-placement matrix in
  [CLAUDE.md](../../CLAUDE.md). This is deliberately not done yet: with `DURABLE=true` the api
  *rejects* `OPENAI_API_KEY`, the worker must *not* carry `TRIGGER_SECRET_KEY`, and turning the live
  suites on early means tests hitting the real OpenAI account and R2 bucket.
- **Apply the 30 migrations** to the live D1 database, which is currently empty.

---

## Phase F — adversarial review

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
