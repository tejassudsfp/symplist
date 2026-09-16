# Simon backend adversarial review

Reviewed committed `feat/symplist-build` at `4c49738` in the isolated maintenance worktree. Production code was not edited. Root's uncommitted UI work was not copied or inspected as part of the backend review.

## Confirmed findings

### P2 — Quick save can resurrect an expired conversation

Exact seam: `packages/core/src/simon/quick.ts:117–123`, through `TaskService.create`'s asynchronous tree load/planning.

`save` constructs `task_auth_now` before calling the task service. The eventual deciding SQL checks `expires_at` against that old timestamp. If the chat expires during the await, task creation and conversion to `kind='task', expires_at=NULL` still commit. Cleanup can no longer delete the now-permanent conversation. This is an existing lifecycle defect, not an unbuilt UI feature.

Deterministic reproduction: begin with an idle valid quick conversation; intercept the task insertion batch, advance the fake clock beyond its TTL, then execute the real batch. Expected rejection/no task; actual returned success with a task ID. The test advances 25 hours for clarity, but the real window is any request starting just before expiry and finishing after it.

Regression: `review-regressions.test.ts`, "does not save an expired quick chat when expiry crosses during task planning".

### P2 — Native task/schedule authorization freezes the expiry clock before awaits

Exact seams: `packages/core/src/simon/native.ts:39–48` (`authorization()`), `:62–67` (`create`) and `:81–90` (`schedule`). Schedule then performs asynchronous replay/get/save operations through `packages/core/src/scheduling/tools.ts`; task creation performs asynchronous planning in `TaskService`.

The SQL correctly rechecks persisted status, cancellation, executor generation/mode, ownership and access, but its `:task_auth_now` is a static value from tool entry. An expired quick run therefore retains write authority if expiry crosses while the call is in progress. The Sharing/document guard-getter fix does not cover these independent task authorization objects.

Two deterministic reproductions:

- Advance the clock before the real native task insert batch: `create` resolves `{created:true}` after the quick conversation's expiry.
- Allow the native schedule's preliminary `get` to return, advance the clock before returning from that await, then let its real save proceed: it commits schedule version 1 after expiry.

Expected outcomes are a refused write with no new task/schedule. These are existing authority defects, not missing tool registrations.

Regressions: "does not commit a native task after its quick conversation expires during planning" and "does not commit a schedule after expiry crosses during its preliminary read".

### P2 — Native move's call ID is discarded, allowing replay to overwrite a later owner move

Exact seam: `packages/core/src/simon/native.ts:71–78`. `this.callId(toolCallId)` validates the ID but does not pass it to any durable receipt/idempotency mechanism. `taskMoveTool` is only a no-op if the task happens to remain in the requested collection.

Reproduction: native call `move_once` moves a task to Later; the owner subsequently moves it to Now; repeating `move_once` with exactly the same arguments moves it back to Later. The output-loss/replay path therefore performs a second effect and overrides the user's intervening choice. Existing tests verify create and schedule replay, but not this interleaving for move.

Expected: exact replay returns a recorded result or a conflict without applying another move; mismatched arguments under the same call ID must not create another effect. This is an existing replay-contract defect, not a missing model integration.

Regression: "does not reapply a replayed move over an intervening owner move".

## Output/snapshot privacy audit

Inspected the encrypted worker output controller/relay, local sink, model loop/checkpoints, `SimonViews`, `SimonTopics` and conversation-topic replay/snapshot paths. No additional confirmed cross-user plaintext exposure was demonstrated in this bounded review. Public history projects visible parts and drops provider reasoning; canonical reads are owner/access/expiry guarded; checkpoints are fenced.

Follow-up coverage remains warranted for close/expiry while a conversation socket is already subscribed and while output is in flight. Close deletes D1 history and cancels the executor but does not explicitly evict that conversation's topic ring or invalidate the relay's cached run. `RunOutputRelay` intentionally permits up to ten seconds of cached status, and `TopicHub` checks conversation ownership at subscription rather than every chunk. Do not report this as a proven cross-user leak: the existing architecture permits bounded status caches and an already delivered/in-flight response cannot be recalled. An explicit close/expiry stream-retention test is needed to pin the intended semantics.

## Product integration gaps, not new defects

At the reviewed commit, the executor adapters install the native create/move/schedule tools plus document tools, rules and user asks. Sharing/handoff and Connections/Composio/Vault tool integration are separate unfinished product seams already being worked on by the parent/other stream. This review does not confuse their absence with a regression in an implemented path and does not claim end-to-end completion of those features.

## Evidence and verification

- Added only `packages/core/src/simon/review-regressions.test.ts` and this report.
- `pnpm --filter @symplist/core test src/simon/review-regressions.test.ts`: **4 failed**, all deterministically demonstrating the findings above; three unexpected successful writes and one overwritten owner collection.
- Core typecheck and focused Biome check passed.
- No full test/build/browser/live suites were run during this review.
- These are deliberately red expected-behavior regressions for the parent to fix. Do not describe this branch as green or merge the tests without addressing the findings.

## Decisions

- Preserve desired assertions; do not invert them to bless the observed defects, mark them skipped, or change existing tests.
- Keep production fixes with the parent, as requested; report the clock-refresh and durable move-receipt seams rather than expanding ownership.
- Use deterministic fake-clock/database interleavings with real core services and no provider calls or credentials.
