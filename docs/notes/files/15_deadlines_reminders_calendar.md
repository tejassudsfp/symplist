# Deadlines, reminders, notifications, and calendar

Documentation specification, September 15, 2026. No scheduler or UI is implemented. Deadlines, reminder emails, time-aware in-app notifications, and an internal calendar are in scope. General automation builders, recurring tasks, browser push, and automatic external-calendar synchronization remain deferred. Defaults below are proposed build decisions.

## Simple task scheduling

Creating a task still requires only its title. Add an optional Deadline control beside the title and in the task menu. Expand reminders only when requested. Now, Later, and Unclassified remain intentional collections: setting a deadline, reaching it, or snoozing a reminder never moves the task automatically. Calendar entries open the existing page and Simon conversation.

A deadline is either a local date or an exact date/time:

- Date-only stores a calendar date and its IANA timezone, with no fabricated midnight due time. It becomes overdue at the start of the following local day. Show it in the calendar's all-day area.
- Timed stores the resolved UTC instant plus original local time and IANA timezone. Show the timezone in editing and exact-date tooltips. Deadline comparisons use server time.
- Detect the user's timezone at onboarding, allow correction in Notifications settings, and use it as the default for new schedules. Travel/device changes must not silently rewrite existing deadlines. Offer an explicit reviewed change of existing schedules separately.
- For nonexistent DST times, explain and propose the next valid time before saving. For repeated times, show both UTC offsets and require a choice. Relative elapsed reminders such as “one hour before” use the due instant; “previous day at 9” uses calendar arithmetic in the deadline zone.
- Parent and child deadlines are independent; do not infer cascading dates. Optional planned work blocks/start times are outside the initial calendar scope.

No reminder is silently added to an existing task. When adding one, offer At deadline (timed only), One hour before, Previous day at 9:00, and Custom. Date-only tasks offer On the day at 9:00 with the time editable. Preview exact delivery date, time, timezone, and channels before saving. A standalone custom reminder without a deadline is allowed. Reject reminders already in the past with a choice of a future time; do not silently send immediately.

## Notification behavior

Persist in-app notifications so closing the browser does not lose them. Nest provides authenticated pagination, unread counts, mark-read, dismiss, and reconnect recovery; WebSocket events update active clients. There is no requirement for browser notification permission. Email reminders use Resend, independently of whether the app is open. Offer channel choices per reminder, with in-app selected initially and email an explicit preference.

Notifications show the task, due date/time, and Open task, Snooze, and Mark complete. A notification deep link requires login and current beta access. Reading/dismissing a notification does not complete its task. Snooze schedules a new reminder occurrence and leaves the deadline unchanged. Suggested snoozes are 15 minutes, 1 hour, Tomorrow at 9, and Custom, with resolved times shown.

Proposed quiet hours are 22:00–08:00 in the account notification timezone, editable and individually disableable. Store the notification at its intended time without a toast/sound; defer reminder email and intrusive presentation to the next permitted time. If deferral crosses the deadline, preview that fact when scheduling. A user can explicitly allow a particular reminder through quiet hours. Never queue a burst of old toasts at quiet-hours end; show one compact count and the persistent center. Sound is off by default.

Do not repeatedly nag about overdue tasks. Send only explicitly scheduled occurrences. Proposed lateness cutoff is 24 hours: after downtime, one pending occurrence per task/channel can be delivered within this window, labeled honestly; older email occurrences expire. Preserve one collapsed in-app missed-reminder entry for skipped occurrences. Completion, archive, deletion, account relock, or disabling a channel suppresses pending delivery. Restore/unlock does not revive old reminders; the user chooses new ones. Already accepted emails cannot be recalled.

Reminder preferences do not disable login/signup or vault-security messages. Handle permanent email delivery failures and suppress further reminder sends to that destination until corrected; explain channel problems in settings without blocking in-app reminders.

## Calendar

Provide Month, Week, and Agenda views; mobile defaults to Agenda. Include Today, date navigation, timezone label, Now/Later/Unclassified filters, and an unscheduled drawer. Default to active tasks. Completed items are an explicit filter with their actual deadline retained. Timed deadlines are point markers, not invented meeting durations; distinguish all-day dates visually and semantically.

Drag/drop reschedules with the same schedule validation as the task editor, plus an accessible Change date action. Preview the new deadline and changed reminders before committing; persist optimistically only with rollback/conflict handling. Changing date preserves collection, page, chat, and task identity. Crossing all-day/timed areas requires an explicit choice of date-only versus time. Removing a deadline asks whether to remove dependent relative reminders; standalone reminders remain independent.

The calendar works without any connector. External calendar creation or reading may be requested through Simon's authorized Composio wrappers. A task deadline is not automatically a Google/Outlook event. Do not imply background two-way synchronization, availability checking, or automatic meeting invitations in beta.

## Scheduler and storage contract

Both execution modes use the same deterministic scheduling/delivery service contract and D1 source of truth. No model, summary, chat session, or Composio call is needed to fire a reminder. Use ordinary Trigger tasks when durable, not a permanently running chat per reminder.

Proposed records: task schedule with owner/task IDs and optimistic version; reminder definitions; occurrence rows with generation, intended/effective delivery time, channel and lifecycle; notification/read state; delivery outbox with unique occurrence/channel key; executor dispatch intents; leases and provider receipt/status. Encrypt content payloads under the existing account-content policy. Store minimum operational IDs, timestamps, status, versions, and leases in D1 for scheduling; this timing metadata is visible to the service and is an explicit exception to content encryption. Titles, bodies, and snippets must not leak into job payloads, logs, or plain operational indexes. Large encrypted payloads may live in R2.

