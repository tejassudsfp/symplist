# Combined D1 load contract

Current status: merged. The five local request-budget and transport-safeguard tests remain the
recorded Phase E evidence; this report does not claim live D1 capacity or a latency SLA.

Branch: `wip/e-d1-load`, based on `f51ac3f` (Simon, Vault and Scheduling).
Scope: architecture §3.1's carried-over Phase D2/E request-budget test, not feature implementation.

## What is exercised

- Ten concurrent API conversation/message submissions use the production Simon repository and
  encrypted folded idempotency store. The production API dispatcher, dispatch-intent repository,
  executor state, execution registry, Simon tracker and Trigger executor dispatch the ten runs.
- Four simulated Trigger parent processes run the real `runSimonTurn`/AI SDK loop. Each consumes
  exactly five scripted model steps: section read, section update, two rules reads, final text.
- Section updates use `DurableDocumentGit`, encrypted R2 job objects, the real child job handler,
  document services, Git subprocesses, encrypted bundles/snapshots and conditional head publication.
  A separate two-slot child queue prevents parent/child slot deadlock.
- A seventh worker process runs the real reminder scanner concurrently over fifty due tasks,
  producing fifty in-app notifications, with one coalesced owner announcement.
- Every measured API and worker D1 operation goes through `D1RestClient` and the SQLite-backed
  `FakeD1Api`; measurements are HTTP requests, not SQL statement counts. Both use the same fake
  account quota. Each process retains its bucket across queued jobs: API 2/s, burst 10; seven worker
  buckets at 1/7 per second, burst 4. The fake clock advances actual lane waits.
- Assertions require ten completed five-step runs, ten child jobs, ten read receipts, twenty
  document commits including ten seeds, the exact updated Markdown, twenty idempotency records,
  and ten dispatched intents. Each run's claimed duration is checked against 900 seconds using
  persisted `started_at`/`finished_at`, not queue entry time.
- Request timestamps are checked over every rolling five-minute window and every pair of requests
  in each process against its sustained rate and burst allowance. The whole finite workload must
  also use fewer than 1,000 requests, a stronger volume bound than any individual window.

## Measurements

With the initial integrated implementation: **379 requests = 72 API + 307 worker**.
Worker requests comprise 250 Simon-parent requests, 50 Git-child requests and 7 scanner requests.
The final focused run peaked at **191 requests** in a rolling five-minute window, took **764 seconds**
of simulated queue time overall, and had a longest claimed run of **326.5 seconds**. Earlier runs
measured 176 / 861 seconds and 166 / 962 seconds while the host was busier. Counts are stable, while
virtual elapsed time also includes event-loop opportunities for real Git/file I/O.
The test emits fresh numeric measurements (including longest claimed run) with
`pnpm --filter @symplist/worker exec vitest run src/infra/d1-load.test.ts --disableConsoleIntercept`.

**This is not a five-minute completion claim.** The conservative per-process worker buckets make
the queued workload take longer than five minutes. It establishes the specified D1 request-volume
budget under those limits, not a production latency SLA or a live Cloudflare capacity result.

## Additional safeguards

Four transport checks prove that unauthenticated requests are shed after their 30% burst share
without reaching D1, authenticated work retains the other seven burst tokens, and an authenticated
waiter is not displaced. A 429 opens the shared process circuit for explicit `Retry-After` or the
300-second default; sibling clients make no requests before expiry. A write whose response is lost
after committing is sent exactly once, while a failed read retries.

## Decisions and limitations

- Fixture/migration setup and post-run database inspection bypass measured REST deliberately; they
  are neither user requests nor executor work. Every production service inside the workload receives
  a measured client. No production code, existing test, rate, timeout, migration or credential changed.
- Reminders use in-app delivery. Email rendering/provider acceptance and their additional outbox
  workload are outside this explicit fixture; scanner email/lease contract suites cover them separately.
- The model and Trigger scheduling API are fakes; document Git and encrypted local object storage are
  real. No network, live provider, secret file or live migration is used.
- This is service/transport integration, not browser or HTTP middleware coverage. Session resolution,
  signed output relay, unrelated background maintenance and periodic reconciliation are not part of
  the measured workload. Output chunks use an in-memory sink and do not write D1 per token.
- Final merged gates and current browser journeys are recorded in [progress.md](../progress.md) and
  [coverage.md](../coverage.md). A live Resend delivery/webhook is not part of the required Phase E
  live set and is not claimed. This load test remains local request-volume evidence and must not be
  cited as a live capacity or latency result.

## Verification

- Frozen install passed.
- Repository lint passed with 1,223 files, zero errors/warnings.
- All 17 project typechecks passed; worker typecheck passed after harness additions.
- Worker suite passed: 20 files / 92 tests, including the five new load/safeguard cases.
- Full `pnpm test` passed, including 47 script tests (credential-gated live suites retain their existing skips).
- Web production build passed.
- Final worker typecheck and focused five-test rerun passed after deriving slots from `queues.ts`
  and adding persisted duration/content/idempotency/dispatch assertions.
- Documentation/link check and `git diff --check` passed. No browser, live or deployment checks run
  by this stream; it changes tests and this report only.

## Adversarial pass

The first harness draft bypassed API dispatch overhead and used independent hard-coded queue sizes.
The final version includes the real dispatcher/tracker calls and derives slots from the imported
queue family, preserving buckets across jobs. It checks persisted effects rather than merely a
successful model finish, compares every request interval against its lane allowance, and distinguishes
queued workload elapsed time from individual claimed-run duration. No production defect or change
was needed; no existing test was modified, disabled or relaxed.

## Files and merge surface

Only new files; no shared source or manifest edits:

- `apps/worker/src/infra/d1-load.test.ts`
- `apps/worker/src/infra/d1-load-safeguards.test.ts`
- `docs/build/reports/e-d1-load.md`

No root progress, coverage or decisions file was edited. The report is the sole documentation write.
