# Build decisions

Decisions made during the build, recorded so later work and reviewers can see why the implementation differs from, or adds to, the [numbered specifications](../notes/files/00_index.md). Deployment-specific values (addresses, secrets, account IDs) are kept in an untracked local file, not here.

Status: **Confirmed** by the owner, or **Build default** chosen during implementation and open to change.

## Scope additions and changes

| # | Decision | Status | Supersedes / extends |
| --- | --- | --- | --- |
| D1 | **Quick chat**: temporary Simon conversations not attached to a task. Floating button at the bottom right, shown only when no task is selected; the panel opens out of the button; full screen on mobile. Ending the chat deletes it; unattended chats expire after 24 hours; "Save as task" turns it into a task that keeps the conversation. Simon acts as a workspace helper (find/open/create/move tasks, reminders, drafting, approved connector actions, handoff prompts) and can read but not edit a named task. No Vault or incoming MCP access; not searchable. | Confirmed | New note 18 and screen brief |
| D2 | **Six themes**: Studio, Paper, Pebble, Postcard, Meadow and Tide from the UI sample, each usable with any accent and Light/Dark/System. | Confirmed | Note 02 and themes brief (four themes) |
| D3 | **Reminders are due-date notices, not alarms**: delivered at the top of the hour in the user's local time. The scanner wakes at :00, :30 and :45 past each UTC hour so UTC+5:30/+5:45 zones get their local top of the hour. Reminder times are whole hours; relative reminders round down; snooze offers 1 hour, Tomorrow at 9 and a custom hour. | Confirmed (timing); build default (mechanism, choices) | Note 15 (60 s polling, 15-minute snooze) |
| D4 | **Incoming MCP** at `/mcp` on the API origin, authenticated by **OAuth 2.1** (with an in-app consent screen) and by **bearer API keys**. | Confirmed | Agent connections brief (auth pending) |
| D5 | **Analytics on, with a mandatory cookie consent banner**. Nothing loads or is stored before Accept; Decline is as easy as Accept; the choice syncs with Settings → Account → Privacy. The banner appears after sign-in because login, Vault and share routes never load analytics. PostHog US cloud. | Confirmed | Note 17 (settings-only opt-in) |
| D6 | **All Composio connectors** are offered, fetched live from Composio on demand and not stored. Auth configs are looked up or created automatically. Connectors that cannot use shared credentials are hidden unless the user can supply their own API key through Composio's hosted form. | Confirmed (catalogue); build default (hiding) | Onboarding/connections briefs (sample catalogue) |
| D7 | **Composio-managed shared OAuth** until a business case is proven. Switching to own OAuth apps later requires affected users to reconnect, surfaced as Needs attention. | Confirmed | Note 12 |
| D8 | **AI providers**: OpenAI by default (Fast `gpt-5.6-luna`, Smart `gpt-5.6-terra`, verified on OpenAI's model pages on 2026-09-15). Provider registry also supports Amazon Bedrock (Anthropic), Google Vertex AI and Together AI. OpenAI programmatic tool calling (hosted code runtime) is never enabled. AI operational telemetry is on (no content). | Confirmed | Note 07 |

## Architecture and operations

| # | Decision | Status |
| --- | --- | --- |
| A1 | `DURABLE=true` in hosted environments. Local development without a Trigger secret key falls back to the Nest executor, which the spec already supports. | Confirmed |
| A2 | Hosting: Next.js on Vercel, NestJS on Render (single always-on instance), Trigger.dev Cloud. Merges to `main` auto-deploy all three. Vercel previews run without a backend until a separate dev backend exists, so previews never reach production. | Confirmed (hosting, auto-deploy); build default (previews) |
| A3 | Trigger machines: **micro** for most tasks including chat runs; **small-1x** for Git document tasks. On out-of-memory, idempotent background tasks retry on a larger machine; chat runs are marked interrupted with an explicit Retry, never re-run automatically. | Confirmed (sizes); build default (OOM handling) |
| A4 | Master keys (`CONTENT_KEK`, `VAULT_RECOVERY_KEY`) come from environment variables behind a key-provider interface so a KMS can be enabled later without code changes. | Confirmed |
| A5 | Runtime and tooling verified 2026-09-15: Node.js 24 LTS (24.21.0 current; `engines` >=24.15), pnpm 12.4.2, Trigger.dev 4.6.0 (`runtime: "node-24"`, Git via `aptGet`). Remaining stack versions are recorded in [progress](progress.md) as they are verified. | Build default |
| A6 | pnpm 12 supply-chain policy is kept: dependency build scripts are allowed only for listed packages, and deliberately pinned releases newer than the minimum release age are listed explicitly in `pnpm-workspace.yaml`. | Build default |
| A7 | **Local development adapters**: without Cloudflare/Resend/AI credentials the app runs locally with clearly labeled development adapters (SQLite file standing in for D1 with the same batch semantics, filesystem standing in for R2, OTP emails printed to the server log). They are refused when `NODE_ENV=production`. Production uses D1 REST and R2 only. | Build default |
| A8 | Every feature ships with tests. Integrations are tested against stand-ins that model documented provider behavior, plus separately labeled live checks that run only when credentials are present. | Confirmed |

## Product behavior defaults (task_actions, archive, calendar briefs)

| # | Decision | Status |
| --- | --- | --- |
| P1 | Completing a parent with open subtasks asks first: Complete all, Only the parent, or Cancel. | Confirmed |
| P2 | Restoring an archived task returns it to its original collection, falling back to Now. | Confirmed |
| P3 | Moving a subtask to another collection makes it a top-level task there, with Undo. | Confirmed |
| P4 | No hard delete of tasks in beta; archive only. Account deletion is the only deletion path. | Confirmed |
| P5 | Keyboard bindings follow note 13, not the sample (Enter inserts a newline and Mod+Enter sends; `x` completes; Shift+N adds a subtask). | Build default |
