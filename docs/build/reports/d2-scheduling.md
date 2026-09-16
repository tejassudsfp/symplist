# D2 Scheduling stream — implementation checkpoint

Worktree: `symplist-wt/scheduling`, branch `wip/d2-scheduling`. Sole writer. This is an **in-progress** report, not a completion claim.

## Implemented backend slice

- Migrations 0600–0601: versioned schedules, reminders, leased occurrences, encrypted notification/outbox content, preferences, suppression, encrypted audit and content-free provider correlation.
- Temporal date-only/timed deadlines, standalone/relative reminders, explicit DST disambiguation, local-hour rounding and quiet-hours preview.
- Shared local/Trigger scanner, fenced claims, send-time access/task/generation/preferences/suppression validation, stable provider idempotency, encrypted immutable payloads, late/missed notification collapse and quiet-window summaries.
- API schedule/preview/summary/calendar/preferences/notification/snooze routes with app CSRF/access and folded idempotency. Resend raw-body verified webhook and narrow POST-only reminder unsubscribe.
- Imported-queue `reminder-scan` at `0,15,30 * * * *` and `cleanup-hourly` at `5 * * * *`; no child reminder jobs. Cleanup calls SimonPauseReconciler and search stale-intent requeue, and exposes `cleanupFeatureExpiries` for the integrator's Vault/quick-chat wiring.
- Archive/restriction/purge contributor implementations. No schedule restore revives cancelled occurrences.

## Decisions

Appended D2C.1–D2C.3 to the append-only ledger. Migration allocation follows architecture 06xx, not the colliding suggested 0350 range.

## Verification so far

- Frozen dependency installation passed in this isolated worktree.
- Full lint passed on 1,159 files, zero warnings. Full project typecheck passed.
- 28 focused core persistence/scanner/webhook tests passed; another 10 Temporal tests passed, including every IANA timezone across every UTC hour of 2026.
- First HTTP pass: three tests passed; the fourth exposed an incorrect new-test expectation (idempotency mismatch is the existing contract's 422, not 409), now corrected and being rerun.
- Full test gate identified an old D1 notification-placeholder assertion and a mock coupling; UI changes are fixing both. **Full test gate not yet green.**

## Remaining

UI component/browser contracts, incoming Simon/MCP scheduling wrapper and deadline search source, expanded adversarial/lease/retry tests, full branch review and all final gates. Initial UI implementation exists but is not yet declared verified. Live mail delivery and Phase E integration remain integrator-owned.

## Outside-feature changes so far

`packages/db/migrations/0600_scheduling.sql`, `0601_notification_provider_events.sql`; `packages/core/src/{access/restrict-contributors,tasks/archive-contributors,account/purge-contributors}/scheduling.ts`; `packages/email/package.json` (type-only transport subpath); `apps/worker/tsconfig.json` (JSX for email templates); `apps/web/src/components/shell/feature-slots.tsx`; `apps/web/src/app/globals.css` (one appended Scheduling block); calendar and notification-settings route pages; D1 layout test updated for real notification control; append-only decisions and this report. Root baseline fix b7e805b was cherry-picked as 768257e (two API fixtures plus the root's progress note), not independently changed.
