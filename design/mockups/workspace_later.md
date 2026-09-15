# Later — parked intentions

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design Later as the same familiar inbox layout with a quieter collection identity, not a separate dashboard. Sample rows: “Plan a quiet weekend,” “Try the pottery class,” and “Reorganize the photo shelf.” Optional document previews may appear, but avoid aging badges, guilt copy, or overdue styling just because tasks have been here a while.

Primary interactions: add directly to Later, select and work on a task, drag to Now, or choose Move to Now from its menu. Later tasks remain chattable and editable; placing a task here does not disable the agent. Document and conversation stay attached when moved.

Show populated and empty states, a selected task with chat collapsed, keyboard Move to menu, and dragging a row over the Now rail target. Highlight the destination with text and shape as well as color. On successful move, remove the row and show a small Undo message; if the selected task remains open, show its updated collection in the header so users are not disoriented.

Show failed move reverting the list position with retry. Avoid silently losing selection or scroll. A sparse empty state might say “A place for things you can come back to.” Do not imply Later items auto-resurface or receive reminders that are not implemented.

Include mobile movement through the menu and a desktop comparison matching the Now shell.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Keyboard coverage

Follow the shared [keyboard map](../../docs/notes/files/13_keyboard_shortcuts.md). Show applicable menu hints, visible focus, next/previous task behavior, Page/Chat focus switching, and search entry. Navigation shortcuts must not activate while the user types. Include keyboard-only operation in the prototype and preserve drafts when focus/tasks change.

## Deadlines and notification integration

Follow [task scheduling](task_schedule.md), [calendar](calendar.md), and [notifications](notifications.md). Offer optional deadline/reminder actions through the task menu and command palette, show compact due labels where relevant, and retain list placement when dates change. Completion/archive suppresses pending reminders; restoring does not replay old alerts. Profile navigation exposes Calendar and Settings → Notifications. Avoid mandatory date fields or automatic urgency sorting.
