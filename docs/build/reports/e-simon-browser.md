# Phase E Simon browser and executor evidence

Status: verified on the merged tree. The local-executor browser journeys, connector approval
journeys and restart/no-replay journey pass at 1440, 1024 and 390. Executor parity is verified by
the shared local/Trigger contract matrix; a browser against a deployed durable environment is a
deployment smoke boundary, not part of the local Playwright harness.

The final full Playwright gate passed **212 cases with 16 intentional skips**. The Simon family
contributed 33 passing viewport cases: 24 from `simon.spec.ts`, six from
`simon-connections.spec.ts` and three from `executor-resilience.spec.ts`.

## Executed browser coverage

`apps/e2e/tests/simon.spec.ts` defines eight real-API journeys. Playwright expands them across the
three configured viewports (1440, 1024 and 390), for 24 passing cases:

- Task chat submission with Enter/newline, IME non-submission and Mod+Enter; one accepted message,
  terminal reply, WebSocket disconnect/reconnect and reload without duplicate visible output.
- Temporary Quick Chat send and close/delete; a 404 for the deleted conversation, launcher focus
  restoration and a fresh empty conversation.
- Hourly cleanup expiring an unsaved Quick Chat after the configured 24-hour TTL and returning the
  browser to a fresh conversation.
- Quick Chat Save as task with the conversation preserved after reload.
- Simon reading and updating an exact saved document section through the real encrypted job/Git
  path, with the open page receiving the new revision.
- Stop on an encrypted paused run while preserving existing assistant output.
- Answering the exact pending question through the owner API.
- Exact action/account details on an approval card, denial, persisted denied state and reload.

These journeys use the real local API, cookies, CSRF, idempotency and encrypted repositories.
Ordinary messages deliberately use `AI_PROVIDER_MODE=scripted` with the local executor; no response
or WebSocket message is fabricated. The pause helper creates real encrypted run, approval/question
and checkpoint rows, then cancels only the fixture's initial dispatch so the API dispatcher cannot
race the seed. The approval fixture has a synthetic connection and denies the proposal; it never
performs a provider action.

The UI represented by those journeys is present in the merged tree: the task conversation,
approval card, question controls, Stop state and responsive Quick Chat launcher/dialog are mounted
through the production shell. Store/component regressions also cover Strict Mode reopen, stale
response rejection, unmount deletion and the rule that an ordinary chat message cannot approve an
action.

## Executor matrix now covered

The backend matrix is broader than the browser file and is verified by focused local suites:

- `packages/agent/src/turn.test.ts`, `native.test.ts`, `documents.test.ts`, `sharing.test.ts` and
  `connections.test.ts` run the same shared turn/native/document/Sharing/Connections behavior under
  local and Trigger claims. Both-mode cases cover provider outcomes, relocked/wrong-executor no-op,
  task/schedule writes, document conflict, approval continuation, Vault handles, uncertain external
  writes and mandatory redaction.
- `packages/core/src/simon/repository.test.ts` proves concurrent identical submissions create one
  message, run and dispatch intent under each mode. Simon core/API suites cover foreign-owner and
  locked access, exact approval binding/expiry, Stop/Retry, saved or uncertain invocation replay,
  and continuation without resending an external side effect after restart.
- `apps/api/src/infra/executors/executors.test.ts` covers both local→durable and durable→local mode
  changes: current active work is interrupted/cancelled and pending work is rebound and dispatched
  once at the new generation.
- API executor-boundary tests prove durable Nest does not install the local model/tool handler;
  local executor contracts prove it makes no Trigger call. Worker registration and the §8.3 marker
  tests cover the ids-only Trigger payload/output boundary and encrypted worker→API output design.

`apps/e2e/tests/simon-connections.spec.ts` adds six passing viewport cases. They prove discovery,
schema lookup, an exact encrypted action proposal, recognizable account identity, trusted-UI
approval, one successful invocation, an uncertain post-send outcome, duplicate-decision rejection
and no blind resend. `apps/e2e/tests/executor-resilience.spec.ts` adds three passing viewport cases:
it recreates the repository/key process boundary after an accepted effect loses its response, then
drives the real Retry UI and proves one invocation/effect marker and no replay marker.

The focused backend verification that introduced the matrix edges passed: agent 43, core 133, API
executor 76 (plus six credential-gated skips), worker matrix/load five, and an additional 56 core
tests. The final full unit gate later passed 4,767 Vitest tests plus 61 script tests.

## Live evidence and deployment boundary

Bounded live contracts were run on 2026-09-20: Trigger 15 passed with three intentionally skipped
live-control cases (local, fake and live targets all exercised), and OpenAI 13/13 including a real
prompt-cache read. The Composio live
target's bounded metadata probe also passed as part of its seven-pass/five-intentional-skip result.
These probes deliberately carry no private conversation and do **not** combine into a live Simon
browser run.

The merged local browser run now covers exact approval success/uncertainty, interruption during an
external-effect boundary, the document edit initiated from browser chat and browser-driven
24-hour Quick Chat expiry. The production durable path is covered structurally and under both
executor claims: ids-only Trigger payloads, API-without-model/tool installation, worker-only model
execution and the signed encrypted worker→API output relay all have executable contracts.

The standard Playwright harness intentionally sets `DURABLE=false`, so it does not claim a single
browser session against a deployed `DURABLE=true` API and hosted Trigger worker. That final
composition depends on deployment DNS/runtime state and belongs in the publish smoke, without
weakening the Phase E executor-parity evidence.

The earlier 36-frame visual matrix remains valid populated-workspace evidence, but its Simon panel
was intentionally empty. Dedicated current-surface evidence is retained under
`apps/e2e/evidence/simon/` (15 images) and `apps/e2e/evidence/simon-connections/` (six images), with
Studio/light coverage at 1440, 1024 and 390. Phase E does not claim a 36-theme chat matrix.

Reproduce the local Simon family without disturbing the default development ports:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
E2E_WEB_PORT=3500 E2E_API_PORT=4500 pnpm --filter @symplist/e2e exec playwright test \
  tests/simon.spec.ts tests/simon-connections.spec.ts tests/executor-resilience.spec.ts --workers=3
```

## Files that authored the browser slice

The original browser slice changed only test/harness/documentation paths:
`apps/e2e/src/helpers/local-api.ts`, `apps/e2e/src/helpers/simon.ts`,
`apps/e2e/tests/simon.spec.ts`, `apps/web/src/app/(app)/layout.test.tsx`,
`apps/web/src/features/workspace/archive-view.test.tsx`, `docs/build/coverage.md` and this report.
Subsequent production/UI and executor work is represented by the merged files and tests cited above;
this inventory is not a current-branch diff.
