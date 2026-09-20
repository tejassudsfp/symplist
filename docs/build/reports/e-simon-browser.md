# Phase E Simon browser and executor evidence

Status: the local-executor browser journeys are authored and the merged executor contracts are
verified; the browser suite has not been rerun on the current merged tree, and the durable browser
relay path remains unverified.

## Authored browser coverage

`apps/e2e/tests/simon.spec.ts` defines six real-API journeys. Playwright expands them across the
three configured viewports (1440, 1024 and 390), for 18 cases:

- Task chat submission with Enter/newline, IME non-submission and Mod+Enter; one accepted message,
  terminal reply, WebSocket disconnect/reconnect and reload without duplicate visible output.
- Temporary Quick Chat send and close/delete; a 404 for the deleted conversation, launcher focus
  restoration and a fresh empty conversation.
- Quick Chat Save as task with the conversation preserved after reload.
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

The focused verification that introduced the final matrix edges passed: agent 43, core 133, API
executor 76 (plus six credential-gated skips), worker matrix/load five, and an additional 56 core
tests. These are service/contract results, not browser results.

## Live evidence and remaining boundary

Bounded live contracts were run on 2026-09-20: Trigger 15 passed with three intentionally skipped
live-control cases (local, fake and live targets all exercised), and OpenAI 12/12. The Composio live
target's bounded metadata probe also passed as part of its seven-pass/five-intentional-skip result.
These probes deliberately carry no private conversation and do **not** combine into a live Simon
browser run.

No current merged execution of `simon.spec.ts` is claimed. The original authoring worktree could not
bind the local servers; no later result has replaced that absence. In particular, there is still no
executed browser proof of:

- `DURABLE=true` dispatching a real `simon-run`, making the OpenAI/tool call only in Trigger and
  returning output through the signed encrypted worker→API relay;
- browser approval edit/approve/success/uncertain outcomes or interruption during a live external
  side effect;
- a document edit initiated from the browser chat, a browser-driven 24-hour Quick Chat expiry, or
  the merged Simon states across every theme/mode.

The earlier 36-frame visual matrix remains valid populated-workspace evidence, but its Simon panel
was intentionally empty. It is not evidence for the current chat/approval/Quick Chat surfaces.

Run the authored local suite without disturbing the default development ports:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
E2E_WEB_PORT=3500 E2E_API_PORT=4500 pnpm --filter @symplist/e2e exec playwright test tests/simon.spec.ts --workers=1
```

Completing the durable gap requires a separate credentialed deployment/browser journey, because the
standard Playwright harness intentionally sets `DURABLE=false` and has no Trigger connection.

## Files that authored the browser slice

The original browser slice changed only test/harness/documentation paths:
`apps/e2e/src/helpers/local-api.ts`, `apps/e2e/src/helpers/simon.ts`,
`apps/e2e/tests/simon.spec.ts`, `apps/web/src/app/(app)/layout.test.tsx`,
`apps/web/src/features/workspace/archive-view.test.tsx`, `docs/build/coverage.md` and this report.
Subsequent production/UI and executor work is represented by the merged files and tests cited above;
this inventory is not a current-branch diff.
