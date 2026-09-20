# Stable Simon provider outcomes

## Defect and fix

The turn boundary always replaced SimonModelError(`ai.unavailable`) with `ai.provider_failed` and recorded `executor_error`. Separately, failed streams committed their terminal checkpoint before the interruption tracker ran; since the tracker intentionally updates only queued/running runs, those terminal failures had no useful outcome code.

- Preserve only the exact trusted `SimonModelError` unavailable code at the turn boundary; arbitrary objects and all raw provider messages still collapse to `ai.provider_failed`, without a cause.
- Permit these two stable codes in the execution outcome type.
- Persist `ai.provider_failed` inside the existing failed-checkpoint transaction, with the same run/owner/generation/cancellation guard. No extra mutation or post-terminal overwrite is introduced.
- Cancellation remains authoritative: existing Stop outcomes are not replaced by a later provider error.

## Verification

Six new tests exercise both local and Trigger execution: unavailable setup, arbitrary setup failure, failed stream checkpoint and Stop precedence. The full agent suite passes **88 tests**. All **17 projects typecheck** after these changes. Full lint remains zero errors/warnings. No existing assertion was relaxed or removed.

## Shared files

- `packages/agent/src/turn.ts`
- `packages/agent/src/turn.test.ts`
- `packages/core/src/events/execution.ts`
- `packages/core/src/simon/repository.ts`

## Decisions

The terminal checkpoint records the generic safe failure category, not an SDK-specific diagnosis. Only a Symplist-owned unavailable exception receives the more specific unavailable category. UI interpretation remains root-owned; no contract or view file was changed here.
