# Build progress

Checkpoint file for the end-to-end build. Read this first when resuming; update it at the end of every iteration.

**Goal:** build and verify the complete Symplist free closed-beta application from its product notes, screen briefs, and supplied UI sample, with real backend integrations, documented self-hosting, and evidence for the acceptance criteria.

- Branch: `feat/symplist-build` (no upstream; never push to `main`)
- Scope sources: [notes](../notes/files/00_index.md), [screen briefs](../../design/mockups/overall.md), [UI sample](<../../design/UI sample/README.md>), [decisions](decisions.md), [coverage ledger](coverage.md)
- Local runtime: Homebrew Node 24 (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`), pnpm 12.4.2
- Secrets: not yet provided. Trigger CLI is logged in (project `proj_rryekrktnjnrdzvabzqd`); the development secret key is still pending.

## Phases

| Phase | Content | Status |
| --- | --- | --- |
| 0 | Workspace scaffold, Trigger.dev worker with a registered healthcheck task | Done |
| A | Research: verify latest stable versions and current APIs for every dependency | Done (`docs/build/research/`) |
| B | Architecture and contracts: repository layout, D1 schema, API/WebSocket protocol, shared contracts, test conventions | Done ([architecture](architecture.md) revised after 56-issue adversarial review, verified) |
| C | Foundation: apps and shared packages, configuration, storage/crypto/email adapters, auth guard skeleton, theme tokens, CI | Done (C0, C-a, C-b, C-close, code review c7 fixes; independent verification 39/43 PASS, the other 4 deferred below) |
| D1 | Feature wave 1: identity/access/admin, workspace/tasks, appearance, documents/Git, keyboard/search core | Pending |
| D2 | Feature wave 2: Simon/executors/Composio/quick chat, scheduling/notifications/calendar, Vault, sharing/handoff, connections/MCP, analytics/consent | Pending |
| E | Integration, end-to-end flows, visual verification at 1440/1024/390 across themes | Pending |
| F | Adversarial review and fixes | Pending |
| G | Documentation, spec updates, self-hosting guide, pull request | Pending |

## Log

- 2026-09-15: Full read of repository, notes, 44 briefs and UI sample. Deployment and product decisions confirmed with the owner (see [decisions](decisions.md)). Scaffolded pnpm workspace and `apps/worker` (Trigger.dev 4.6.0); worker typechecks, 5 tests pass, local worker registered with the Trigger development environment.
- 2026-09-15: Phase A research completed by 10 parallel agents (versions locked in [architecture](architecture.md) section 1). Key findings: TypeScript 7.0.2 works across the stack except the Nest CLI and typescript-eslint (use tsc and Biome); Cloudflare API rate limit (~1,200 requests/5 min) constrains D1 REST usage; OpenAI models `gpt-5.6-luna` and `gpt-5.6-terra` verified. Architecture drafted.
- 2026-09-15: Phase B complete. Three critics (spec coverage, implementability, security) raised 56 issues (8 blockers); all applied per integrator rulings recorded in [decisions](decisions.md) R1–R13, verified by an independent checker (1 gap and 11 contradictions found and fixed). Review record in `docs/build/reviews/architecture-review-1.md`.
- 2026-09-15: Phase C0 workspace foundation committed (13 packages, 4 apps, seams, CI; lint/typecheck/test/build pass; 27/27 independent checks). Phase C-a started in five worktrees under `../symplist-wt/` (contracts/config, crypto, data/storage/migrations, web shell, email/analytics/testing), each with an adversarial review pass. Phase C-b (api core; realtime, executors, worker infrastructure) follows the C-a merge.
- 2026-09-15: Phase C-a slices merged after adversarial review: contracts/config (8 defects fixed), crypto (7 fixed), data/storage/migrations (11 fixed), email/analytics/testing fakes (11 fixed). Merged tree: lint clean, 15 projects typecheck, ~1,180 tests pass (live D1/R2 suites skipped pending credentials), build and docs check pass. Phase C-b (api core; realtime, executors, worker infrastructure) started from 5ae570d.
- 2026-09-16: Owner set the current milestone: complete Phases C, D1, D2 and E on local stand-ins, merge everything into one clean `feat/symplist-build`, then pause for API keys before live checks and Phases F and G.
- 2026-09-16: Owner asked to close Phase C fully before D1: after the C-b merge, a C-close pass builds all open foundation items (pnpm dev, api Dockerfile and image test, CI job skeletons, font subsets, release-age cleanup, analytics and fake fidelity fixes, dist type resolution, Trigger re-registration, C-b leftovers) and an independent Phase C verification runs.
- 2026-09-16: **Phase C done.**
  - Summary of the phase:
    - C0 laid out the workspace: 13 packages, 4 apps, seams and CI.
    - C-a merged five slices after adversarial review: contracts and config, crypto, data, storage and migrations, the web shell, and email, analytics and testing fakes.
    - C-b built the api platform (c6: bootstrap, route classes, sessions, access, idempotency, abuse limits, hardened after a security review) and the realtime gateway, internal endpoints, executors and worker infrastructure (c7).
    - C-close wired the platform together (cz-a: seams, runtime modules, account purge runtime, executor contract suite, body limits, `LOCAL_DATA_DIR`) and the tooling (cz-b: `pnpm dev` supervisor, api image and deploy checks, CI e2e and api-image jobs, font subsets, analytics capture isolation, Composio fake fidelity, `pnpm smoke:local`).
    - Phase C verification added the Trigger config loader test and the email transport contract suite (decisions CZV.1 and CZV.2).
  - All six findings of [code review c7](reviews/code-review-c7.md) are fixed, each with a regression test that failed before the fix (decisions C7R.1–C7R.6):
    - relay key-load failures answer 503;
    - internal event replays report 409 while in progress and 200 when completed;
    - realtime access updates are monotonic;
    - local dispatch has a durable start marker (migration 0018);
    - run output dedupes outside the event id memory;
    - sign out everywhere is judged by session creation time.
  - Also added:
    - worker `d1.requests` counters every minute and at task end (decision CZV.3);
    - a structural test that every package manifest follows §2.2 point 1.
  - Independent verification: 39 of 43 checks PASS.
  - Final local run, all passing:
    - `pnpm lint` with zero warnings, `pnpm typecheck`;
    - `pnpm test`: 2,384 Vitest tests plus 47 script tests, with 9 live tests skipped for missing credentials;
    - `pnpm build`, `pnpm build:web:clean`, `pnpm install --frozen-lockfile`;
    - `pnpm e2e` (shell and smoke specs: 30 passed, 12 skipped because they run only at other viewports; evidence screenshots unchanged);
    - `pnpm smoke:local`, `node scripts/check-api-deploy.mjs` (18 migrations), `python3 scripts/check_docs.py`.
  - Deferred, with target phase:
    - AI provider and Composio wrapper contract suites: D2.
    - D1 load test (§3.1): D2/E.
    - Purge contributors for tasks, preferences, search and access: D1 feature waves.
    - Per-endpoint one-time secret scans (§6.1) and the Simon Trigger marker-string test (§8.3): D2.
    - Deploy configuration and CI `migrate`/`deploy-trigger` jobs: G.
    - Live suites (D1, R2, Trigger, OpenAI, Composio, PostHog): after credentials are provided.
- 2026-09-16: D1 incident: a mid-run reply to the workspace web-stage agent resumed it outside the workflow; it stopped with four untested web files (tree.ts, api.ts, errors.ts, task-store.ts) and no committed web stage. The workspace backend (5d14507) is intact. A dedicated workspace web and review pass runs on the existing worktree before the D1 merge. Access, documents and search pipelines are unaffected.
- 2026-09-16: Workspace worktree contention resolved by stopping the original D1 workflow's review:workspace agent, leaving the recovery workflow's web builder as the only writer. The recovery workflow's review stage covers the whole wip/workspace branch (backend and web), so the stopped backend review is not lost. Agent prompts now carry an autonomy rule (decide and record, never pause to ask), because every stall came from an agent waiting on a reply, which restarts it.
