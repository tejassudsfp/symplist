# Code review: realtime, internal endpoints and executors (2026-09-16)

Findings from a medium-effort code review of the merged `c7-realtime-executors` slice. To be fixed, with regression tests, immediately after the Phase C close-out merge and before Phase D1.

1. **Medium.** `apps/api/src/modules/internal/run-output.relay.ts`: a transient account-key load failure (D1 timeout or network error) is treated as undecryptable. The controller returns 400 and keeps the event id reserved, and the worker drops the batch without retry. It must answer 503 and release the event id, like the lookup failure path.
2. **Medium.** `apps/worker/src/infra/internal-events.ts`: a retry that gets the api replay 404 is recorded as delivered. The first attempt's handler may still be running (the worker times out after 2 s) and may fail afterwards, releasing the id, so the event is lost. Replay-in-progress must be distinguishable from completed delivery, and handler failure must not be masked.
3. **Medium.** `apps/api/src/modules/realtime/topic-hub.ts` (`applyAccess`): the generation comparison runs only when the socket is currently admitted, so a stale access sweep result can re-admit a socket restricted after the sweep's D1 read. Access updates must be monotonic by access generation, and the sweep and `refreshUser` must not apply out-of-order results.
4. **Medium.** `apps/api/src/infra/executors/dispatcher.ts`: in local mode, a failure of `markDispatched` after `executor.start` (or a lost claim) leaves the intent claimable after the lease expires, so a finished local run can start a second time. Local dispatch needs an idempotency guard equivalent to Trigger's key (for example a durable started marker checked before start).
5. **Low.** `apps/api/src/modules/internal/replay-memory.ts`: every verified event id is kept for 10 minutes with a 200,000-entry cap, and run output pushes use a fresh id per attempt at up to 10 batches per second per run. About 34 concurrent runs fill it, after which every internal request gets 503. Run output needs its own dedupe (run id plus seq) instead of occupying the global event-id memory, or bounded per-run accounting.
6. **Low.** `apps/api/src/modules/realtime/topic-hub.ts` (`staleUpgrade`): after sign out everywhere, a new session created within about 10 seconds has its WebSocket closed with 4401, because the check is keyed by user id rather than by session creation time.

## Resolution (2026-09-16)

All six findings are fixed on `feat/symplist-build`. Each regression test was run against the unfixed code first and failed there. Decisions C7R.1 to C7R.6 in [decisions](../decisions.md) record the protocol changes.

1. **Relay key-load failure** (`d9e6cb0`). `RunOutputRelay.accept` maps an account key load that throws (D1 timeout or network failure) to `unavailable`, which the controller answers with 503 `rate.limited` (`Retry-After: 1`), and the worker retries. Only a missing key row (a crypto-shredded account) is still `undecryptable` (400). Test: `apps/api/src/modules/internal/internal.test.ts`, "answers 503 when the owner's account key cannot be loaded, and relays the identical retry". Before the fix this request got 400.
2. **Replay 404 counted as delivered** (`96dfc02`). `EventIdMemory` now tracks each reserved id as in progress or completed. A retry of an id whose handler is still running gets 409 `idempotency.in_progress`. A retry of a completed id gets 200 `{"status":"duplicate"}`. A handler failure, or a refusal before any handler ran, forgets the id. `InternalEventClient` counts only 202, 204 and 200 as delivered. It keeps retrying on 409, returns `unconfirmed` when the retries end while the first try is still in progress, and treats a 404 as a rejection on every try. Tests:
   - `apps/api/test/platform.test.ts`, "never reports an event delivered while the handler of its first try can still fail", which runs the worker client against the booted api, with the first try timing out and its handler failing later;
   - `apps/api/src/modules/internal/internal.test.ts`, "answers 409 while an earlier try is still being handled, so a handler failure is never taken for delivery" and "forgets the id of a request refused before any handler ran, so an identical retry gets the same answer";
   - `apps/worker/src/infra/run-output.test.ts`, "keeps retrying while the api reports an earlier try in progress, until the handler's outcome is known" and "never counts a 404 or a try still in progress as delivered".
3. **Non-monotonic access updates** (`31e2580`). `TopicHub.applyAccess(socket, access, readTicket)` ignores any result with an older `access_generation` than the socket's state, whether or not the socket is admitted. Within one generation it also ignores a result read before the one already applied. `AccessSweep` takes a ticket from `TopicHub.beginAccessRead()` before each D1 read, for both the periodic sweep and `refreshUser`, so a sweep that finishes after a restriction's refresh cannot re-admit the socket. Tests: `apps/api/src/modules/realtime/realtime.test.ts`, "never applies a sweep result read before a newer refresh, so a restricted socket is not re-admitted" (it holds a real sweep's D1 answer while a relock commits and is refreshed) and "applies access state monotonically by access generation and by read order".
4. **Local double start** (`4d6c972`). Migration `0018_dispatch_intents_local_start.sql` adds `dispatch_intents.local_started_at`. In local mode the dispatcher runs a job in this order:
   1. it writes the marker, conditional on its claim (`DispatchIntentRepository.markLocalStart`);
   2. the subject records the local executor;
   3. the job starts.

   A claimed intent that already carries the marker is marked dispatched without starting again, as Trigger's idempotency key does for durable runs. If the api died before the job ran, the reconciler marks the subject `interrupted` once it has had no heartbeat. A start that throws before any job code ran clears the marker (`releaseLocalStart`). Tests: `apps/api/src/infra/executors/executors.test.ts`:
   - "never starts a finished local job again after marking its intent dispatched failed";
   - "never starts a local job again when its claim was lost after it started";
   - "records the local executor on the subject before starting, so a start lost with its api is interrupted";
   - "forgets the start marker when the local start fails before running, so a later pass starts it".

   The executor contract suite still passes for the local executor, the Trigger executor over the fake client and the executor switch.
5. **Replay memory starvation** (`557bd07`). Run output no longer reserves event ids. The controller calls `InternalRequestVerifier.verifySignature`, and the relay's `(runId, seq)` dedupe is the replay protection. That dedupe is hardened for the job:
   - a run's state is kept for at least the 601-second replay window after its last request (`RUN_OUTPUT_REPLAY_WINDOW_MS`);
   - a full relay refuses new runs with 503 instead of evicting a run still inside its window;
   - runs found missing or inactive keep their entry, and a miss is cached for the state TTL, so a replay costs no D1 read.

   Tests: `apps/api/src/modules/internal/internal.test.ts`:
   - "keeps run output out of the event id replay memory, so streaming never starves internal events", with a three-id memory: 12 batches, then an internal event is still accepted;
   - "rejects forged and stale output requests and wrong key versions, and relays a replay once";
   - "refuses new runs while full of runs inside their replay window, instead of forgetting one";
   - "keeps the dedupe of a run that ended, and answers repeated misses without new lookups".
6. **Sign out everywhere closing new sessions** (`a9999a4`). The upgrade resolver returns an `UpgradeSession` carrying `auth_sessions.created_at`. `TopicHub.staleUpgrade` then refuses a socket after `noteSessionsEnded(userId, "all")` only when its session was created at or before that moment. Tests: `apps/api/src/modules/realtime/realtime.test.ts`, "after every session of a user ended, refuses only sockets of sessions created before that", which runs a real upgrade with a session created right after the sign-out, and the new cases in "refuses a connection verified before its session ended or its access changed".
