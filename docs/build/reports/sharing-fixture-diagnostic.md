# Sharing fixture publication failure diagnosis

## Cause and evidence

The intermittent initial `POST /v1/tasks/:id/document/commits` 500 was a test isolation defect, not an unexplained contention timeout. `bootTestApp` gave every app independent SQLite/R2 storage but inherited the process-global default `GIT_TMP_DIR`. The document maintenance test runs cleanup with its fake clock advanced two days. Git cleanup compares that timestamp to filesystem modification timestamps and removes directories older than fifteen minutes, including another app's currently active repository in the shared root.

During investigation, the unchanged full API suite reproduced the failure in the sharing test "public grants are distinct and cannot unlock the private/password route". Initial exception-filter instrumentation saw the mapped `ApiError.internal`; the document error mapper deliberately hides Git error details. Instrumenting the Git service boundary in a deterministic private-root reproduction captured the actual original exception: `GitError`, code `git.unavailable`. Cleanup removed the initialized workspace before the publication's next Git command, so spawning Git with that missing working directory failed. The normal API mapper converted it to the observed 500.

The regression boots two real API apps, pauses a real HTTP document publication after repository initialization, runs the second app's future-clock `DocumentMaintenance`, and resumes publication. With an explicitly shared **private test-only** root, it asserts the original Git error and the exact internal 500. With default harness roots, the identical interleaving must publish successfully (201), capture no Git error, and return the intact page on subsequent read. Neither test relies on sleeps or probabilistic scheduling. Root-isolation assertions run before the future sweep, so a regression cannot accidentally sweep the global/user-development directory.

## Fix and decisions

- Default each harness app's Git root to `<dataDir>/git`, making Git state follow the same isolation and disposal boundary as D1 and R2. Explicit `GIT_TMP_DIR` overrides remain honored; intentionally restarting the same `dataDir` retains its Git root.
- Keep production Git cleanup and API error mapping unchanged. This failure was caused by independent test apps with independent clocks sharing disposable storage, not malformed document content or encryption.
- Keep the intentional shared-root failure as a positive diagnostic control alongside the success regression. No existing test assertion, concurrency, timeout, or cleanup behavior was relaxed.
- Remove temporary instrumentation from the existing sharing test; all permanent exception capture is confined to the new test.

## Files and overlap

- `apps/api/test/harness.ts`: shared test helper; default Git-root isolation only.
- `apps/api/test/git-isolation.test.ts`: new deterministic negative control and success regression.
- `docs/build/reports/sharing-fixture-diagnostic.md`: this report.

No production modules, migrations, Simon files, credentials, browser/live suites, progress or coverage files changed.

## Verification

- Focused deterministic regression: 2 tests passed, including the original `git.unavailable` failure capture.
- `pnpm lint`: 1,275 files, zero errors or warnings.
- `pnpm typecheck`: all 17 projects passed.
- `pnpm test`: passed, including API 473 tests (6 existing credential-gated live skips), core 553, worker 93, web 1,558 and scripts 47.
- Three additional consecutive full API runs at default concurrency: all passed, 48 files / 473 tests each, with the same 6 existing live skips. Combined with the full workspace run, four consecutive post-fix API runs were green.
- `python3 scripts/check_docs.py` and `git diff --check`: passed.
