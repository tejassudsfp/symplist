# Phase E Simon browser journeys

Status: authored and statically checked; browser execution is blocked, not verified.
Branch: `wip/e-d1-load`, based on the clean `--no-ff` integration of `7ce93a8` at
`b8a197c`. The earlier D1 load contract remains intact.

## Coverage

`apps/e2e/tests/simon.spec.ts` adds six journeys, collected at all three configured
viewports (1440, 1024, 390), for 18 cases:

- Task creation through the owner API, Enter/newline, IME non-submission, Mod+Enter,
  one message submission, terminal reply, socket disconnect/reconnect and reload
  without duplicate visible output.
- Temporary quick chat, send, close/delete, a 404 for the deleted conversation,
  launcher focus restoration and a fresh empty conversation.
- Quick chat saved as a task with preserved conversation after reload.
- Stop on an encrypted paused run, preserving the existing assistant output.
- Answering the exact pending question through the real owner API.
- Exact action approval details, denial, persisted denied state and reload.

The journeys use the real local API, cookies, CSRF, idempotency and encrypted
repositories. Normal messages use the existing scripted provider and local executor.
The test environment now explicitly sets `AI_PROVIDER_MODE=scripted`, matching the
existing startup comment; previously it did not actually select that provider.
No HTTP responses or WebSocket messages are fabricated. The reconnect case retains
native WebSocket handles solely to close them while offline: offline emulation alone
does not consistently close an already-open socket.

The pause helper creates encrypted rows with `SimonRepository`, `SimonUserAsks` and
`SimonApprovals`, including a genuine runtime checkpoint. Its initial dispatch is
cancelled inside the acceptance transaction to prevent the running API dispatcher
racing the seed. Owner decisions create normal continuation intents. The approval
fixture contains a synthetic connection and only exercises denial, never a provider
action. A direct SQLite/encryption fixture check verified both pause kinds and that
no pending initial dispatch survived.

## Verification and limits

- TypeScript build and e2e typecheck pass.
- Focused Simon UI tests: 25 passed.
- Full web unit suite after review fixes: 104 files, 1,583 tests passed; web
  typechecking also passes.
- Playwright discovery: 18 cases collected, not executed.
- Full repository lint passes with zero warnings.
- Documentation links and all 44 brief references pass. The API deploy check was
  attempted but its package-manager fetch failed under the network restriction;
  no successful deployment/build verification is claimed for that check.
- Browser startup cannot proceed in this sandbox: even a minimal Node TCP server
  binding `127.0.0.1` returns `EPERM`. No screenshot has been generated or claimed.
- The installed pnpm shim tries to fetch pnpm 12.4.2 without network. Checks use
  already-installed local binaries. The exact missing `use-stick-to-bottom@1.1.6`
  package was copied from the main checkout's installed store; no tracked dependency
  or lockfile changes are part of this work.

The browser command to complete verification in a socket-enabled environment is:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
E2E_WEB_PORT=3500 E2E_API_PORT=4500 pnpm --filter @symplist/e2e exec playwright test tests/simon.spec.ts --workers=1
```

This suite does not establish live OpenAI/Trigger/Composio execution, approval
execution/edit/success/uncertain outcomes, interruption during an external side
effect, browser executor parity, document edits from the browser, expiry over 24
hours, or all-theme visual verification. Those remain separate Phase E work. Evidence
captures are configured for meaningful populated and paused states in Studio/light,
but remain pending browser execution.

## Review fixes and decisions

- Updated the shell integration test's pre-D2 chat-placeholder and empty quick-chat
  expectations to assert the real composer/error state and launcher. Added the
  missing jsdom `matchMedia` stub; no production component was bypassed.
- The archive test used a September 16 fixture but asserted `Today` against the wall
  clock. Pinning only its Date clock preserves the assertion across later dates and
  leaves asynchronous timers real.
- The seeded dispatch cancellation includes `cancelled_at`, required by the real
  database CHECK constraint; repository batch result positions remain unchanged.
- Evidence paths are absolute from the test module so execution from either the
  workspace root or e2e package stores frames in the same intended directory.

## Files outside the Simon feature directory

All changes are test/harness/documentation only:
`apps/e2e/src/helpers/local-api.ts`, `apps/e2e/src/helpers/simon.ts`,
`apps/e2e/tests/simon.spec.ts`, `apps/web/src/app/(app)/layout.test.tsx`,
`apps/web/src/features/workspace/archive-view.test.tsx`, `docs/build/coverage.md`,
and this report. No production feature code, migrations, secrets or manifests changed.
