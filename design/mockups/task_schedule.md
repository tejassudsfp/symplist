# Task deadline and reminder editor

Read [overall.md](overall.md), [themes.md](themes.md), and the [scheduling specification](../../docs/notes/files/15_deadlines_reminders_calendar.md). Produce high-fidelity screens and connected interactions; these files are design prompts, not implemented UI.

## Surface and behavior

Design an optional Deadline chip, task-menu entry, and focused popover on desktop / sheet on mobile. Start with date-only selection; reveal time and timezone only when needed. Include clear deadline, accessible date input, calendar picker, exact-time toggle, and reminders with channel choices and add/remove actions. Show the exact resolved delivery time, quiet-hours adjustment, and explicit Save/Cancel. A reminder can exist without a deadline.

## States and interaction coverage

Cover unscheduled, date-only, timed, multiple reminders, standalone reminder, DST ambiguity, invalid past reminder, quiet-hours deferral, concurrent edit, saving/failure, and deadline removal affecting relative reminders. Demonstrate every action by keyboard without stealing editor shortcuts. Saving must preserve task identity and collection. Show a subtle due chip in lists and page; avoid compulsory urgency decoration.

## Handoff

Use Maya and the shared fictional task dataset. Annotate date/time/timezone explicitly in prototypes so relative labels can be evaluated. Provide desktop and mobile frames, focus order, escape/return-focus behavior, validation messages, and persistence boundaries. Reuse all four themes with Light/Dark tokens, retaining calm task-focused hierarchy. Include a keyboard-only prototype path and menu shortcut hints sourced from the shared command registry. Dates and notifications are optional; no calendar connection, AI call, payment, or automatic invitation is required.
