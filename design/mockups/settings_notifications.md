# Notification settings

Read [overall.md](overall.md), [themes.md](themes.md), and the [scheduling specification](../../docs/notes/files/15_deadlines_reminders_calendar.md). Produce high-fidelity screens and connected interactions; these files are design prompts, not implemented UI.

## Surface and behavior

Design timezone selection, default reminder time, in-app/email channel preferences, quiet-hours start/end and enable toggle, and email title-preview preference. Show a compact preview of the next delivery under these settings. Explain that existing deadlines retain their timezone. Place Notifications alongside Account, Appearance, and Keyboard shortcuts.

## States and interaction coverage

Cover timezone search, overnight quiet hours, generic versus title-bearing email previews, save success/failure, disabled server email, bounced address, and all-reminders disabled. Explain reminder email preferences do not disable login or vault-security emails. No browser-push permission or billing controls. Include Light/Dark examples in each theme via reusable tokens; keyboard and screen-reader labels must remain consistent.

## Handoff

Use Maya and the shared fictional task dataset. Annotate date/time/timezone explicitly in prototypes so relative labels can be evaluated. Provide desktop and mobile frames, focus order, escape/return-focus behavior, validation messages, and persistence boundaries. Reuse all four themes with Light/Dark tokens, retaining calm task-focused hierarchy. Include a keyboard-only prototype path and menu shortcut hints sourced from the shared command registry. Dates and notifications are optional; no calendar connection, AI call, payment, or automatic invitation is required.
