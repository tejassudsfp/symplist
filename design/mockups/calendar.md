# Calendar

Read [overall.md](overall.md), [themes.md](themes.md), and the [scheduling specification](../../docs/notes/files/15_deadlines_reminders_calendar.md). Produce high-fidelity screens and connected interactions; these files are design prompts, not implemented UI.

## Surface and behavior

Design Month, Week, and Agenda views of existing task deadlines, with Today, previous/next range, timezone, collection filters, and an unscheduled drawer. Keep core Now/Later/Unclassified navigation; Calendar is an additional destination available through profile navigation and command palette. Select an entry to open its existing task page and chat. Mobile defaults to Agenda.

## States and interaction coverage

Show all-day dates separately from timed deadline markers, busy and empty dates, long titles, overdue/completed distinctions, loading/error, filtered-empty, and timezone labels. Prototype drag rescheduling with a preview of affected reminders and a keyboard-accessible Change date alternative. No invented meeting durations or external-event synchronization. Include document/chat navigation and return to the same calendar range.

## Handoff

Use Maya and the shared fictional task dataset. Annotate date/time/timezone explicitly in prototypes so relative labels can be evaluated. Provide desktop and mobile frames, focus order, escape/return-focus behavior, validation messages, and persistence boundaries. Reuse all four themes with Light/Dark tokens, retaining calm task-focused hierarchy. Include a keyboard-only prototype path and menu shortcut hints sourced from the shared command registry. Dates and notifications are optional; no calendar connection, AI call, payment, or automatic invitation is required.