Schedule edits atomically increment the schedule generation and record replacement occurrences/dispatch intent. Dispatch only after commit. A worker validates ownership, access, active task, current generation, channel preferences, quiet hours, expiry, and its lease immediately before sending. A stale job is a successful no-op. A crash after the D1 edit but before external dispatch is recovered by reconciliation. Do not hold a database transaction open during provider calls.

### DURABLE=true

Run due-work scanning/reconciliation and delivery in Trigger. A periodic cron scans bounded batches of the indexed D1 due queue and dispatches idempotent delivery jobs; an optional delayed job is an optimization, never the only record of a reminder. Use one environment-specific reconciliation schedule rather than one cron per task. Proposed polling cadence is one minute; delivery is best effort, not an exact-second promise. Trigger supports timezone-aware cron, but per-task date/DST semantics remain Symplist's responsibility. See [Trigger scheduled tasks](https://trigger.dev/docs/tasks/scheduled).

Nest handles schedule mutation APIs and notification delivery to the browser; it does not run the durable background scanner. Trigger writes notification/outbox state through shared authorized storage services and signals Nest with an authenticated event reference. Nest fetches authorized persisted events and relays them through its existing WebSocket/replay mechanism. No direct Trigger frontend stream or browser-held Trigger credentials.

### DURABLE=false

Run the scanner, reconciliation, and send worker inside Nest with no Trigger calls or credentials. Persistent D1 occurrence/outbox rows survive process restarts; in-memory timers only wake the scanner. Atomic conditional lease acquisition and fencing tokens prevent multiple Nest replicas from owning the same occurrence. Heartbeat long-running claims; reject writes from expired owners. Startup recovers due work under the same lateness policy. Require an always-running backend for timely local reminders; a sleeping/offline host catches up on restart.

Switching modes requires draining old workers and advancing an executor generation in shared state before the new scanner takes ownership. Never have both adapters independently sending the same queue. Keep delivery identities unchanged across a mode switch.

### Delivery reliability

Persist an immutable encrypted send payload and stable provider idempotency key before the request. Retry transient failures with backoff and a bounded retry budget; distinguish queued, provider-accepted, delivered, bounced, failed, expired, cancelled, and uncertain. In-app creation uses a unique occurrence key. Provider acceptance is not inbox delivery.

Resend currently retains idempotency keys for 24 hours. Use its key for bounded retries plus Symplist's persistent ledger; do not claim exactly-once delivery across arbitrary failures. If acceptance is uncertain beyond the provider deduplication window, reconcile using available receipts/webhooks or leave uncertain for operator review instead of blindly resending. Validate webhook authenticity and process duplicate/out-of-order events idempotently. See [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

Concurrent cancellation and an already-started provider request cannot guarantee recall. Define the final validated send claim as the dispatch boundary; UI must not claim cancellation of an email already in flight. Subsequent generations suppress every later attempt.

## Email privacy and template

Default subject/body is generic: “You have a task reminder,” due time/zone, and an authenticated Open task link. An explicit email-preview preference can include the title. Never include document/chat excerpts, Vault content, secrets, invite codes, or action tokens. Encryption at rest does not extend to mail already sent to the recipient/provider. Provide a reminder-preferences link; if adding one-click email opt-out, use a narrow signed token that can only disable reminder email, never authenticate or mutate tasks. GET navigation must never complete a task.

## Simon tools and Git boundaries

Add a native `task_schedule` tool with `read`, `set_deadline`, `clear_deadline`, `add_reminder`, `update_reminder`, `cancel_reminder`, and `snooze` operations. Inputs carry expected schedule version and mutation idempotency key; trusted execution injects owner/task identity. Return normalized schedule, next delivery, channels, and any quiet-hours adjustment. Use the same validation/authorization as the UI and expose the scoped contract to incoming MCP clients. No arbitrary cron expressions or provider-specific scheduler APIs exposed to Simon.

“Remind me tomorrow” uses known timezone/default reminder time and states the resolved time; ask when the request remains ambiguous or the user's preferences are unavailable. A user request to schedule authorizes that concrete scheduling change; document text alone does not. Sending the reminder later follows the saved instruction with deterministic code and no background agent action. Simon cannot bypass channel preferences, quiet hours, beta access, or task ownership.

D1 schedule versioning is separate from Markdown Git revisions. Keep an audit record of user/Simon deadline changes; do not commit the document on timer ticks or synthesize summaries. Restoring a document version does not roll back deadlines or resend notifications.

## Configuration and verification required for build

Proposed settings: REMINDERS_ENABLED, REMINDER_EMAIL_ENABLED, REMINDER_POLL_INTERVAL_SECONDS (60), REMINDER_MAX_LATENESS_HOURS (24), batch/concurrency/lease/retry bounds, plus existing DURABLE and Resend configuration. Persist user timezone, channels, quiet hours, and email-preview preference. Validate ranges at startup. Disabling reminders cancels/suppresses pending delivery; re-enabling requires explicitly scheduling fresh reminders. Safety rate limits and operational delivery counts are independent of billing; no beta plan quotas or AI usage monitoring added.

Verify both adapters against identical fixtures: no deadline required; date-only overdue boundary; DST gaps/overlaps; timezone travel; quiet-hours crossing due time; snooze; parent/child independence; concurrent edits; completion/archive/delete/relock suppression; restore; duplicate workers; crash before dispatch and after provider acceptance; retries beyond provider key retention; mode switch; offline recovery; webhook replay; unauthorized deep links/MCP; encrypted payload/log hygiene; keyboard-only calendar edits; unread sync across devices. Include mocked-provider tests and controlled delivery verification during implementation, not email sends as part of this documentation task.
