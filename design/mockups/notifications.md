# Notification center

Read [overall.md](overall.md), [themes.md](themes.md), and the [scheduling specification](../../docs/notes/files/15_deadlines_reminders_calendar.md). Produce high-fidelity screens and connected interactions; these files are design prompts, not implemented UI.

## Surface and behavior

Design a restrained notification control in the top bar with an accessible unread count and panel, expanding to a full mobile surface. Preserve profile and Vault placement. Entries group by date and identify task, reminder time, and deadline. Actions are Open task, Snooze, Mark complete, Mark read, and Dismiss; clearly distinguish reading from completing.

## States and interaction coverage

Cover unread/read, empty, loading/error, offline/reconnect, quiet-hours muted state, missed reminders collapsed per task, expired/deleted task, and revoked access. Snooze previews a future time without moving the deadline. No stale-toast burst or guilt-driven badges. A reminder must still be available after the browser was closed. Keyboard focus returns to the notification entry when an action dialog closes.

## Handoff

Use Maya and the shared fictional task dataset. Annotate date/time/timezone explicitly in prototypes so relative labels can be evaluated. Provide desktop and mobile frames, focus order, escape/return-focus behavior, validation messages, and persistence boundaries. Reuse all four themes with Light/Dark tokens, retaining calm task-focused hierarchy. Include a keyboard-only prototype path and menu shortcut hints sourced from the shared command registry. Dates and notifications are optional; no calendar connection, AI call, payment, or automatic invitation is required.
